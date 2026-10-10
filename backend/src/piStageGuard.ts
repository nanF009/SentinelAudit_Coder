/**
 * piStageGuard —— Pi Agent 阶段生命周期守卫（P0 修复）
 *
 * 解决的问题：
 *  1. runPiStage 的 Promise 只由子进程 close/error 结算，子进程不 close 即永久挂起；
 *  2. 强制唤醒兜底只注册给 main 通道，codeverify/remoteverify/subagent 没有逃生口；
 *  3. 存活探针只读 running，看不到 multi 的 verifyProcs，回收器把活进程误判为僵尸；
 *  4. 旧 killTree 使用无 timeout 的同步 pkill 调用，且不等待、不确认是否真的停止；
 *  5. 迟到写入：被取代的旧实例仍可把结果写进正常结果目录。
 *  6. M1：`agent_end` 只代表"本 run 不再有循环事件"，**不**代表仍在执行的工具已结束
 *     （Pi 的 bash 工具自身 detached，`docker compose build` 可能在另一个进程组里继续跑）；
 *     旧逻辑会在 agent_end 后 2 分钟静默即收尾，把前台长时构建一起杀掉。
 *     现在用"未闭合工具调用"门控 settle 与 idle（hard 上限不变、不可延长）。
 *
 * 本模块只做纯逻辑与状态机，不 import runner.ts / db.ts，因此可独立单测。
 * 所有进程终止均通过 Terminator 异步发起，绝不使用任何同步终止调用。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

/* ============================== 常量 ============================== */

/** 首轮终止（SIGTERM / taskkill）后的等待上限（毫秒）。 */
export const TERM_GRACE_MS = 5_000;
/** 升级信号（SIGKILL）后的等待上限（毫秒）。 */
export const KILL_GRACE_MS = 5_000;
/** residualRisks 的追踪时长上限（毫秒）。 */
export const RESIDUAL_TTL_MS = 30 * 60_000;
/** blockingStops 的最大复查次数（耗尽后保留记录但不再重试）。 */
export const MAX_STOP_ATTEMPTS = 3;
/** 停止探针的轮询间隔（毫秒）。 */
export const PROBE_INTERVAL_MS = 100;
/** stdout 高频时 idle/settle 定时器的最小重建间隔（避免定时器抖动）。 */
const TIMER_REARM_MIN_MS = 1_000;

/* ============================== 基础类型 ============================== */

/** 子进程启动阶段：区分同步 spawn throw / 异步 spawn error / 已启动。 */
export type SpawnPhase = 'sync_throw' | 'async_error' | 'started';

/** 阶段终态。 */
export type StageTerminal =
  | 'closed'
  | 'spawn_error'
  | 'process_error'
  | 'hard_timeout'
  | 'idle_timeout'
  | 'settle_grace'
  | 'cancelled';

/**
 * 停止状态。
 *  - not_requested  未发起终止（正常退出），无需确认；
 *  - stopped        进程组（可权威判定的整棵树）已确认停止；
 *  - stopped_direct 直接子进程已停止，但后代无法权威确认；
 *  - alive          仍有进程存活；
 *  - unknown        无法判定（平台不支持 / 探测失败）。
 */
export type StopState = 'not_requested' | 'stopped' | 'stopped_direct' | 'alive' | 'unknown';

/** 输出完整性：区分"有输出"与"输出可进入下游"。 */
export type OutputKind = 'none' | 'partial' | 'complete';

export type StageChannel = 'main' | 'env' | 'codeverify' | 'remoteverify' | 'subagent';

export type StopReason =
  | 'timeout_hard'
  | 'timeout_idle'
  | 'settle_grace'
  | 'cancel'
  | 'user'
  | 'reaper'
  | 'runner_exit';

/** 阶段的纯事实（不含项目态，可独立判定）。 */
export interface StageFacts {
  terminal: StageTerminal;
  spawnPhase: SpawnPhase;
  started: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stopRequested: boolean;
  stopState: StopState;
  outputKind: OutputKind;
  note: string;
}

/** 业务侧事实（由调用方显式传入，纯函数绝不读库）。 */
export interface ProjectFacts {
  projectId: string;
  status: 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  verifyStatus: 'none' | 'queued' | 'running' | 'success' | 'failed' | 'failed_partial';
  /** 本次是否属于"可自动恢复"的任务类型（由调用方声明）。 */
  autoRepairCandidate: boolean;
  /** 自本阶段启动以来产物集是否发生变化。 */
  artifactsChangedSince: boolean;
  /** 是否已存在用户排队的重跑请求。 */
  restartPending: boolean;
}

export interface StageDecision {
  /** 结果可采信（可进入下游输入）。与 stopState 解耦。 */
  acceptResult: boolean;
  /** 允许业务流程继续推进。 */
  proceed: boolean;
  /** 仅"阶段维度"是否具备自动重跑资格（还需 decideAutoRepair 叠加项目态）。 */
  autoRepairEligible: boolean;
  reason: string;
}

export type SubmitAction = 'commit' | 'diagnose' | 'discard';

export interface SubmitDecision {
  action: SubmitAction;
  quality: OutputKind;
  reason: string;
}

/* ============================== 纯判定函数 ============================== */

function stopGate(state: StopState): { proceed: boolean; autoRepair: boolean; note: string } {
  switch (state) {
    case 'not_requested':
      return { proceed: true, autoRepair: true, note: '' };
    case 'stopped':
      return { proceed: true, autoRepair: true, note: '' };
    case 'stopped_direct':
      return { proceed: true, autoRepair: false, note: '（直接子进程已停止，后代未确认）' };
    case 'alive':
      return { proceed: false, autoRepair: false, note: '（进程仍在运行）' };
    default:
      return { proceed: false, autoRepair: false, note: '（停止未确认）' };
  }
}

/**
 * 纯阶段判定：只吃 StageFacts，不读全局、不读数据库。
 *
 * acceptResult 与 stopState 完全解耦 —— 正常任务不会因为 stopConfirmed=false 而被丢弃结果。
 * proceed 才受 stopState 闸门约束（alive/unknown 阻断下游推进）。
 */
export function decideStage(f: StageFacts): StageDecision {
  const gate = stopGate(f.stopState);
  let accept = false;
  let proceed = false;
  let auto = false;
  let reason = '';

  switch (f.terminal) {
    case 'closed':
      if (f.exitCode === 0 && f.exitSignal === null) {
        accept = true;
        proceed = true;
        auto = true;
        reason = '正常退出';
      } else {
        accept = false;
        proceed = true;
        // 非零退出可维持既有编排行为，但不得被自动重跑条件放行。
        auto = false;
        reason = f.exitSignal ? `被信号 ${f.exitSignal} 终止` : `非零退出（code=${f.exitCode ?? '?'}）`;
      }
      break;
    case 'spawn_error':
      accept = false;
      proceed = false;
      auto = false;
      reason =
        f.spawnPhase === 'async_error'
          ? 'Pi 启动失败（异步 spawn error）'
          : 'Pi 启动失败（同步 spawn 异常）';
      break;
    case 'process_error':
      accept = f.outputKind === 'complete';
      proceed = true;
      auto = false;
      reason = '已启动后子进程报错';
      break;
    case 'hard_timeout':
      accept = f.outputKind === 'complete';
      proceed = true;
      auto = false;
      reason = '运行超过硬上限';
      break;
    case 'idle_timeout':
      accept = f.outputKind === 'complete';
      proceed = true;
      auto = false;
      reason = '连续无输出（疑似卡死）';
      break;
    case 'settle_grace':
      accept = true;
      proceed = true;
      auto = true;
      reason = '会话已结束，主动收尾';
      break;
    case 'cancelled':
      accept = false;
      proceed = false;
      auto = false;
      reason = '已取消';
      break;
    default:
      reason = '未知终态';
      break;
  }

  return {
    acceptResult: accept,
    proceed: proceed && gate.proceed,
    autoRepairEligible: auto && gate.autoRepair,
    reason: gate.note ? `${reason}${gate.note}` : reason,
  };
}

/**
 * 业务可恢复条件（不含阶段维度）：供只掌握项目态的场景（如僵尸回收器）复用。
 * 调用方还必须叠加进程安全条件（!hasBlockingStop && !hasLiveStage）。
 */
export function projectRecoverable(p: ProjectFacts): boolean {
  if (!p.autoRepairCandidate) return false;
  if (p.status !== 'paused' && p.status !== 'running') return false;
  if (p.verifyStatus === 'failed') return false;
  if (p.artifactsChangedSince) return false;
  if (p.restartPending) return false;
  return true;
}

/**
 * 自动恢复判定：在阶段判定之上叠加项目态。必须同时满足"进程安全"与"业务可恢复"，
 * 不允许仅凭"已确认停止"就拉起另一条流水线。
 */
export function decideAutoRepair(f: StageFacts, p: ProjectFacts): boolean {
  if (!decideStage(f).autoRepairEligible) return false;
  if (f.stopState !== 'not_requested' && f.stopState !== 'stopped') return false;
  return projectRecoverable(p);
}

/**
 * legacy 兼容映射：供现有 30+ 处 r.killed / r.timedOut 判断继续工作。
 *
 * 关键：killed 由 decideStage().proceed 驱动，因此 alive/unknown 会被映射成
 * killed=true，从而让所有既有 "if (r.killed) return" 调用点自动中止危险后续阶段。
 * 事件文案由 reasons 区分，spawn_error 不会被伪装成"用户取消"。
 */
export function legacyKilledTimedOut(f: StageFacts): { killed: boolean; timedOut: boolean } {
  const d = decideStage(f);
  return {
    killed: f.terminal === 'cancelled' || d.proceed === false,
    timedOut: f.terminal === 'hard_timeout' || f.terminal === 'idle_timeout',
  };
}

/**
 * 结果提交策略：区分"有输出"与"输出可进入下游"。
 *  commit   → 写入正常结果目录（可进入 regrade 等下游输入）
 *  diagnose → 只写入诊断目录（供排障，不进下游）
 *  discard  → 不写盘
 */
export function decideSubmit(f: StageFacts): SubmitDecision {
  switch (f.terminal) {
    case 'spawn_error':
      return { action: 'discard', quality: 'none', reason: '启动失败，无有效输出' };
    case 'cancelled':
      return { action: 'discard', quality: 'none', reason: '阶段已取消' };
    case 'closed':
      if (f.exitCode === 0 && f.exitSignal === null && f.outputKind === 'complete') {
        return { action: 'commit', quality: 'complete', reason: '正常零退出且输出完整' };
      }
      if (f.exitCode === 0 && f.exitSignal === null) {
        return { action: 'diagnose', quality: f.outputKind, reason: '零退出但输出不完整，仅作诊断' };
      }
      // 非零退出/信号终止：保留编排行为，但输出**不得**作为有效漏洞结果。
      return {
        action: 'diagnose',
        quality: f.outputKind,
        reason: '非零退出或信号终止，仅作诊断，不作为有效漏洞结果',
      };
    case 'settle_grace':
      if (f.outputKind !== 'complete') {
        return { action: 'diagnose', quality: f.outputKind, reason: '主动收尾但输出不完整，仅作诊断' };
      }
      if (f.stopState === 'alive' || f.stopState === 'unknown') {
        return { action: 'diagnose', quality: 'complete', reason: '停止未确认，降级为诊断' };
      }
      return { action: 'commit', quality: 'complete', reason: '主动收尾且输出完整' };
    case 'process_error':
    case 'hard_timeout':
    case 'idle_timeout':
      return { action: 'diagnose', quality: f.outputKind, reason: '异常/超时中止，仅作诊断' };
    default:
      return { action: 'discard', quality: 'none', reason: '未知终态' };
  }
}

/* ============================== 阶段完成度（部分完成语义） ============================== */

/**
 * 审计后处理流水线的**权威收尾标记** —— 即 runner.lastAuditPipelineDoneTs 的判定依据。
 * 每个标记都代表"该阶段真正跑完了**全部预期组**"。
 *
 * ⚠ 不变式：`buildPartialCompletionText()` 生成的"部分完成"文案必须与这里**任何一个**
 * 标记都不构成子串包含关系，否则部分完成会被 `lastAuditPipelineDoneTs` 误判为完整阶段结束。
 * 该不变式由 piStageGuard.test.ts 显式断言。
 */
export const AUDIT_PIPELINE_DONE_MARKERS = [
  '✓ 实战二次评级完成',
  '✓ 已合并二次评级到代码级验证',
  '✓ 代码级验证完成',
] as const;

/**
 * 续跑定位锚点 —— runner.inferResumeAuditStage 的判定依据
 * （权威收尾标记之外还包含去重完成标记）。
 *
 * ⚠ 这是**全部**"阶段完成"标记的并集；`buildPartialCompletionText()` 的输出
 * 必须与其中任何一个都不构成子串包含关系。
 */
export const RESUME_ANCHOR_MARKERS = [...AUDIT_PIPELINE_DONE_MARKERS, '✓ AI 智能去重完成'] as const;

/** 分组阶段的组级完成度（由调用方按实际提交结果汇总，纯数据）。 */
export interface GroupOutcomeCounts {
  /** 预期组数（本轮全部分组）。 */
  groupsTotal: number;
  /** 正常提交（写入正常结果目录、可进入下游）的组数。 */
  committed: number;
  /** 仅落诊断目录的组数（超时 / 异常 / 输出不完整）。 */
  diagnosed: number;
  /** 未落盘的组数（启动失败 / 被取消 / 提交令牌失效）。 */
  discarded: number;
  /** 阶段被取消或以其他方式中止。 */
  killed?: boolean;
  /** 阶段因"停止未确认"提前中止（后续组未执行）。 */
  aborted?: boolean;
}

export interface StageCompletionVerdict {
  /** 全部预期组都正常完成（且阶段未被中止）→ 才可发权威"阶段完成"标记。 */
  complete: boolean;
  /** 只完成了一部分（含"零组完成"与"中止"）。 */
  partial: boolean;
}

function nonNegInt(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 阶段完成度判定：**只有全部预期组都正常提交、且阶段未被中止**才算"完整完成"。
 * 组数为 0 不算完整 —— 避免"没有分组"被当成"全部分组成功"。
 * 严格判据用 `committed >= groupsTotal`：诊断/未产出的组一律使阶段降级为"部分完成"。
 */
export function judgeStageCompletion(c: GroupOutcomeCounts): StageCompletionVerdict {
  const total = nonNegInt(c.groupsTotal);
  const committed = nonNegInt(c.committed);
  const complete = !c.killed && !c.aborted && total > 0 && committed >= total;
  return { complete, partial: !complete };
}

/**
 * 「部分完成」事件文案：明确给出正常完成数 / 预期组数 / 失败或诊断组数。
 *
 * 文案刻意采用 `⚠ <阶段名>部分完成：` 形态 —— 与 {@link RESUME_ANCHOR_MARKERS} 中
 * 任何一个标记都不构成子串包含关系（既无 `✓`，也在"完成"前插入了"部分"），
 * 因此不会被 lastAuditPipelineDoneTs / inferResumeAuditStage 误判为完整阶段结束。
 */
export function buildPartialCompletionText(label: string, c: GroupOutcomeCounts): string {
  const total = nonNegInt(c.groupsTotal);
  const committed = nonNegInt(c.committed);
  const diagnosed = nonNegInt(c.diagnosed);
  const discarded = nonNegInt(c.discarded);
  const notRun = Math.max(0, total - committed - diagnosed - discarded);
  const parts = [`正常完成 ${committed}/${total} 组`];
  if (diagnosed > 0) parts.push(`异常/输出不完整 ${diagnosed} 组`);
  if (discarded > 0) parts.push(`未产出 ${discarded} 组`);
  if (notRun > 0) parts.push(`未执行 ${notRun} 组`);
  if (c.aborted) parts.push('已中止后续组');
  if (c.killed) parts.push('阶段被中止');
  return `⚠ ${label}部分完成：${parts.join('，')}；未完成组的输出只留在诊断目录，下游仅采用正常完成组的结果`;
}

/** 诊断目录必须与正常结果目录物理隔离，否则下游聚合会把未完成输出当成有效结果。 */
export function isDiagnosticsDirSeparated(resDir: string, diagDir: string): boolean {
  const norm = (p: string) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const r = norm(resDir);
  const d = norm(diagDir);
  return !!r && !!d && d !== r && !d.startsWith(`${r}/`);
}

/* ============================== 启动失败原因（非敏感化） ============================== */

/**
 * 把底层 spawn 错误原因整理成可展示的**非敏感**单行文本：
 *  - 折叠空白/换行，去掉与固定前缀重复的部分（避免"Pi 启动失败：无法启动 Pi：…"）；
 *  - 截断超长内容；
 *  - 绝不改写为"用户取消"。
 */
export function normalizeSpawnErrorReason(raw: unknown): string {
  let s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 2; i++) {
    s = s.replace(/^(?:无法启动 Pi|Pi 启动失败|启动失败|spawn failed|spawn error)\s*[:：]\s*/i, '');
  }
  if (!s) return '未知原因';
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/* ============================== 子进程与终结器 ============================== */

/** 最小子进程接口：可直接用 EventEmitter 假对象替代。 */
export interface GuardChild {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  killed?: boolean;
  on(ev: 'close' | 'error', cb: (...args: any[]) => void): unknown;
  removeListener(ev: 'close' | 'error', cb: (...args: any[]) => void): unknown;
  kill(sig?: NodeJS.Signals): boolean;
}

export interface Terminator {
  readonly platform: 'linux' | 'win32' | 'other';
  /** 能否权威确认"整棵进程树"已停止（需要 Linux + 已验证的独立进程组）。 */
  readonly canConfirmTree: boolean;
  /** 首轮终止（Linux: SIGTERM 到进程组；Windows: taskkill /T，异步且带超时）。 */
  request(child: GuardChild | null, pgid: number | null): void;
  /** 升级终止（Linux: SIGKILL 到进程组；Windows: taskkill /T /F）。 */
  escalate(child: GuardChild | null, pgid: number | null): void;
  /** 同步探测当前停止状态。 */
  probe(child: GuardChild | null, pgid: number | null): StopState;
  /** 在 maxWaitMs 内轮询，一旦确认停止立即返回。 */
  waitStopped(child: GuardChild | null, pgid: number | null, maxWaitMs: number): Promise<StopState>;
}

/**
 * 有界等待（**不** unref）。
 * 停止确认必须真正跑完：若用 unref，事件循环空闲时进程会直接退出、
 * 把"终止/确认"逻辑丢在半路。所有调用点的等待时长都有硬上限（≤5s / ≤11s），
 * 因此不会无限推迟进程退出。
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function nowMs(): number {
  const perf = (globalThis as any).performance;
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}

/**
 * 校验 pid 是否真的是进程组组长（pgrp === pid）。
 * 只有为真时才能用 process.kill(-pgid) 权威判定整组；
 * 否则 PGID 不可信，必须退化为"直接子进程"判定，避免误报 stopped。
 */
function isProcessGroupLeader(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return false;
    const fields = stat.slice(close + 2).split(' ');
    const pgrp = Number(fields[2]); // 第 5 个字段
    return Number.isFinite(pgrp) && pgrp === pid;
  } catch {
    return false;
  }
}

/**
 * 把 pid 解析为可用于 process.kill(-pgid) 的进程组 ID。
 * 仅当该 pid 确实是进程组组长（Linux + detached 生效）时返回 pid，否则返回 null
 * —— 避免把不存在的进程组误判为"已停止"。
 */
export function resolveProcessGroupId(pid: number | null | undefined): number | null {
  if (typeof pid !== 'number' || pid <= 0) return null;
  if (process.platform !== 'linux') return null;
  return isProcessGroupLeader(pid) ? pid : null;
}

/** 进程组探测：ESRCH → 组内已无成员（权威停止）；EPERM → 仍有成员但无权限（存活）。 */
function probeGroup(pgid: number): StopState {  try {
    process.kill(-pgid, 0);
    return 'alive';
  } catch (err: any) {
    if (err && err.code === 'ESRCH') return 'stopped';
    if (err && err.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* ESRCH：已无成员；EPERM：无权限 */
  }
}

/** 直接子进程状态（跨平台可用）。 */
function directState(child: GuardChild | null): 'gone' | 'alive' | 'unknown' {
  if (!child) return 'gone';
  if (child.exitCode !== null && child.exitCode !== undefined) return 'gone';
  if (child.signalCode) return 'gone';
  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0) return 'gone';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err: any) {
    if (err && err.code === 'ESRCH') return 'gone';
    if (err && err.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/** 异步执行 taskkill 并设置超时；绝不同步等待，也不以退出码宣称整树已停。 */
function spawnTaskkill(args: string[], timeoutMs: number): void {
  let p: ReturnType<typeof spawn>;
  try {
    p = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  timer.unref?.();
  const done = (): void => clearTimeout(timer);
  p.once('close', done);
  p.once('error', done);
}

export function createTerminator(): Terminator {
  const platform: Terminator['platform'] =
    process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'win32' : 'other';

  const api: Terminator = {
    platform,
    // 仅 Linux（且需 PGID 经校验）能权威确认整棵树。
    canConfirmTree: platform === 'linux',

    request(child: GuardChild | null, pgid: number | null): void {
      if (platform === 'win32') {
        if (child?.pid) spawnTaskkill(['/PID', String(child.pid), '/T'], TERM_GRACE_MS);
        return;
      }
      if (platform === 'linux' && pgid != null && pgid > 0) {
        killGroup(pgid, 'SIGTERM');
        return;
      }
      try {
        child?.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    },

    escalate(child: GuardChild | null, pgid: number | null): void {
      if (platform === 'win32') {
        if (child?.pid) spawnTaskkill(['/PID', String(child.pid), '/T', '/F'], KILL_GRACE_MS);
        return;
      }
      if (platform === 'linux' && pgid != null && pgid > 0) {
        killGroup(pgid, 'SIGKILL');
        return;
      }
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    },

    probe(child: GuardChild | null, pgid: number | null): StopState {
      if (!child) return 'not_requested';
      if (platform === 'linux' && pgid != null && pgid > 0) return probeGroup(pgid);
      const d = directState(child);
      if (d === 'gone') return 'stopped_direct';
      if (d === 'alive') return 'alive';
      return 'unknown';
    },

    async waitStopped(
      child: GuardChild | null,
      pgid: number | null,
      maxWaitMs: number
    ): Promise<StopState> {
      if (!child) return 'not_requested';
      const deadline = nowMs() + Math.max(0, maxWaitMs);
      for (;;) {
        const st = api.probe(child, pgid);
        if (st === 'stopped' || st === 'stopped_direct') return st;
        const remain = deadline - nowMs();
        if (remain <= 0) return st;
        await sleep(Math.min(PROBE_INTERVAL_MS, remain));
      }
    },
  };

  return api;
}

/* ============================== 阶段 guard ============================== */

export interface StageOutputBuffer {
  structured: any;
  finalResult: string;
  stderrTail: string;
}

export interface GuardChildHooks {
  /** 子进程 close（在 guard 自身记账之前调用，便于调用方先抽干 stdout）。 */
  onClose?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** 子进程 error。 */
  onError?: (err: Error) => void;
}

export interface StageResult {
  killed: boolean;
  timedOut: boolean;
  code: number | null;
  structured: any;
  finalResult: string;
  stderrTail: string;
}

export interface GuardResult extends StageResult {
  runId: string;
  channel: StageChannel;
  facts: StageFacts;
  decision: StageDecision;
  /**
   * 「整棵树已停止」是否**可权威确认**。
   *
   * ⚠ 只在**没有未闭合工具调用**时成立：Pi 的 bash 工具自身就是 detached 的
   * （`docker compose build` 在**另一个进程组**），因此进程组终止打不到它，
   * `stopState === 'stopped'`（Pi 自身组已空）**不能**证明这些后代已停止。
   * 终止时若仍有未闭合工具调用，这里为 false —— 不得据此断言 detached 后代全部停止。
   */
  stopConfirmed: boolean;
  /**
   * 结算瞬间仍未闭合（未收到 `tool_execution_end`）的工具调用数。
   * > 0 表示终止范围有残余风险：Pi 收到 SIGTERM 后会自行 SIGKILL 其 tracked detached 子进程，
   * 但平台侧无法权威确认它们已退出（需人工/后续探测确认）。
   */
  openToolCallsAtSettle: number;
}

export interface StageGuardInput {
  projectId: string;
  runId: string;
  channel: StageChannel;
  terminator: Terminator;
  hardMs: number;
  idleMs: number;
  settleMs: number;
  termGraceMs?: number;
  killGraceMs?: number;
  /** 输出完整性判定（由调用方注入，guard 保持通用）。 */
  parseComplete?: (structured: any, finalResult: string) => boolean;
  /** 诊断事件落库。 */
  onEvent: (kind: 'system' | 'error', text: string) => void;
  /** 是否已被外部要求中止（cancelledProjects / verifyKilled / …）。 */
  isCancelled?: () => boolean;
  /** 阶段输出缓冲（由调用方持有并填充）。 */
  getOutput: () => StageOutputBuffer;
  now?: () => number;
}

export interface StageGuard {
  readonly projectId: string;
  readonly runId: string;
  readonly channel: StageChannel;
  readonly settled: boolean;
  readonly result: GuardResult | null;
  readonly done: Promise<GuardResult>;
  /** spawn() 同步抛异常。 */
  markSpawnFailed(message: string): void;
  /** spawn 成功：绑定子进程、注册 guard 自己的监听器、启动计时器。 */
  markSpawned(child: GuardChild, hooks?: GuardChildHooks): void;
  /** 阶段在 spawn 之前即被判定跳过（取消 / Pi 停摆）。 */
  skipBeforeSpawn(terminal: StageTerminal, message: string): void;
  noteStdout(): void;
  noteStderr(): void;
  /**
   * M1：工具调用生命周期门控（由调用方在解析 `tool_execution_start` / `tool_execution_end` 之后调用，
   * 传入**当前未闭合工具调用数**；集合本身由调用方按 runId 维护）。
   *
   * 语义：
   *  - `openCount > 0`：**推迟** settle 收尾（会话结束信号不再起算宽限），并抑制 idle 误杀；
   *  - `openCount === 0`：若此前已收到会话结束信号，**恢复**正常的 settle grace；
   *  - hard deadline **不受影响**（仍是不可延长的绝对上限）。
   */
  noteToolCalls(openCount: number): void;
  noteSessionEnd(): void;
  requestStop(reason: StopReason): void;
  forceSettle(reason: StopReason): Promise<GuardResult>;
  snapshot(): StageFacts | null;
}

/* ---------- 运行实例登记（存活探针 + 精确注销） ---------- */

export interface RegistryEntry {
  projectId: string;
  runId: string;
  channel: StageChannel;
  startedAt: number;
  child: GuardChild | null;
  pgid: number | null;
  settled: boolean;
}

const stageRegistry = new Map<string, { entry: RegistryEntry; guard: StageGuard }>();
const activeByProject = new Map<string, Set<string>>();

export function registryKey(projectId: string, runId: string): string {
  return `${projectId}#${runId}`;
}

function registerStage(entry: RegistryEntry, guard: StageGuard): void {
  stageRegistry.set(registryKey(entry.projectId, entry.runId), { entry, guard });
  let set = activeByProject.get(entry.projectId);
  if (!set) {
    set = new Set<string>();
    activeByProject.set(entry.projectId, set);
  }
  set.add(entry.runId);
}

function unregisterStage(projectId: string, runId: string): void {
  stageRegistry.delete(registryKey(projectId, runId));
  const set = activeByProject.get(projectId);
  if (set) {
    set.delete(runId);
    if (set.size === 0) activeByProject.delete(projectId);
  }
}

/** 该项目仍未结算的 runId 列表（供 finally 精确清理）。 */
export function activeRunIds(projectId: string): string[] {
  const set = activeByProject.get(projectId);
  return set ? [...set] : [];
}

/**
 * 该项目是否有任何仍未结算的阶段实例。
 *
 * 语义取"未结算即视为在途"：阶段实例的结算是有界的（终止流程自带上限），
 * 因此未结算就代表该阶段尚未结束，此时不应让回收器把它当作僵尸来强摘槽位。
 */
export function hasLiveStage(projectId: string): boolean {
  for (const { entry } of stageRegistry.values()) {
    if (entry.projectId !== projectId) continue;
    if (!entry.settled) return true;
  }
  return false;
}

/** 强制结算某项目下全部未结算实例（runJob.finally / 回收器）。 */
export function forceSettleProject(projectId: string, reason: StopReason): number {
  let n = 0;
  for (const runId of activeRunIds(projectId)) {
    const rec = stageRegistry.get(registryKey(projectId, runId));
    if (!rec || rec.entry.settled) continue;
    n += 1;
    void rec.guard.forceSettle(reason);
  }
  return n;
}

/**
 * 强制结算并等待收尾（有界）。
 * 用于 runJob.finally：必须在放行下一次启动之前确认旧实例已结算，
 * 避免"同一项目新旧流水线并行"。单实例终止流程自带 TERM+KILL 上限，故总耗时有界。
 */
export async function forceSettleProjectAndWait(
  projectId: string,
  reason: StopReason,
  maxWaitMs = TERM_GRACE_MS + KILL_GRACE_MS + 1_000
): Promise<{ forced: number; remaining: number }> {
  const forced = forceSettleProject(projectId, reason);
  const deadline = nowMs() + Math.max(0, maxWaitMs);
  while (activeRunIds(projectId).length > 0 && nowMs() < deadline) {
    await sleep(50);
  }
  return { forced, remaining: activeRunIds(projectId).length };
}

/* ---------- 阻断型 / 追踪型停止记录 ---------- */

export interface StopRecord {
  projectId: string;
  runId: string;
  channel: StageChannel;
  pid: number | null;
  pgid: number | null;
  child: GuardChild | null;
  terminator: Terminator;
  platform: Terminator['platform'];
  canConfirmTree: boolean;
  terminal: StageTerminal;
  stopState: StopState;
  createdAt: number;
  lastAttemptAt: number;
  attempts: number;
  exhausted: boolean;
}

/** blockingStops：alive/unknown —— 阻断同项目新流水线、自动重跑与用户重跑。 */
const blockingStops = new Map<string, Map<string, StopRecord>>();
/** residualRisks：stopped_direct —— 不阻断，仅按 TTL 追踪后代风险。 */
const residualRisks = new Map<string, Map<string, StopRecord>>();

function putRecord(store: Map<string, Map<string, StopRecord>>, rec: StopRecord): void {
  let m = store.get(rec.projectId);
  if (!m) {
    m = new Map<string, StopRecord>();
    store.set(rec.projectId, m);
  }
  m.set(rec.runId, rec);
}

function dropRecord(
  store: Map<string, Map<string, StopRecord>>,
  projectId: string,
  runId: string
): void {
  const m = store.get(projectId);
  if (!m) return;
  m.delete(runId);
  if (m.size === 0) store.delete(projectId);
}

export function hasBlockingStop(projectId: string): boolean {
  const m = blockingStops.get(projectId);
  return !!m && m.size > 0;
}

export function blockingStopCount(projectId?: string): number {
  if (projectId) return blockingStops.get(projectId)?.size ?? 0;
  let n = 0;
  for (const m of blockingStops.values()) n += m.size;
  return n;
}

export function residualRiskCount(projectId?: string): number {
  if (projectId) return residualRisks.get(projectId)?.size ?? 0;
  let n = 0;
  for (const m of residualRisks.values()) n += m.size;
  return n;
}

export function listBlockingStops(projectId: string): StopRecord[] {
  return [...(blockingStops.get(projectId)?.values() ?? [])];
}

export interface SweepResult {
  cleared: number;
  downgraded: number;
  abandoned: number;
  pending: number;
}

export interface SweepDeps {
  onEvent: (projectId: string, kind: 'system' | 'error', text: string) => void;
  probeWaitMs?: number;
  residualTtlMs?: number;
  now?: () => number;
}

/**
 * 停止记录复查：由现有 60s tick 调用（不新增定时器）。
 *  - blockingStops：再试终止；确认 stopped → 清理并通知；降级 stopped_direct → 转入 residualRisks；
 *    仍 alive/unknown → 保留（attempts 达上限后保留但不再重试）。
 *  - residualRisks：仅探测；确认 stopped 或超出 TTL → 清理并记录"已停止追踪"。
 */
export async function sweepStops(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now ?? nowMs;
  const wait = deps.probeWaitMs ?? 500;
  const ttl = deps.residualTtlMs ?? RESIDUAL_TTL_MS;
  let cleared = 0;
  let downgraded = 0;
  let abandoned = 0;
  let pending = 0;

  const blockingSnapshot: StopRecord[] = [];
  for (const m of blockingStops.values()) blockingSnapshot.push(...m.values());

  for (const rec of blockingSnapshot) {
    // 先做一次廉价探测：**即使已 exhausted 也必须探测**，
    // 否则一旦重试次数耗尽，进程后来真的退出了记录也永远不会被清理 →
    // 该项目将被永久阻断（直到进程重启），与"确认停止后自动放行"的设计相悖。
    // exhausted 只表示"不再重复发起终止"，不表示"不再观察"。
    const probed = rec.terminator.probe(rec.child, rec.pgid);
    rec.stopState = probed;
    if (probed === 'stopped') {
      dropRecord(blockingStops, rec.projectId, rec.runId);
      cleared += 1;
      deps.onEvent(
        rec.projectId,
        'system',
        `✓ 上一轮残留进程已确认停止（run=${rec.runId}），已解除阻断`
      );
      continue;
    }
    if (probed === 'stopped_direct') {
      dropRecord(blockingStops, rec.projectId, rec.runId);
      rec.lastAttemptAt = now();
      putRecord(residualRisks, rec);
      downgraded += 1;
      deps.onEvent(
        rec.projectId,
        'system',
        `⚠ 上一轮残留进程的直接子进程已停止，但后代未确认（run=${rec.runId}）；已解除阻断并转入追踪`
      );
      continue;
    }
    if (rec.exhausted) {
      pending += 1;
      continue;
    }
    rec.attempts += 1;
    rec.lastAttemptAt = now();
    rec.terminator.request(rec.child, rec.pgid);
    const st = await rec.terminator.waitStopped(rec.child, rec.pgid, wait);
    rec.stopState = st;
    if (st === 'stopped') {
      dropRecord(blockingStops, rec.projectId, rec.runId);
      cleared += 1;
      deps.onEvent(
        rec.projectId,
        'system',
        `✓ 上一轮残留进程已确认停止（run=${rec.runId}），已解除阻断`
      );
      continue;
    }
    if (st === 'stopped_direct') {
      dropRecord(blockingStops, rec.projectId, rec.runId);
      rec.lastAttemptAt = now();
      putRecord(residualRisks, rec);
      downgraded += 1;
      deps.onEvent(
        rec.projectId,
        'system',
        `⚠ 上一轮残留进程的直接子进程已停止，但后代未确认（run=${rec.runId}）；已解除阻断并转入追踪`
      );
      continue;
    }
    if (rec.attempts >= MAX_STOP_ATTEMPTS) {
      rec.exhausted = true;
      deps.onEvent(
        rec.projectId,
        'error',
        `⚠ 上一轮进程停止持续未确认（run=${rec.runId}，已重试 ${rec.attempts} 次）；保持阻断（仍会持续探测，确认停止后自动放行），需人工介入`
      );
    }
    pending += 1;
  }

  const residualSnapshot: StopRecord[] = [];
  for (const m of residualRisks.values()) residualSnapshot.push(...m.values());

  for (const rec of residualSnapshot) {
    const st = rec.terminator.probe(rec.child, rec.pgid);
    if (st === 'stopped') {
      dropRecord(residualRisks, rec.projectId, rec.runId);
      cleared += 1;
      deps.onEvent(rec.projectId, 'system', `✓ 上一轮后代进程已确认停止（run=${rec.runId}），已停止追踪`);
      continue;
    }
    if (now() - rec.lastAttemptAt > ttl) {
      dropRecord(residualRisks, rec.projectId, rec.runId);
      abandoned += 1;
      deps.onEvent(
        rec.projectId,
        'system',
        `⚠ 后代进程在 ${Math.round(ttl / 60000)} 分钟内未能确认停止（run=${rec.runId}），已停止追踪（不阻断）`
      );
    }
  }

  return { cleared, downgraded, abandoned, pending };
}

/* ---------- generation / submit token ---------- */

interface GenerationRec {
  generation: number;
  runId: string;
  startedAt: number;
}

const generations = new Map<string, GenerationRec>();

/** 新一轮运行开始：递增世代，使旧实例的提交令牌全部失效。 */
export function advanceGeneration(projectId: string, runId: string): number {
  const next = (generations.get(projectId)?.generation ?? 0) + 1;
  generations.set(projectId, { generation: next, runId, startedAt: nowMs() });
  return next;
}

export function currentGeneration(projectId: string): number {
  return generations.get(projectId)?.generation ?? 0;
}

export interface SubmitToken {
  projectId: string;
  runId: string;
  generation: number;
}

/** 为某次阶段实例发放提交令牌（沿用当前世代）。 */
export function issueSubmitToken(projectId: string, runId: string): SubmitToken {
  let rec = generations.get(projectId);
  if (!rec) {
    rec = { generation: 1, runId, startedAt: nowMs() };
    generations.set(projectId, rec);
  }
  return { projectId, runId, generation: rec.generation };
}

export function canSubmit(token: SubmitToken | null | undefined): boolean {
  if (!token) return false;
  return generations.get(token.projectId)?.generation === token.generation;
}

export interface CommitGuard {
  readonly token: SubmitToken;
  /** 写入前再次校验（异步步骤之后调用同样安全）。 */
  commit<T>(write: () => T): T | null;
}

/**
 * 提交守卫：若写入过程存在异步步骤，应在异步开始前取守卫，
 * 在最终落盘时调用 commit()（校验发生在落盘那一刻，而不是之前一次）。
 */
export function beginCommit(token: SubmitToken | null | undefined): CommitGuard | null {
  if (!canSubmit(token)) return null;
  const real = token as SubmitToken;
  return {
    token: real,
    commit<T>(write: () => T): T | null {
      if (!canSubmit(real)) return null;
      return write();
    },
  };
}

export function commitResult<T>(token: SubmitToken | null | undefined, write: () => T): T | null {
  const guard = beginCommit(token);
  if (!guard) return null;
  return guard.commit(write);
}

/* ============================== 未闭合工具调用追踪（M1） ============================== */

/** 追踪结果：当前未闭合数与"本次观察是否改变了它"。 */
export interface ToolCallObservation {
  /** 当前未闭合工具调用数。 */
  open: number;
  /** 本次 observe 是否改变集合（只有变化时才需要通知 guard，避免无谓地重置计时器）。 */
  changed: boolean;
}

/**
 * M1：未闭合工具调用追踪器（纯逻辑、无 I/O，可直接单测）。
 *
 * 输入是**已 JSON.parse** 的 Pi json 事件对象（真实结构：
 * `{type:'tool_execution_start'|'tool_execution_end', toolCallId, toolName, args|result, isError}`）。
 * 语义：
 *  - 重复 `start` 同一 id：Set 幂等，不重复计数；
 *  - 重复 / 迟到 `end`（未知 id 或已闭合）：删除是幂等空操作，计数不变；
 *  - `tool_execution_update` 等其它事件：计数不变（`changed=false`）；
 *  - 缺 id 的异常事件用合成 id（`__anon_tool_N`）兜底；`end` 缺 id 时闭掉最早一个合成 id。
 *
 * 每个 `runPiStage` 实例各自创建一个 ⇒ 集合天然**按 runId 隔离**。
 */
export interface OpenToolCallTracker {
  observe(obj: unknown): ToolCallObservation;
  /** 当前未闭合工具调用数。 */
  readonly size: number;
  /** 当前未闭合的工具调用标识（供诊断/日志）。 */
  ids(): string[];
}

const ANON_TOOL_PREFIX = '__anon_tool_';

function toolCallIdOf(obj: any): string | null {
  const raw = obj?.toolCallId ?? obj?.tool_call_id ?? obj?.id;
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

export function createOpenToolCallTracker(): OpenToolCallTracker {
  const open = new Set<string>();
  let anonSeq = 0;
  return {
    observe(obj: unknown): ToolCallObservation {
      const o = obj as any;
      if (!o || typeof o !== 'object') return { open: open.size, changed: false };
      if (o.type === 'tool_execution_start') {
        let id = toolCallIdOf(o);
        if (!id) {
          anonSeq += 1;
          id = `${ANON_TOOL_PREFIX}${anonSeq}`;
        }
        if (open.has(id)) return { open: open.size, changed: false };
        open.add(id);
        return { open: open.size, changed: true };
      }
      if (o.type === 'tool_execution_end') {
        const id = toolCallIdOf(o);
        if (id) {
          if (!open.delete(id)) return { open: open.size, changed: false };
          return { open: open.size, changed: true };
        }
        for (const k of open) {
          if (k.startsWith(ANON_TOOL_PREFIX)) {
            open.delete(k);
            return { open: open.size, changed: true };
          }
        }
        return { open: open.size, changed: false };
      }
      return { open: open.size, changed: false };
    },
    get size(): number {
      return open.size;
    },
    ids(): string[] {
      return [...open];
    },
  };
}

/* ============================== guard 实现 ============================== */

export function createStageGuard(input: StageGuardInput): StageGuard {
  const now = input.now ?? nowMs;
  const terminator = input.terminator;
  const termGraceMs = input.termGraceMs ?? TERM_GRACE_MS;
  const killGraceMs = input.killGraceMs ?? KILL_GRACE_MS;
  const parseComplete =
    input.parseComplete ?? ((s: any, t: string) => s != null || String(t || '').trim() !== '');

  let started = false;
  let spawnPhase: SpawnPhase = 'sync_throw';
  let child: GuardChild | null = null;
  let pgid: number | null = null;
  let hooks: GuardChildHooks = {};

  let terminal: StageTerminal | null = null;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let noteExtra = '';

  let ownClose: ((...a: any[]) => void) | null = null;
  let ownError: ((...a: any[]) => void) | null = null;

  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleArmedAt = 0;
  let settleArmedAt = 0;

  let sessionEnded = false;
  let stopRequested = false;
  let stopFlow: Promise<StopState> | null = null;

  // —— M1：未闭合工具调用门控 ——
  // 集合本身由调用方按 runId 维护（runner 解析 tool_execution_start/end + toolCallId），
  // guard 只持有"当前计数"这一纯事实，用于门控 settle 与 idle。
  let openToolCalls = 0;
  let agentEndDeferredLogged = false;
  let idleSuppressedLogged = false;
  let openToolCallsAtSettle = 0;

  let settled = false;
  let result: GuardResult | null = null;
  let resolveDone: (r: GuardResult) => void = () => {};
  const done = new Promise<GuardResult>((res) => {
    resolveDone = res;
  });

  const entry: RegistryEntry = {
    projectId: input.projectId,
    runId: input.runId,
    channel: input.channel,
    startedAt: now(),
    child: null,
    pgid: null,
    settled: false,
  };

  const clearTimers = (): void => {
    if (hardTimer) clearTimeout(hardTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (settleTimer) clearTimeout(settleTimer);
    hardTimer = null;
    idleTimer = null;
    settleTimer = null;
  };

  /** 只移除 guard 自己注册的监听器（绝不用 removeAllListeners）。 */
  const detachOwnListeners = (): void => {
    if (child) {
      if (ownClose) child.removeListener('close', ownClose);
      if (ownError) child.removeListener('error', ownError);
    }
    ownClose = null;
    ownError = null;
  };

  // 高频 stdout 下避免定时器抖动；阈值不超过预算的一半，保证短预算场景仍能正确续命。
  const rearmThreshold = (budgetMs: number): number =>
    Math.max(1, Math.min(TIMER_REARM_MIN_MS, Math.floor(budgetMs / 2)));

  /** 清掉 settle 计时器（工具调用未闭合时必须无条件撤回收尾倒计时）。 */
  const clearSettle = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  };

  const armIdle = (force = false): void => {
    if (settled || input.idleMs <= 0) return;
    const t = now();
    if (!force && idleTimer && t - idleArmedAt < rearmThreshold(input.idleMs)) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleArmedAt = t;
    idleTimer = setTimeout(() => {
      if (settled || terminal) return;
      // 仍有未闭合工具调用：stdout 静默是**预期内**的（例如前台 docker 构建正在跑），
      // 不得据此判卡死；改为重新武装 idle，等待工具闭合或 hard 上限兜底。
      if (openToolCalls > 0) {
        if (!idleSuppressedLogged) {
          idleSuppressedLogged = true;
          const hardMin = Math.round(input.hardMs / 60_000);
          input.onEvent(
            'system',
            `⏱ 空闲超时已推迟：仍有 ${openToolCalls} 个工具调用未返回（例如前台 docker 构建），` +
              `静默属预期；${hardMin > 0 ? `${hardMin} 分钟硬上限仍有效` : '硬上限未启用'}`
          );
        }
        armIdle(true);
        return;
      }
      triggerTimeout('idle_timeout');
    }, input.idleMs);
  };

  const armSettle = (force = false): void => {
    // 工具调用未闭合时**绝不**起算收尾宽限：agent_end 只代表"本回合/本 run 不再有循环事件"，
    // 不代表仍在跑的工具（如 detached 的 docker compose build）已经结束。
    if (settled || input.settleMs <= 0 || !sessionEnded || openToolCalls > 0) return;
    const t = now();
    if (!force && settleTimer && t - settleArmedAt < rearmThreshold(input.settleMs)) return;
    clearSettle();
    settleArmedAt = t;
    settleTimer = setTimeout(() => {
      if (settled || terminal) return;
      terminal = 'settle_grace';
      input.onEvent('system', '✓ 会话已结束但进程未自行退出，主动收尾并保存结果以释放资源');
      beginStop('settle_grace');
    }, input.settleMs);
  };

  /** 会话结束信号到达但仍有未闭合工具调用：撤回收尾倒计时并**只记一次**明确事件。 */
  const deferSettleForOpenTools = (): void => {
    clearSettle();
    if (agentEndDeferredLogged) return;
    agentEndDeferredLogged = true;
    input.onEvent(
      'system',
      `⚠ 会话已结束但仍有 ${openToolCalls} 个工具调用未返回（例如前台 docker 构建）：已推迟收尾，` +
        '待全部工具闭合后再起算收尾宽限'
    );
  };

  function triggerTimeout(kind: 'hard_timeout' | 'idle_timeout'): void {
    if (settled || terminal) return;
    terminal = kind;
    clearTimers();
    const minutes = Math.round((kind === 'hard_timeout' ? input.hardMs : input.idleMs) / 60_000);
    const msg =
      kind === 'hard_timeout'
        ? `运行超过 ${minutes} 分钟硬上限，已自动终止`
        : `连续 ${minutes} 分钟无任何输出（疑似卡死），已自动终止`;
    noteExtra = msg;
    input.onEvent('error', `⏱ ${msg}`);
    beginStop(kind === 'hard_timeout' ? 'timeout_hard' : 'timeout_idle');
  }

  function buildFacts(stopState: StopState): StageFacts {
    const out = input.getOutput();
    const hasText = String(out.finalResult || '').trim() !== '';
    const kind: OutputKind =
      out.structured != null || hasText
        ? parseComplete(out.structured, out.finalResult)
          ? 'complete'
          : 'partial'
        : 'none';
    return {
      terminal: terminal ?? 'closed',
      spawnPhase,
      started,
      exitCode,
      exitSignal,
      stopRequested,
      stopState,
      outputKind: kind,
      note: noteExtra,
    };
  }

  function recordStopIfNeeded(facts: StageFacts, stopState: StopState): void {
    if (stopState !== 'alive' && stopState !== 'unknown' && stopState !== 'stopped_direct') return;
    const rec: StopRecord = {
      projectId: input.projectId,
      runId: input.runId,
      channel: input.channel,
      pid: typeof child?.pid === 'number' ? child.pid : null,
      pgid,
      child,
      terminator,
      platform: terminator.platform,
      canConfirmTree: terminator.canConfirmTree,
      terminal: facts.terminal,
      stopState,
      createdAt: now(),
      lastAttemptAt: now(),
      attempts: 1,
      exhausted: false,
    };
    if (stopState === 'stopped_direct') {
      putRecord(residualRisks, rec);
      input.onEvent(
        'system',
        `⚠ 直接子进程已停止但后代未确认（run=${input.runId}）；本阶段可继续，禁止自动重跑，已登记追踪`
      );
      return;
    }
    putRecord(blockingStops, rec);
    input.onEvent(
      'error',
      `⚠ 进程停止未确认（run=${input.runId}，stopState=${stopState}）；已登记阻断，暂不允许同项目再次启动`
    );
  }

  function settleNow(stopState: StopState): void {
    if (settled) return;
    settled = true;
    entry.settled = true;
    clearTimers();
    detachOwnListeners();

    const facts = buildFacts(stopState);
    const decision = decideStage(facts);
    const legacy = legacyKilledTimedOut(facts);
    const out = input.getOutput();
    // —— A. 启动失败必须在结算时产生一条**明确**的错误事件 ——
    // 只在 settleNow 里发（settleNow 被 settled 幂等门保护），所以同一次启动失败只记录一次；
    // 文案显式写明"Pi 启动失败"，绝不伪装成"用户取消"；底层原因保留（仅单行化 + 去掉重复前缀）。
    // try/catch：事件落库失败绝不能阻塞结算，否则调用方会永久 await（正是本守卫要消灭的缺陷）。
    if (facts.terminal === 'spawn_error') {
      try {
        input.onEvent('error', `⚠ Pi 启动失败：${normalizeSpawnErrorReason(facts.note)}`);
      } catch {
        /* 记事件失败不得影响结算 */
      }
    }
    // 结算瞬间仍未闭合的工具调用数：> 0 说明终止范围有残余风险，
    // 且"整棵树已停止"**不可**权威确认（Pi 的 bash 工具是 detached 的，不在 Pi 的进程组内）。
    openToolCallsAtSettle = openToolCalls;
    const stopConfirmed = stopState === 'stopped' && openToolCallsAtSettle === 0;
    if (openToolCallsAtSettle > 0) {
      try {
        input.onEvent(
          'error',
          `⚠ 终止时仍有 ${openToolCallsAtSettle} 个工具调用未返回（例如 detached 的 docker 构建）：` +
            '组终止只覆盖 Pi 自身进程组；Pi 收到 SIGTERM 后会自行 SIGKILL 其 tracked detached 子进程，' +
            '但平台侧**无法**权威确认这些后代已停止（残余风险，需人工/后续探测确认）'
        );
      } catch {
        /* 记事件失败不得影响结算 */
      }
    }
    result = {
      killed: legacy.killed,
      timedOut: legacy.timedOut,
      code: exitCode,
      structured: out.structured,
      finalResult: out.finalResult,
      stderrTail: out.stderrTail,
      runId: input.runId,
      channel: input.channel,
      facts,
      decision,
      stopConfirmed,
      openToolCallsAtSettle,
    };
    recordStopIfNeeded(facts, stopState);
    unregisterStage(input.projectId, input.runId);
    resolveDone(result);
  }

  async function runStopFlow(): Promise<StopState> {
    terminator.request(child, pgid);
    let st = await terminator.waitStopped(child, pgid, termGraceMs);
    if (st === 'stopped' || st === 'stopped_direct') return st;
    terminator.escalate(child, pgid);
    st = await terminator.waitStopped(child, pgid, killGraceMs);
    return st;
  }

  function beginStop(reason: StopReason): Promise<StopState> {
    if (stopFlow) return stopFlow;
    stopRequested = true;
    stopFlow = (async (): Promise<StopState> => {
      let st: StopState;
      if (!started) {
        st = 'not_requested';
      } else {
        try {
          st = await runStopFlow();
        } catch {
          st = 'unknown';
        }
      }
      noteExtra = noteExtra || reason;
      settleNow(st);
      return st;
    })();
    return stopFlow;
  }

  const api: StageGuard = {
    projectId: input.projectId,
    runId: input.runId,
    channel: input.channel,
    get settled(): boolean {
      return settled;
    },
    get result(): GuardResult | null {
      return result;
    },
    done,

    markSpawnFailed(message: string): void {
      started = false;
      spawnPhase = 'sync_throw';
      exitCode = -1;
      terminal = terminal ?? 'spawn_error';
      noteExtra = message;
      settleNow('not_requested');
    },

    markSpawned(c: GuardChild, h: GuardChildHooks = {}): void {
      child = c;
      hooks = h;
      entry.child = c;
      const pid = typeof c.pid === 'number' && c.pid > 0 ? c.pid : null;
      // spawn() 未抛异常但 pid 缺失 ⇒ 异步 spawn 失败（如 ENOENT），子进程从未真正启动。
      started = pid != null;
      spawnPhase = started ? 'started' : 'async_error';
      // 只有确认子进程是进程组组长（detached 生效）才使用 PGID；
      // 否则退回"直接子进程"判定，绝不误报 stopped。
      pgid = terminator.platform === 'linux' && pid != null && isProcessGroupLeader(pid) ? pid : null;
      entry.pgid = pgid;

      ownError = (err: any): void => {
        const e = err instanceof Error ? err : new Error(String(err));
        try {
          hooks.onError?.(e);
        } finally {
          if (settled || terminal) return;
          if (!started) {
            spawnPhase = 'async_error';
            exitCode = -1;
            terminal = 'spawn_error';
            noteExtra = e.message;
            settleNow('not_requested');
            return;
          }
          terminal = 'process_error';
          noteExtra = e.message;
          beginStop('cancel');
        }
      };

      ownClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        try {
          hooks.onClose?.(code, signal);
        } finally {
          exitCode = typeof code === 'number' ? code : exitCode;
          exitSignal = signal ?? null;
          if (settled || stopFlow || stopRequested) return;
          if (!started) {
            terminal = terminal ?? 'spawn_error';
            if (exitCode === null) exitCode = -1;
            settleNow('not_requested');
            return;
          }
          if (input.isCancelled?.()) {
            terminal = terminal ?? 'cancelled';
            if (exitCode === null) exitCode = -1;
            beginStop('cancel');
            return;
          }
          terminal = terminal ?? 'closed';
          settleNow('not_requested');
        }
      };

      c.on('close', ownClose);
      c.on('error', ownError);

      if (!started) return;
      if (input.idleMs > 0) armIdle(true);
      if (input.hardMs > 0) {
        // 注意：硬超时定时器**不** unref —— 有阶段在跑时应维持事件循环存活（与原 watchdog 一致）。
        hardTimer = setTimeout(() => triggerTimeout('hard_timeout'), input.hardMs);
      }
    },

    skipBeforeSpawn(t: StageTerminal, message: string): void {
      started = false;
      terminal = t;
      exitCode = -1;
      noteExtra = message;
      settleNow('not_requested');
    },

    noteStdout(): void {
      if (settled) return;
      armIdle();
      if (sessionEnded) armSettle();
    },

    /** stderr 有输出：只作诊断，不刷新 idle（避免"只说话不出活"压住卡死检测）。 */
    noteStderr(): void {
      /* 有意为空 */
    },

    noteSessionEnd(): void {
      if (settled) return;
      sessionEnded = true;
      // 仍有未闭合工具调用 ⇒ 推迟收尾（等工具返回后再起算宽限）。
      if (openToolCalls > 0) {
        deferSettleForOpenTools();
        return;
      }
      armSettle(true);
    },

    noteToolCalls(open: number): void {
      if (settled) return;
      const n = Number(open);
      openToolCalls = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      if (openToolCalls > 0) {
        // 工具未闭合：撤回收尾倒计时；若会话已结束则记一次"推迟收尾"。
        if (sessionEnded) deferSettleForOpenTools();
        else clearSettle();
        return;
      }
      // 全部闭合：允许下一轮 episode 重新记事件，并在会话已结束时恢复正常收尾宽限。
      agentEndDeferredLogged = false;
      idleSuppressedLogged = false;
      if (sessionEnded) armSettle(true);
    },

    requestStop(reason: StopReason): void {
      if (settled) return;
      if (!terminal) {
        terminal = 'cancelled';
        if (!started) exitCode = exitCode ?? -1;
      }
      void beginStop(reason);
    },

    async forceSettle(reason: StopReason): Promise<GuardResult> {
      if (settled) return result as GuardResult;
      if (!terminal) {
        terminal = 'cancelled';
        if (!started) exitCode = exitCode ?? -1;
      }
      await beginStop(reason);
      return result as GuardResult;
    },

    snapshot(): StageFacts | null {
      return settled ? (result?.facts ?? null) : buildFacts('not_requested');
    },
  };

  registerStage(entry, api);
  return api;
}

/* ============================== 测试辅助 ============================== */

/**
 * 「阶段未执行」的占位结果（供调用方在无实际 Pi 阶段时初始化变量）。
 * killed/ timedOut / code 与旧实现一致，便于 `if (r.killed || ...)` 判断保持原语义。
 */
export function placeholderStageResult(
  over: { killed?: boolean; timedOut?: boolean; code?: number; runId?: string; channel?: StageChannel } = {}
): GuardResult {
  const facts: StageFacts = {
    terminal: 'cancelled',
    spawnPhase: 'sync_throw',
    started: false,
    exitCode: over.code ?? 0,
    exitSignal: null,
    stopRequested: false,
    stopState: 'not_requested',
    outputKind: 'none',
    note: '阶段未执行',
  };
  return {
    killed: over.killed ?? false,
    timedOut: over.timedOut ?? false,
    code: over.code ?? 0,
    structured: undefined,
    finalResult: '',
    stderrTail: '',
    runId: over.runId ?? '',
    channel: over.channel ?? 'main',
    facts,
    decision: decideStage(facts),
    stopConfirmed: true,
    openToolCallsAtSettle: 0,
  };
}

/** 仅供单元测试：清空全部模块级状态。 */
export function __resetGuardStateForTest(): void {
  stageRegistry.clear();
  activeByProject.clear();
  blockingStops.clear();
  residualRisks.clear();
  generations.clear();
}

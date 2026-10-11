/**
 * piStageGuard 单元测试。
 *
 * 绝大部分用例使用假子进程（EventEmitter）+ 假终结器 + 短计时器，不 spawn 任何真实进程，
 * 也不 import runner.ts / db.ts，因此不受 better-sqlite3 ABI 影响。
 *
 * 唯一例外：末尾「部分完成语义」的落库校验需要真实的 agent_events 表，
 * 用 **动态 import** 惰性加载 runner.ts / db.ts；若当前环境缺少原生依赖，
 * 该用例会显式 skip（绝不谎报通过）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  __resetGuardStateForTest,
  activeRunIds,
  advanceGeneration,
  beginCommit,
  blockingStopCount,
  buildPartialCompletionText,
  canSubmit,
  commitResult,
  createOpenToolCallTracker,
  createStageGuard,
  createTerminator,
  currentGeneration,
  decideAutoRepair,
  decideStage,
  decideSubmit,
  forceSettleProject,
  hasBlockingStop,
  hasLiveStage,
  isDiagnosticsDirSeparated,
  issueSubmitToken,
  judgeStageCompletion,
  legacyKilledTimedOut,
  listBlockingStops,
  normalizeSpawnErrorReason,
  projectRecoverable,
  residualRiskCount,
  RESUME_ANCHOR_MARKERS,
  sweepStops,
  TERM_GRACE_MS,
  KILL_GRACE_MS,
  type GroupOutcomeCounts,
  type GuardChild,
  type ProjectFacts,
  type StageFacts,
  type StageGuardInput,
  type StageOutputBuffer,
  type StopState,
  type Terminator,
} from './piStageGuard';

/* ============================== 夹具 ============================== */

const PID = 'p_test';

class FakeChild extends EventEmitter implements GuardChild {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  killSignals: (NodeJS.Signals | undefined)[] = [];

  constructor(pid = 4242) {
    super();
    this.pid = pid;
  }

  kill(sig?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignals.push(sig);
    return true;
  }

  /** 模拟子进程退出。 */
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

class FakeTerminator implements Terminator {
  readonly platform: 'linux' | 'win32' | 'other';
  readonly canConfirmTree: boolean;
  requests = 0;
  escalates = 0;
  /** waitStopped 的结果队列；为空时回落到 probeState。 */
  waitQueue: StopState[] = [];
  probeState: StopState = 'alive';

  constructor(platform: 'linux' | 'win32' | 'other' = 'linux') {
    this.platform = platform;
    this.canConfirmTree = platform === 'linux';
  }

  request(): void {
    this.requests += 1;
  }

  escalate(): void {
    this.escalates += 1;
  }

  probe(): StopState {
    return this.probeState;
  }

  async waitStopped(): Promise<StopState> {
    return this.waitQueue.length > 0 ? (this.waitQueue.shift() as StopState) : this.probeState;
  }
}

function facts(over: Partial<StageFacts> = {}): StageFacts {
  return {
    terminal: 'closed',
    spawnPhase: 'started',
    started: true,
    exitCode: 0,
    exitSignal: null,
    stopRequested: false,
    stopState: 'not_requested',
    outputKind: 'complete',
    note: '',
    ...over,
  };
}

function project(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    projectId: PID,
    status: 'paused',
    verifyStatus: 'none',
    autoRepairCandidate: true,
    artifactsChangedSince: false,
    restartPending: false,
    ...over,
  };
}

interface Fixture {
  guard: ReturnType<typeof createStageGuard>;
  child: FakeChild;
  terminator: FakeTerminator;
  output: StageOutputBuffer;
  events: { kind: string; text: string }[];
}

function fixture(
  over: Partial<StageGuardInput> & { terminator?: FakeTerminator } = {}
): Fixture {
  const child = new FakeChild();
  const terminator = over.terminator ?? new FakeTerminator();
  const output: StageOutputBuffer = { structured: null, finalResult: '', stderrTail: '' };
  const events: { kind: string; text: string }[] = [];
  const guard = createStageGuard({
    projectId: PID,
    runId: 'run_A',
    channel: 'codeverify',
    hardMs: 0,
    idleMs: 0,
    settleMs: 0,
    parseComplete: () => true,
    onEvent: (kind, text) => events.push({ kind, text }),
    getOutput: () => output,
    ...over,
    terminator,
  });
  return { guard, child, terminator, output, events };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, ms = 1500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(5);
  }
  return cond();
}

test.beforeEach(() => {
  __resetGuardStateForTest();
});

/* ============================== 1. 纯判定：退出码 ============================== */

test('decideStage 区分退出码 0 / 非零 / 信号终止', () => {
  const ok = decideStage(facts({ exitCode: 0, exitSignal: null }));
  assert.equal(ok.acceptResult, true);
  assert.equal(ok.proceed, true);
  assert.equal(ok.autoRepairEligible, true);

  const nz = decideStage(facts({ exitCode: 1 }));
  assert.equal(nz.acceptResult, false, '非零退出不得被采信为成功');
  assert.equal(nz.proceed, true, '非零退出维持既有编排行为');
  assert.equal(nz.autoRepairEligible, false, '非零退出不得被自动重跑放行');

  const sig = decideStage(facts({ exitCode: null, exitSignal: 'SIGKILL' }));
  assert.equal(sig.acceptResult, false);
  assert.equal(sig.proceed, true);
  assert.equal(sig.autoRepairEligible, false);
});

test('decideStage：spawn_error / process_error / 取消 语义明确', () => {
  const spawnSync = decideStage(facts({ terminal: 'spawn_error', spawnPhase: 'sync_throw', started: false, exitCode: -1 }));
  assert.equal(spawnSync.acceptResult, false);
  assert.equal(spawnSync.proceed, false, '启动失败不允许继续编排');
  assert.match(spawnSync.reason, /同步 spawn 异常/);

  const spawnAsync = decideStage(facts({ terminal: 'spawn_error', spawnPhase: 'async_error', started: false, exitCode: -1 }));
  assert.equal(spawnAsync.proceed, false);
  assert.match(spawnAsync.reason, /异步 spawn error/);

  const perr = decideStage(facts({ terminal: 'process_error' }));
  assert.equal(perr.proceed, true);
  assert.equal(perr.autoRepairEligible, false);

  const cancelled = decideStage(facts({ terminal: 'cancelled', exitCode: -1 }));
  assert.equal(cancelled.acceptResult, false);
  assert.equal(cancelled.proceed, false);
});

test('decideStage：acceptResult 与 stopState 解耦（正常任务不因 stopConfirmed=false 丢结果）', () => {
  // settle_grace 且后代未确认 → proceed 可继续，结果仍被采信
  const grace = decideStage(
    facts({ terminal: 'settle_grace', stopRequested: true, stopState: 'stopped_direct' })
  );
  assert.equal(grace.acceptResult, true, '正常收尾的任务不得因 stopConfirmed=false 丢结果');
  assert.equal(grace.proceed, true);
  assert.equal(grace.autoRepairEligible, false, 'stopped_direct 禁止自动重跑');
});

/* ============================== 2. 纯判定：stopState 闸门 ============================== */

test('alive / unknown 阻断推进与自动重跑', () => {
  for (const st of ['alive', 'unknown'] as StopState[]) {
    const d = decideStage(facts({ terminal: 'hard_timeout', stopRequested: true, stopState: st }));
    assert.equal(d.proceed, false, `${st} 必须阻断下游推进`);
    assert.equal(d.autoRepairEligible, false);
    const legacy = legacyKilledTimedOut(facts({ terminal: 'hard_timeout', stopRequested: true, stopState: st }));
    assert.equal(legacy.killed, true, `${st} 必须映射为 killed=true 以中止旧调用点`);
    assert.equal(legacy.timedOut, true);
  }
});

test('legacy 映射逐终态保持既有语义', () => {
  const cases: [StageFacts, boolean, boolean][] = [
    [facts({ exitCode: 0 }), false, false],
    [facts({ exitCode: 1 }), false, false],
    [facts({ terminal: 'spawn_error', spawnPhase: 'sync_throw', started: false, exitCode: -1 }), true, false],
    [facts({ terminal: 'process_error' }), false, false],
    [facts({ terminal: 'hard_timeout', stopRequested: true, stopState: 'stopped' }), false, true],
    [facts({ terminal: 'idle_timeout', stopRequested: true, stopState: 'not_requested' }), false, true],
    [facts({ terminal: 'settle_grace', stopRequested: true, stopState: 'stopped' }), false, false],
    [facts({ terminal: 'cancelled', exitCode: -1 }), true, false],
  ];
  for (const [f, killed, timedOut] of cases) {
    const r = legacyKilledTimedOut(f);
    assert.equal(r.killed, killed, `${f.terminal}/${f.stopState} killed`);
    assert.equal(r.timedOut, timedOut, `${f.terminal}/${f.stopState} timedOut`);
  }
});

test('decideAutoRepair 需同时满足阶段与业务条件', () => {
  const stopped = facts({ terminal: 'hard_timeout', stopRequested: true, stopState: 'stopped' });
  // 阶段维度：超时不允许自动重跑
  assert.equal(decideAutoRepair(stopped, project()), false);

  const clean = facts({ exitCode: 0, stopState: 'not_requested' });
  assert.equal(
    decideAutoRepair(clean, project({ autoRepairCandidate: false })),
    false,
    '项目态不满足自动恢复条件'
  );
  assert.equal(decideAutoRepair(clean, project({ autoRepairCandidate: true })), true);
  assert.equal(decideAutoRepair(clean, project({ verifyStatus: 'failed' })), false);
  assert.equal(decideAutoRepair(clean, project({ artifactsChangedSince: true })), false);
  assert.equal(decideAutoRepair(clean, project({ restartPending: true })), false);
  assert.equal(decideAutoRepair(clean, project({ status: 'completed' })), false);
  // 仅"已确认停止"不足以恢复：项目态不满足时依旧 false
  assert.equal(
    decideAutoRepair(facts({ terminal: 'settle_grace', stopRequested: true, stopState: 'stopped' }), project({ artifactsChangedSince: true })),
    false
  );
});

test('projectRecoverable 只吃项目态（供回收器复用）', () => {
  assert.equal(projectRecoverable(project()), true);
  assert.equal(projectRecoverable(project({ status: 'completed' })), false);
  assert.equal(projectRecoverable(project({ verifyStatus: 'failed' })), false);
});

/* ============================== 3. 提交策略 ============================== */

test('decideSubmit：正常提交 / 诊断 / 丢弃 三分', () => {
  // 正常零退出且输出完整 → 提交
  assert.equal(decideSubmit(facts({ exitCode: 0 })).action, 'commit');
  // 非零退出：保留既有编排行为，但输出只进诊断目录
  assert.equal(decideSubmit(facts({ exitCode: 3, outputKind: 'complete' })).action, 'diagnose');
  assert.equal(decideSubmit(facts({ exitCode: 3, outputKind: 'partial' })).action, 'diagnose');
  assert.equal(
    decideSubmit(facts({ exitCode: null, exitSignal: 'SIGKILL', outputKind: 'complete' })).action,
    'diagnose'
  );
  // 超时（即使有完整输出）→ 仅诊断
  for (const t of ['hard_timeout', 'idle_timeout'] as const) {
    const d = decideSubmit(facts({ terminal: t, outputKind: 'complete' }));
    assert.equal(d.action, 'diagnose', `${t} 不得进入正常结果目录`);
    assert.equal(d.quality, 'complete');
  }
  // process_error → 仅诊断
  assert.equal(decideSubmit(facts({ terminal: 'process_error', outputKind: 'partial' })).action, 'diagnose');
  // spawn_error / 取消 → 丢弃
  assert.equal(decideSubmit(facts({ terminal: 'spawn_error', started: false })).action, 'discard');
  assert.equal(decideSubmit(facts({ terminal: 'cancelled' })).action, 'discard');
  // settle_grace：完整且已确认停止 → 提交；否则诊断
  assert.equal(
    decideSubmit(facts({ terminal: 'settle_grace', stopRequested: true, stopState: 'stopped' })).action,
    'commit'
  );
  assert.equal(
    decideSubmit(facts({ terminal: 'settle_grace', stopRequested: true, stopState: 'stopped_direct' })).action,
    'commit'
  );
  assert.equal(
    decideSubmit(facts({ terminal: 'settle_grace', stopRequested: true, stopState: 'unknown' })).action,
    'diagnose'
  );
  assert.equal(
    decideSubmit(facts({ terminal: 'settle_grace', stopRequested: true, stopState: 'stopped', outputKind: 'partial' })).action,
    'diagnose'
  );
});

/* ============================== 4. guard：正常 / 非零 / spawn 失败 ============================== */

test('guard：正常零退出 → succeeded，且不发起终止', async () => {
  const f = fixture();
  f.guard.markSpawned(f.child);
  f.child.close(0);
  const r = await f.guard.done;

  assert.equal(r.facts.terminal, 'closed');
  assert.equal(r.facts.exitCode, 0);
  assert.equal(r.facts.stopState, 'not_requested');
  assert.equal(r.killed, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.decision.acceptResult, true);
  assert.equal(r.decision.proceed, true);
  assert.equal(f.terminator.requests, 0, '正常退出不需要树终止确认');
  assert.equal(f.terminator.escalates, 0);
  assert.equal(hasBlockingStop(PID), false);
  assert.equal(await hasLiveStage(PID), false);
  assert.deepEqual(activeRunIds(PID), []);
});

test('guard：非零退出 → 不采信、不自动重跑，但编排可继续', async () => {
  const f = fixture();
  // 输出完整（结构化结果已拿到）但仍以非零码退出
  f.output.structured = { results: [{ index: 1, verdict: 'true_positive' }] };
  f.guard.markSpawned(f.child);
  f.child.close(2);
  const r = await f.guard.done;

  assert.equal(r.facts.exitCode, 2);
  assert.equal(r.killed, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.decision.acceptResult, false);
  assert.equal(r.decision.proceed, true);
  assert.equal(r.decision.autoRepairEligible, false);
  assert.equal(decideSubmit(r.facts).action, 'diagnose', '非零退出的输出只进诊断目录');
});

test('guard：spawn 同步失败 → spawn_error，不调用终结器，且不伪装成用户取消', async () => {
  const f = fixture();
  f.guard.markSpawnFailed('ENOENT: pi not found');
  const r = await f.guard.done;

  assert.equal(r.facts.terminal, 'spawn_error');
  assert.equal(r.facts.spawnPhase, 'sync_throw');
  assert.equal(r.facts.started, false);
  assert.equal(r.code, -1);
  assert.equal(r.killed, true, 'proceed=false → killed=true 以中止编排');
  assert.match(r.decision.reason, /同步 spawn 异常/);
  assert.doesNotMatch(r.decision.reason, /取消/);
  assert.equal(f.terminator.requests, 0);
});

test('guard：异步 spawn error（pid 缺失）→ spawn_error', async () => {
  const f = fixture();
  const child = new FakeChild();
  (child as any).pid = undefined; // spawn() 未抛异常但 pid 缺失
  f.guard.markSpawned(child);
  child.emit('error', new Error('spawn EACCES'));
  const r = await f.guard.done;

  assert.equal(r.facts.terminal, 'spawn_error');
  assert.equal(r.facts.spawnPhase, 'async_error');
  assert.equal(r.facts.started, false);
  assert.equal(r.decision.proceed, false);
  assert.equal(r.code, -1);
  assert.equal(f.terminator.requests, 0, '从未启动 ⇒ 无需终止');
});

test('guard：已启动后的 error → process_error，必须走终止确认', async () => {
  const f = fixture();
  f.terminator.waitQueue = ['alive', 'stopped'];
  f.guard.markSpawned(f.child);
  f.child.emit('error', new Error('kill failed'));
  const r = await f.guard.done;

  assert.equal(r.facts.terminal, 'process_error');
  assert.equal(r.facts.started, true);
  assert.equal(f.terminator.requests, 1, 'error 不等于已停止，必须发起终止');
  assert.equal(f.terminator.escalates, 1);
  assert.equal(r.facts.stopState, 'stopped');
  assert.equal(r.stopConfirmed, true);
  assert.equal(r.decision.acceptResult, false, '已启动后报错不得直接判成功');
});

test('guard：已启动后 error 不得仅凭 error 事件判为已停止', async () => {
  const f = fixture();
  f.terminator.waitQueue = ['alive', 'alive'];
  f.guard.markSpawned(f.child);
  f.child.emit('error', new Error('EPERM'));
  const r = await f.guard.done;

  assert.equal(r.facts.stopState, 'alive');
  assert.equal(r.stopConfirmed, false);
  assert.equal(r.decision.proceed, false);
  assert.equal(hasBlockingStop(PID), true, 'alive 必须登记阻断');
});

/* ============================== 5. guard：超时 ============================== */

test('guard：硬超时 → 记录事件、异步终止、升级信号、确认停止', async () => {
  const f = fixture({ hardMs: 30, idleMs: 0 });
  f.terminator.waitQueue = ['alive', 'stopped'];
  f.guard.markSpawned(f.child);
  const r = await f.guard.done;

  assert.equal(r.facts.terminal, 'hard_timeout');
  assert.equal(r.timedOut, true);
  assert.equal(r.killed, false, '已确认停止 → proceed=true → killed=false');
  assert.equal(r.facts.stopState, 'stopped');
  assert.equal(f.terminator.requests, 1);
  assert.equal(f.terminator.escalates, 1, '首轮未停止才升级');
  const ev = f.events.filter((e) => e.text.includes('⏱'));
  assert.equal(ev.length, 1, '超时必须恰好记录一条事件');
  assert.equal(ev[0].kind, 'error');
  assert.equal(decideSubmit(r.facts).action, 'diagnose');
});

test('guard：stdout 持续刷新 idle，停止输出后触发空闲超时', async () => {
  const f = fixture({ hardMs: 0, idleMs: 60 });
  f.terminator.waitQueue = ['stopped'];
  f.guard.markSpawned(f.child);

  for (let i = 0; i < 12; i++) {
    f.guard.noteStdout();
    await sleep(15);
  }
  assert.equal(f.guard.settled, false, 'stdout 持续时不得触发空闲超时');

  const r = await f.guard.done;
  assert.equal(r.facts.terminal, 'idle_timeout');
  assert.equal(r.timedOut, true);
  const ev = f.events.filter((e) => e.text.includes('⏱'));
  assert.equal(ev.length, 1);
  assert.match(ev[0].text, /无任何输出/);
});

test('guard：stderr 不刷新 idle（只说话不出活仍会被判卡死）', async () => {
  const f = fixture({ hardMs: 0, idleMs: 50 });
  f.terminator.waitQueue = ['stopped'];
  f.guard.markSpawned(f.child);
  for (let i = 0; i < 8; i++) {
    f.guard.noteStderr();
    await sleep(15);
  }
  const r = await f.guard.done;
  assert.equal(r.facts.terminal, 'idle_timeout');
  const ev = f.events.filter((e) => e.text.includes('⏱'));
  assert.equal(ev.length, 1);
});

test('guard：超时后的部分输出只作诊断，不进入正常结果', async () => {
  const f = fixture({ hardMs: 25, idleMs: 0 });
  f.output.structured = { results: [{ index: 1, verdict: 'true_positive' }] };
  f.output.finalResult = '{"results":[]}';
  f.terminator.waitQueue = ['stopped'];
  f.guard.markSpawned(f.child);
  const r = await f.guard.done;

  assert.equal(r.decision.acceptResult, true, '输出完整时仍可采信（用于诊断）');
  const sub = decideSubmit(r.facts);
  assert.equal(sub.action, 'diagnose', '超时结果不得进入正常结果目录 / regrade 输入');
  assert.equal(r.structured.results.length, 1, '诊断输出本身必须保留');
});

/* ============================== 6. guard：settle grace ============================== */

test('guard：settle grace → 既有语义（提交），但按 stopState 决定后续', async () => {
  const f = fixture({ hardMs: 0, idleMs: 0, settleMs: 25 });
  f.output.structured = { results: [1, 2] };
  f.terminator.waitQueue = ['stopped'];
  f.guard.markSpawned(f.child);
  f.guard.noteStdout();
  f.guard.noteSessionEnd();
  const r = await f.guard.done;

  assert.equal(r.facts.terminal, 'settle_grace');
  assert.equal(r.facts.stopRequested, true);
  assert.equal(r.killed, false, 'settle_grace 保持既有 killed=false');
  assert.equal(r.timedOut, false);
  assert.equal(r.decision.acceptResult, true);
  assert.equal(r.decision.proceed, true);
  assert.equal(decideSubmit(r.facts).action, 'commit');
  assert.equal(f.terminator.requests, 1);
  const ev = f.events.filter((e) => e.text.includes('会话已结束'));
  assert.equal(ev.length, 1);
});

test('guard：settle grace 但停止未确认 → 阻断推进且不提交', async () => {
  const f = fixture({ hardMs: 0, idleMs: 0, settleMs: 20 });
  f.terminator.waitQueue = ['unknown', 'unknown'];
  f.guard.markSpawned(f.child);
  f.guard.noteSessionEnd();
  const r = await f.guard.done;

  assert.equal(r.facts.stopState, 'unknown');
  assert.equal(r.decision.proceed, false, '停止未确认必须阻断');
  assert.equal(legacyKilledTimedOut(r.facts).killed, true);
  assert.equal(decideSubmit(r.facts).action, 'diagnose');
  assert.equal(hasBlockingStop(PID), true);
});

/* ============================== 7. 重复结算与并发取消 ============================== */

test('guard：重复结算幂等（error → close → 超时）', async () => {
  const f = fixture({ hardMs: 40, idleMs: 0 });
  f.terminator.waitQueue = ['stopped'];
  f.guard.markSpawned(f.child);
  f.child.emit('error', new Error('boom'));
  f.child.close(1); // close 迟到
  const r = await f.guard.done;
  await sleep(70); // 让已排定的硬超时定时器有机会（错误地）再次触发

  assert.equal(r.facts.terminal, 'process_error', 'terminal 取首个');
  assert.equal(f.guard.settled, true);
  assert.equal(f.events.filter((e) => e.text.includes('⏱')).length, 0, '不得再次触发超时结算');
  assert.equal(f.terminator.requests, 1);
});

test('guard：并发 requestStop/forceSettle 只启动一次终止流程且结果一致', async () => {
  const f = fixture();
  f.terminator.waitQueue = ['alive', 'stopped'];
  f.guard.markSpawned(f.child);

  f.guard.requestStop('user');
  f.guard.requestStop('user');
  const a = f.guard.forceSettle('runner_exit');
  const b = f.guard.forceSettle('reaper');
  const [ra, rb, rc] = await Promise.all([a, b, f.guard.done]);

  assert.equal(f.terminator.requests, 1, '终止流程只允许启动一次');
  assert.equal(ra, rb);
  assert.equal(rb, rc);
  assert.equal(ra.facts.terminal, 'cancelled');
  assert.equal(ra.killed, true);
});

/* ============================== 8. 阻断 / 追踪记录 ============================== */

test('stopped_direct：允许收尾但不阻断、禁止自动重跑、进入 residualRisks', async () => {
  const f = fixture();
  f.terminator.waitQueue = ['stopped_direct'];
  f.guard.markSpawned(f.child);
  f.child.emit('error', new Error('late close'));
  const r = await f.guard.done;

  assert.equal(r.facts.stopState, 'stopped_direct');
  assert.equal(r.stopConfirmed, false);
  assert.equal(r.decision.proceed, true, '允许当前任务做必要收尾');
  assert.equal(r.decision.autoRepairEligible, false);
  assert.equal(hasBlockingStop(PID), false, 'stopped_direct 不得阻断 isBusy');
  assert.equal(residualRiskCount(PID), 1);
  assert.equal(f.events.some((e) => e.text.includes('后代未确认')), true, '风险必须写入事件');
});

test('sweepStops：阻断记录确认停止后清理并解除阻断', async () => {
  const f = fixture();
  f.terminator.waitQueue = ['alive', 'alive'];
  f.guard.markSpawned(f.child);
  f.guard.requestStop('user');
  await f.guard.done;
  assert.equal(hasBlockingStop(PID), true);
  assert.equal(blockingStopCount(PID), 1);
  assert.equal(listBlockingStops(PID)[0].attempts, 1);

  // 下一次复查时已停止
  f.terminator.waitQueue = ['stopped'];
  const res = await sweepStops({
    onEvent: (id, kind, text) => f.events.push({ kind, text }),
    probeWaitMs: 1,
  });
  assert.equal(res.cleared, 1);
  assert.equal(hasBlockingStop(PID), false);
  assert.equal(blockingStopCount(PID), 0);
});

test('sweepStops：阻断记录降级为 stopped_direct 时转入 residualRisks', async () => {
  const f = fixture();
  f.terminator.waitQueue = ['alive', 'unknown'];
  f.guard.markSpawned(f.child);
  f.guard.requestStop('user');
  await f.guard.done;
  assert.equal(listBlockingStops(PID)[0].stopState, 'unknown');

  f.terminator.waitQueue = ['stopped_direct'];
  const res = await sweepStops({ onEvent: () => {}, probeWaitMs: 1 });
  assert.equal(res.downgraded, 1);
  assert.equal(hasBlockingStop(PID), false);
  assert.equal(residualRiskCount(PID), 1);
});

test('sweepStops：重试耗尽（exhausted）后仍持续探测，进程停止即解除阻断', async () => {
  const f = fixture();
  f.terminator.waitQueue = ['alive', 'alive', 'alive'];
  f.terminator.probeState = 'alive';
  f.guard.markSpawned(f.child);
  f.guard.requestStop('user');
  await f.guard.done;
  assert.equal(hasBlockingStop(PID), true);

  // 连续复查把 attempts 推到上限 → 标记 exhausted（不再重复发起终止）
  await sweepStops({ onEvent: () => {}, probeWaitMs: 1 });
  await sweepStops({ onEvent: () => {}, probeWaitMs: 1 });
  const rec = listBlockingStops(PID)[0];
  assert.equal(rec.exhausted, true, '重试耗尽后应标记 exhausted');
  assert.equal(hasBlockingStop(PID), true, '耗尽后仍保持阻断');

  // 进程随后真的退出：即使 exhausted，也必须能被探测清理，否则项目永久阻断
  f.terminator.probeState = 'stopped';
  const res = await sweepStops({
    onEvent: (id, kind, text) => f.events.push({ kind, text }),
    probeWaitMs: 1,
  });
  assert.equal(res.cleared, 1, 'exhausted 记录也必须能被探测清理');
  assert.equal(hasBlockingStop(PID), false, '不得永久阻断');
  assert.equal(
    f.events.some((e) => e.text.includes('已解除阻断')),
    true
  );
});

test('sweepStops：residualRisks 超 TTL 后清理并声明"已停止追踪"', async () => {
  const f = fixture();
  f.terminator.waitQueue = ['stopped_direct'];
  f.guard.markSpawned(f.child);
  f.guard.requestStop('user');
  await f.guard.done;
  assert.equal(residualRiskCount(PID), 1);

  const events: string[] = [];
  const res = await sweepStops({
    onEvent: (_id, _k, text) => events.push(text),
    probeWaitMs: 1,
    residualTtlMs: 0,
  });
  assert.equal(res.abandoned, 1);
  assert.equal(residualRiskCount(PID), 0, '清理后不得再声称仍在追踪');
  assert.equal(events.some((t) => t.includes('已停止追踪')), true);
});

/* ============================== 9. 实例隔离与生命周期清理 ============================== */

test('不同实例互不干扰', async () => {
  const a = fixture({ runId: 'run_A' });
  const b = fixture({ runId: 'run_B' });
  a.guard.markSpawned(a.child);
  b.guard.markSpawned(b.child);

  a.guard.noteStdout();
  a.guard.noteSessionEnd();
  await sleep(10);
  assert.equal(b.guard.settled, false, 'A 的活动不得结算 B');
  assert.equal(b.terminator.requests, 0);

  await a.guard.forceSettle('runner_exit');
  assert.equal(a.guard.settled, true);
  assert.equal(b.guard.settled, false, 'A 的终止不得影响 B');
  await sleep(30);
  assert.equal(b.guard.settled, false);
  assert.deepEqual(b.child.killSignals, [], 'B 的子进程不得被误杀');
  assert.equal(activeRunIds(PID).includes('run_B'), true);

  await b.guard.forceSettle('runner_exit');
});

test('forceSettleProject 精确结算该项目全部未结算实例', async () => {
  const a = fixture({ runId: 'run_A' });
  const b = fixture({ runId: 'run_B' });
  a.guard.markSpawned(a.child);
  b.guard.markSpawned(b.child);

  const n = forceSettleProject(PID, 'reaper');
  assert.equal(n, 2);
  await Promise.all([a.guard.done, b.guard.done]);
  assert.equal(a.guard.settled, true);
  assert.equal(b.guard.settled, true);
  assert.deepEqual(activeRunIds(PID), [], '结算后必须精确注销');
});

test('forceSettleProject 支持 excludeChannels：runner_exit 保留 env 通道', async () => {
  const env = fixture({ runId: 'run_env', channel: 'env' });
  const cv = fixture({ runId: 'run_cv', channel: 'codeverify' });
  env.guard.markSpawned(env.child);
  cv.guard.markSpawned(cv.child);

  const n = forceSettleProject(PID, 'runner_exit', { excludeChannels: ['env'] });
  assert.equal(n, 1, '只结算 1 个非 env 实例');
  await cv.guard.done;
  assert.equal(cv.guard.settled, true, 'codeverify 实例被结算');
  assert.equal(env.guard.settled, false, 'env 实例不得被结算');
  assert.equal(env.terminator.requests, 0, 'env 子进程不得收到 SIGTERM');
  assert.equal(activeRunIds(PID).includes('run_env'), true, 'env runId 必须保留在登记表');
  assert.equal(activeRunIds(PID).includes('run_cv'), false, 'codeverify runId 已注销');
  await env.guard.forceSettle('runner_exit');
});

test('forceSettleProject 默认（不带 exclude）仍结算全部通道（reaper 场景含 env）', async () => {
  const env = fixture({ runId: 'run_env', channel: 'env' });
  const cv = fixture({ runId: 'run_cv', channel: 'codeverify' });
  env.guard.markSpawned(env.child);
  cv.guard.markSpawned(cv.child);

  const n = forceSettleProject(PID, 'reaper');
  assert.equal(n, 2);
  await Promise.all([env.guard.done, cv.guard.done]);
  assert.equal(env.guard.settled, true, 'reaper 场景 env 也要结算');
  assert.equal(cv.guard.settled, true);
  assert.deepEqual(activeRunIds(PID), [], '全部结算后精确注销');
});

test('只移除 guard 自己注册的监听器（不破坏外部监听器）', async () => {
  const f = fixture();
  let externalCalls = 0;
  const external = (): void => {
    externalCalls += 1;
  };
  f.child.on('close', external);
  assert.equal(f.child.listenerCount('close'), 1);

  f.guard.markSpawned(f.child);
  assert.equal(f.child.listenerCount('close'), 2, 'guard 追加自己的 close 监听器');
  assert.equal(f.child.listenerCount('error'), 1);

  f.child.close(0);
  await f.guard.done;

  assert.equal(f.child.listenerCount('close'), 1, '只摘掉 guard 自己的监听器');
  assert.equal(f.child.listenerCount('error'), 0);
  f.child.emit('close', 0, null);
  assert.equal(externalCalls, 2, '外部监听器仍可用');
});

test('结算后定时器全部清理，不再产生任何事件', async () => {
  const f = fixture({ hardMs: 40, idleMs: 40, settleMs: 40 });
  f.guard.markSpawned(f.child);
  f.child.close(0);
  await f.guard.done;
  const before = f.events.length;
  await sleep(90);
  assert.equal(f.events.length, before, '结算后不得再触发任何定时器事件');
  assert.equal(f.guard.settled, true);
});

/* ============================== 10. generation / token ============================== */

test('正常结束的 worker 在 guard 结算并注销后仍能提交结果', async () => {
  const f = fixture({ runId: 'run_ok' });
  f.guard.markSpawned(f.child);
  f.child.close(0);
  await f.guard.done;

  assert.equal(f.guard.settled, true);
  assert.deepEqual(activeRunIds(PID), [], '进程登记已注销');
  const token = issueSubmitToken(PID, 'run_ok');
  assert.equal(canSubmit(token), true, '提交令牌与进程登记相互独立');
  const written = commitResult(token, () => 'written');
  assert.equal(written, 'written');
});

test('旧 runId 在新一轮替换后提交被拒绝，且不覆盖新结果', () => {
  const t1 = issueSubmitToken(PID, 'run_A');
  assert.equal(canSubmit(t1), true);
  const guard = beginCommit(t1);
  assert.notEqual(guard, null);

  advanceGeneration(PID, 'run_B');
  assert.equal(currentGeneration(PID), 2);
  assert.equal(canSubmit(t1), false, '新一轮开始后旧令牌必须失效');
  assert.equal(
    guard!.commit(() => 'stale'),
    null,
    '异步步骤之后落盘时再次校验，旧实例不得写入'
  );
  assert.equal(commitResult(t1, () => 'stale'), null);

  const t2 = issueSubmitToken(PID, 'run_B');
  assert.equal(commitResult(t2, () => 'fresh'), 'fresh', '新实例仍可正常提交');
});

test('已失效的 guard 不影响新 runId', async () => {
  const old = fixture({ runId: 'run_old' });
  old.guard.markSpawned(old.child);
  await old.guard.forceSettle('reaper');
  assert.equal(old.guard.settled, true);

  const fresh = fixture({ runId: 'run_new' });
  fresh.guard.markSpawned(fresh.child);
  // 旧实例再次尝试收尾不得波及新实例
  old.guard.requestStop('reaper');
  await old.guard.forceSettle('reaper');
  await sleep(20);

  assert.equal(fresh.guard.settled, false);
  assert.equal(fresh.terminator.requests, 0);
  assert.deepEqual(fresh.child.killSignals, []);
  assert.equal(hasLiveStage(PID), true);
  await fresh.guard.forceSettle('runner_exit');
});

/* ============================== 11. 静态约束 ============================== */

test('piStageGuard.ts 不含任何同步进程终止调用，也不依赖 runner/db', () => {
  const src = fs.readFileSync(path.join(__dirname, 'piStageGuard.ts'), 'utf8');
  for (const banned of ['execSync', 'execFileSync', 'spawnSync', "from './runner'", "from './db'"]) {
    assert.equal(src.includes(banned), false, `不得出现 ${banned}`);
  }
  assert.equal(src.includes("from 'node:child_process'"), true);
});

test('终结器在无子进程时立即返回，不会空等', async () => {
  const t = createTerminator();
  const st = await t.waitStopped(null, null, 5_000);
  assert.equal(st, 'not_requested');
  assert.equal(typeof TERM_GRACE_MS, 'number');
  assert.equal(typeof KILL_GRACE_MS, 'number');
});

/* ============================== 12. A：spawn_error 的明确错误事件 ============================== */

test('normalizeSpawnErrorReason：单行化、去重前缀、截断', () => {
  assert.equal(normalizeSpawnErrorReason('无法启动 Pi：ENOENT: pi not found'), 'ENOENT: pi not found');
  assert.equal(normalizeSpawnErrorReason('spawn failed: EACCES'), 'EACCES');
  assert.equal(normalizeSpawnErrorReason('  ENOENT\n  at spawn  '), 'ENOENT at spawn');
  assert.equal(normalizeSpawnErrorReason(''), '未知原因');
  assert.equal(normalizeSpawnErrorReason(undefined), '未知原因');
  const long = normalizeSpawnErrorReason('x'.repeat(500));
  assert.equal(long.length, 301, '超长原因截断为 300 + 省略号');
  assert.ok(long.endsWith('…'));
});

test('A：同步 spawn 失败 → 恰好一条「⚠ Pi 启动失败」错误事件，且不伪装成取消', async () => {
  const f = fixture();
  f.guard.markSpawnFailed('无法启动 Pi：ENOENT: pi not found');
  const r = await f.guard.done;

  const errs = f.events.filter((e) => e.kind === 'error' && e.text.includes('Pi 启动失败'));
  assert.equal(errs.length, 1, '同一次启动失败只记录一次事件');
  assert.match(errs[0].text, /^⚠ Pi 启动失败：ENOENT: pi not found$/, '底层原因不得丢失');
  assert.equal(errs[0].text.includes('取消'), false, '启动失败不得伪装成用户取消');

  // 既定兼容映射不得改变
  assert.equal(r.facts.terminal, 'spawn_error');
  assert.equal(r.facts.spawnPhase, 'sync_throw');
  assert.equal(r.killed, true);
  assert.equal(r.timedOut, false);
  assert.equal(f.terminator.requests, 0, '从未启动成功时不得调用终结器');
  assert.equal(f.child.killSignals.length, 0);
});

test('A：异步 spawn error（pid 缺失）→ 只记一次；迟到 close/error 不再补记', async () => {
  const f = fixture();
  const child = new FakeChild();
  (child as { pid?: number }).pid = undefined; // ENOENT：spawn 未抛异常，但子进程从未真正启动

  f.guard.markSpawned(child, {});
  child.emit('error', new Error('spawn ENOENT'));
  const r = await f.guard.done;

  // 结算之后 guard 必须已摘掉自己注册的监听器（迟到事件不得二次记事件、二次结算）
  assert.equal(child.listenerCount('close'), 0, '结算后必须摘除自己的 close 监听器');
  assert.equal(child.listenerCount('error'), 0, '结算后必须摘除自己的 error 监听器');
  child.emit('close', -2, null);
  child.on('error', () => {}); // 吸收迟到 error，避免 EventEmitter 在无监听时抛出
  child.emit('error', new Error('late error'));
  await sleep(20);

  const errs = f.events.filter((e) => e.text.includes('Pi 启动失败'));
  assert.equal(errs.length, 1, '异步启动失败 + 迟到事件仍只记一条');
  assert.equal(errs[0].kind, 'error');
  assert.match(errs[0].text, /ENOENT/, '底层原因不得丢失');
  assert.equal(r.facts.terminal, 'spawn_error');
  assert.equal(r.facts.spawnPhase, 'async_error');
  assert.equal(r.killed, true);
  assert.equal(r.timedOut, false);

  // 真正的用户取消走另一条路径：文案与终态都必须可区分
  const c = fixture();
  c.guard.skipBeforeSpawn('cancelled', '已请求中止，跳过本阶段');
  const rc = await c.guard.done;
  assert.equal(rc.facts.terminal, 'cancelled');
  assert.equal(
    c.events.some((e) => e.text.includes('Pi 启动失败')),
    false,
    '取消不得被记成启动失败'
  );
});

/* ============================== 13. B：阶段完成的完整 / 部分语义 ============================== */

test('B：judgeStageCompletion —— 四组全成功才算完整完成', () => {
  const allOk = judgeStageCompletion({
    groupsTotal: 4,
    committed: 4,
    diagnosed: 0,
    discarded: 0,
    killed: false,
    aborted: false,
  });
  assert.equal(allOk.complete, true, '四组全部正常产出 ⇒ 完整完成');
  assert.equal(allOk.partial, false);
});

test('B：三组正常 + 一组仅产出诊断 ⇒ 部分完成（不得宣称完整）', () => {
  const oneDiag = judgeStageCompletion({
    groupsTotal: 4,
    committed: 3,
    diagnosed: 1,
    discarded: 0,
    killed: false,
    aborted: false,
  });
  assert.equal(oneDiag.complete, false, '一组异常进入诊断 ⇒ 不得发权威完成事件');
  assert.equal(oneDiag.partial, true);

  // 边界：0 组 / 中止 / 未产出 / 被取消 一律不是完整完成
  assert.equal(judgeStageCompletion({ groupsTotal: 0, committed: 0, diagnosed: 0, discarded: 0 }).complete, false);
  assert.equal(
    judgeStageCompletion({ groupsTotal: 4, committed: 4, diagnosed: 0, discarded: 0, killed: true }).complete,
    false
  );
  assert.equal(
    judgeStageCompletion({ groupsTotal: 4, committed: 4, diagnosed: 0, discarded: 0, aborted: true }).complete,
    false
  );
  assert.equal(
    judgeStageCompletion({ groupsTotal: 4, committed: 3, diagnosed: 0, discarded: 1 }).complete,
    false
  );
});

test('B：部分完成事件记录正常完成数 / 预期组数 / 失败或诊断组数', () => {
  const text = buildPartialCompletionText('代码级验证', {
    groupsTotal: 4,
    committed: 3,
    diagnosed: 1,
    discarded: 0,
  });
  assert.match(text, /^⚠ 代码级验证部分完成：/);
  assert.match(text, /正常完成 3\/4 组/);
  assert.match(text, /异常\/输出不完整 1 组/);
  assert.match(text, /只留在诊断目录/);

  // 启动失败 / 令牌失效（discard）与"未执行"都要能被看清
  const mixed = buildPartialCompletionText('实战二次评级', {
    groupsTotal: 5,
    committed: 2,
    diagnosed: 1,
    discarded: 1,
    aborted: true,
  });
  assert.match(mixed, /正常完成 2\/5 组/);
  assert.match(mixed, /未产出 1 组/);
  assert.match(mixed, /未执行 1 组/);
  assert.match(mixed, /已中止后续组/);
});

test('B：部分完成文案与全部权威完成标记均不构成子串包含（lastAuditPipelineDoneTs 不变式）', () => {
  const cases: [string, GroupOutcomeCounts][] = [
    ['AI 智能去重', { groupsTotal: 2, committed: 1, diagnosed: 1, discarded: 0 }],
    ['代码级验证', { groupsTotal: 4, committed: 3, diagnosed: 1, discarded: 0 }],
    ['实战二次评级', { groupsTotal: 4, committed: 3, diagnosed: 1, discarded: 0 }],
    ['代码级验证（含二次评级）', { groupsTotal: 4, committed: 2, diagnosed: 1, discarded: 1, aborted: true }],
  ];
  assert.ok(RESUME_ANCHOR_MARKERS.length >= 4);
  for (const [label, counts] of cases) {
    const text = buildPartialCompletionText(label, counts);
    for (const marker of RESUME_ANCHOR_MARKERS) {
      assert.equal(
        text.includes(marker),
        false,
        `部分完成文案不得包含权威标记「${marker}」：${text}`
      );
    }
  }
});

test('B：runner.ts 仍保留四个权威完成标记（门禁只改「何时发」，不改「发什么」）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf8');
  for (const marker of RESUME_ANCHOR_MARKERS) {
    assert.equal(src.includes(marker), true, `runner.ts 必须仍包含权威标记「${marker}」`);
  }
  assert.equal(src.includes('function recordStageCompletion('), true);
});

test('B：诊断目录与正常结果目录必须物理隔离', () => {
  const resDir = path.join('/tmp', 'proj', '_code_verify', 'results');
  const diagDir = path.join('/tmp', 'proj', '_code_verify', 'diagnostics');
  assert.equal(isDiagnosticsDirSeparated(resDir, diagDir), true);
  assert.equal(isDiagnosticsDirSeparated(resDir, resDir), false, '同一目录不算隔离');
  assert.equal(
    isDiagnosticsDirSeparated(resDir, path.join(resDir, 'diagnostics')),
    false,
    '落在结果目录内部会污染正常结果集'
  );
});

/* ============================== 14. B：落库校验（需 db / runner，缺依赖则 skip） ============================== */

test('B：lastAuditPipelineDoneTs 不会把部分完成事件当成完整阶段结束标记', async (t) => {
  let database: typeof import('./db').default;
  let seam: typeof import('./runner').__testingAuditPipelineCompletion;
  try {
    database = (await import('./db')).default;
    seam = (await import('./runner')).__testingAuditPipelineCompletion;
  } catch (err) {
    t.skip(`跳过：当前环境无法加载 runner/db（${String((err as Error)?.message || err)}）`);
    return;
  }

  const id = `p_guard_partial_${Date.now().toString(16)}`;
  const rollback = new Error('ROLLBACK_GUARD_PARTIAL');
  const lastSystemEvent = (): string =>
    String(
      (
        database
          .prepare(
            `SELECT text FROM agent_events WHERE project_id = ? AND kind = 'system'
             ORDER BY ts DESC, rowid DESC LIMIT 1`
          )
          .get(id) as { text: string } | undefined
      )?.text ?? ''
    );
  try {
    database.transaction(() => {
      const ts = Date.now();
      database
        .prepare(
          `INSERT INTO projects (id, project_name, archive_name, source_type, source_ref, status, created_at)
           VALUES (?, ?, '', 'github', 'https://example.test/guard-partial.git', 'running', ?)`
        )
        .run(id, id, ts);

      const allOk: GroupOutcomeCounts = {
        groupsTotal: 4,
        committed: 4,
        diagnosed: 0,
        discarded: 0,
        killed: false,
        aborted: false,
      };
      const oneDiag: GroupOutcomeCounts = {
        groupsTotal: 4,
        committed: 3,
        diagnosed: 1,
        discarded: 0,
        killed: false,
        aborted: false,
      };
      const AUTH = '✓ 代码级验证完成：4 个候选 → 4 个真阳性';

      // ① 四组全成功 → 生成权威完成事件，并被 lastAuditPipelineDoneTs 采信
      seam.recordStageCompletion(id, '代码级验证', AUTH, allOk);
      assert.match(lastSystemEvent(), /^✓ 代码级验证完成/);
      const doneTs = seam.lastAuditPipelineDoneTs(id);
      assert.notEqual(doneTs, null, '全组正常完成必须落入权威收尾锚点');
      assert.equal(seam.auditFinishedCleanly(id), true);

      // ② 三组正常 + 一组诊断 → 只发部分完成事件，且不得成为权威收尾锚点
      seam.recordStageCompletion(id, '实战二次评级', '✓ 实战二次评级完成：4/4 个漏洞已评级', oneDiag);
      const partialText = lastSystemEvent();
      assert.match(partialText, /^⚠ 实战二次评级部分完成：/);
      assert.match(partialText, /正常完成 3\/4 组/);
      assert.match(partialText, /异常\/输出不完整 1 组/);
      assert.equal(
        seam.lastAuditPipelineDoneTs(id),
        doneTs,
        '部分完成事件不得推进（也不得充当）权威收尾锚点'
      );
      assert.equal(
        seam.inferResumeAuditStage(id),
        'regrade',
        '续跑定位仍锚在真正完成的环节上'
      );

      // ③ 只有部分完成事件（无任何权威完成标记）→ 不得判为完成，也不能把续跑推进到下一环节
      database.prepare(`DELETE FROM agent_events WHERE project_id = ?`).run(id);
      seam.recordStageCompletion(id, '代码级验证', AUTH, oneDiag);
      assert.match(lastSystemEvent(), /^⚠ 代码级验证部分完成：/);
      assert.equal(seam.lastAuditPipelineDoneTs(id), null, '部分完成不得被当成完整阶段结束');
      assert.equal(seam.auditFinishedCleanly(id), false);
      assert.equal(seam.inferResumeAuditStage(id), 'subagent', '部分完成不得把续跑定位推进到下一环节');

      throw rollback;
    })();
  } catch (error) {
    if (error !== rollback) throw error;
  }
});

/* ============================== 15. M1：未闭合工具调用门控 ============================== */

/** 已确认停止的终结器（隔离"停止确认"与"工具门控"两个变量）。 */
function stoppedTerminator(): FakeTerminator {
  const t = new FakeTerminator();
  t.probeState = 'stopped';
  t.waitQueue = ['stopped'];
  return t;
}

test('M1-tracker：按 toolCallId 配对，重复 start/重复 end/迟到事件都不破坏计数', () => {
  const tr = createOpenToolCallTracker();
  assert.deepEqual(tr.observe({ type: 'tool_execution_start', toolCallId: 'a' }), {
    open: 1,
    changed: true,
  });
  // 重复 start 同一 id：幂等，不重复计数、也不算"变化"
  assert.deepEqual(tr.observe({ type: 'tool_execution_start', toolCallId: 'a' }), {
    open: 1,
    changed: false,
  });
  assert.deepEqual(tr.observe({ type: 'tool_execution_start', toolCallId: 'b' }), {
    open: 2,
    changed: true,
  });
  // 中途 update：不改变计数、也不算变化
  assert.deepEqual(tr.observe({ type: 'tool_execution_update', toolCallId: 'b' }), {
    open: 2,
    changed: false,
  });
  // 迟到 / 未知 end：幂等空操作
  assert.deepEqual(tr.observe({ type: 'tool_execution_end', toolCallId: 'zzz' }), {
    open: 2,
    changed: false,
  });
  assert.deepEqual(tr.observe({ type: 'tool_execution_end', toolCallId: 'b' }), {
    open: 1,
    changed: true,
  });
  // 重复 end 同一 id：幂等
  assert.deepEqual(tr.observe({ type: 'tool_execution_end', toolCallId: 'b' }), {
    open: 1,
    changed: false,
  });
  assert.deepEqual(tr.observe({ type: 'tool_execution_end', toolCallId: 'a' }), {
    open: 0,
    changed: true,
  });
  // 缺 id 的异常事件：合成 id 兜底，仍能成对闭合
  assert.equal(tr.observe({ type: 'tool_execution_start' }).open, 1);
  assert.equal(tr.observe({ type: 'tool_execution_end' }).open, 0);
  // 非对象 / 无关事件不改变计数
  assert.equal(tr.observe(null).changed, false);
  assert.equal(tr.observe({ type: 'agent_end' }).changed, false);
  assert.equal(tr.size, 0);
  assert.deepEqual(tr.ids(), []);
});

test('M1：未闭合工具调用期间收到 agent_end → settle 宽限不起算（明确事件只记一次）', async () => {
  const f = fixture({ settleMs: 80, idleMs: 0, hardMs: 0, terminator: stoppedTerminator() });
  f.guard.markSpawned(f.child);
  f.guard.noteToolCalls(1); // 例如前台 docker compose build 正在跑
  f.guard.noteSessionEnd(); // agent_end
  f.guard.noteSessionEnd(); // 重复 agent_end：不得重复记事件

  await sleep(240); // 远超 settleMs(80)
  assert.equal(f.guard.settled, false, '工具未闭合时 settle 不得触发');
  assert.equal(f.terminator.requests, 0, '不得调用终结器');
  const deferred = f.events.filter((e) => e.text.includes('已推迟收尾'));
  assert.equal(deferred.length, 1, '推迟收尾事件只记一次');
  assert.match(deferred[0].text, /仍有 1 个工具调用/);

  // 工具闭合 + 会话已结束 ⇒ 恢复正常 settle 宽限
  f.guard.noteToolCalls(0);
  const r = await f.guard.done;
  assert.equal(r.facts.terminal, 'settle_grace');
  assert.equal(r.facts.stopState, 'stopped');
  assert.equal(r.killed, false);
  assert.equal(r.timedOut, false, 'agent_end 后正常收尾不得算超时');
  assert.equal(r.openToolCallsAtSettle, 0);
  assert.equal(r.stopConfirmed, true, '无未闭合工具时停止确认仍成立');
});

test('M1：顺序颠倒（先 agent_end 再开工具）同样撤回收尾倒计时', async () => {
  const f = fixture({ settleMs: 80, idleMs: 0, hardMs: 0, terminator: stoppedTerminator() });
  f.guard.markSpawned(f.child);
  f.guard.noteSessionEnd();
  f.guard.noteToolCalls(1); // agent_end 之后又有工具开始
  await sleep(240);
  assert.equal(f.guard.settled, false);
  assert.equal(
    f.events.filter((e) => e.text.includes('已推迟收尾')).length,
    1,
    '推迟收尾事件只记一次'
  );
  await f.guard.forceSettle('runner_exit');
});

test('M1：多个并行工具调用必须**全部**闭合才允许收尾', async () => {
  const f = fixture({ settleMs: 60, idleMs: 0, hardMs: 0, terminator: stoppedTerminator() });
  f.guard.markSpawned(f.child);
  f.guard.noteToolCalls(3);
  f.guard.noteSessionEnd();
  await sleep(150);
  assert.equal(f.guard.settled, false, '3 个未闭合');
  f.guard.noteToolCalls(2);
  await sleep(150);
  assert.equal(f.guard.settled, false, '还剩 2 个未闭合');
  f.guard.noteToolCalls(1);
  await sleep(150);
  assert.equal(f.guard.settled, false, '还剩 1 个未闭合');
  f.guard.noteToolCalls(0);
  const r = await f.guard.done;
  assert.equal(r.facts.terminal, 'settle_grace', '全部闭合后才收尾');
  assert.equal(r.openToolCallsAtSettle, 0);
});

test('M1：工具未闭合时的静默不触发 idle，但 hard 上限仍生效并进入终止流程', async () => {
  const f = fixture({ settleMs: 0, idleMs: 60, hardMs: 300, terminator: stoppedTerminator() });
  f.guard.markSpawned(f.child);
  f.guard.noteToolCalls(1);
  f.guard.noteSessionEnd();

  await sleep(220); // > idleMs(60)，< hardMs(300)
  assert.equal(f.guard.settled, false, 'idle 不得在工具未闭合时判定卡死');
  assert.equal(
    f.events.filter((e) => e.text.includes('空闲超时已推迟')).length,
    1,
    '推迟 idle 的事件只记一次'
  );
  assert.equal(
    f.events.some((e) => e.text.includes('无任何输出')),
    false,
    '不得出现 idle 超时终止事件'
  );

  const r = await f.guard.done; // hard 到点
  assert.equal(r.facts.terminal, 'hard_timeout');
  assert.equal(r.timedOut, true, 'hard deadline 仍是不可延长的绝对上限');
  assert.equal(r.openToolCallsAtSettle, 1, '结算时如实记录未闭合工具数');
  assert.equal(r.stopConfirmed, false, '仍有未闭合工具 ⇒ 不得断言整树已停');
  assert.ok(
    f.events.some((e) => e.text.includes('终止时仍有 1 个工具调用未返回')),
    '必须记录终止范围与残余风险'
  );
});

test('M1：无未闭合工具调用时，原有 settle 行为逐字不变（回归）', async () => {
  const f = fixture({ settleMs: 70, idleMs: 0, hardMs: 0, terminator: stoppedTerminator() });
  f.guard.markSpawned(f.child);
  f.guard.noteSessionEnd();
  const r = await f.guard.done;
  assert.equal(r.facts.terminal, 'settle_grace');
  assert.equal(r.openToolCallsAtSettle, 0);
  assert.equal(r.stopConfirmed, true);
  assert.equal(f.events.filter((e) => e.text.includes('已推迟收尾')).length, 0);
  assert.equal(f.events.filter((e) => e.text.includes('空闲超时已推迟')).length, 0);
});

test('M1：门控与通道无关，且非 env 通道在无工具调用时行为不变', async () => {
  const channels = ['main', 'env', 'codeverify', 'remoteverify', 'subagent'] as const;
  for (const channel of channels) {
    const f = fixture({ channel, settleMs: 70, idleMs: 0, hardMs: 0, terminator: stoppedTerminator() });
    f.guard.markSpawned(f.child);
    // 无工具调用：与基线一致
    f.guard.noteSessionEnd();
    const r0 = await f.guard.done;
    assert.equal(r0.facts.terminal, 'settle_grace', `${channel} 无工具调用时行为不变`);
    assert.equal(r0.openToolCallsAtSettle, 0);

    // 有未闭合工具：同样被推迟（门控是通道无关的纯事实）
    const g = fixture({ channel, settleMs: 70, idleMs: 0, hardMs: 0, terminator: stoppedTerminator() });
    g.guard.markSpawned(g.child);
    g.guard.noteToolCalls(1);
    g.guard.noteSessionEnd();
    await sleep(150);
    assert.equal(g.guard.settled, false, `${channel} 有未闭合工具时被推迟`);
    g.guard.noteToolCalls(0);
    const r1 = await g.guard.done;
    assert.equal(r1.facts.terminal, 'settle_grace');
  }
});

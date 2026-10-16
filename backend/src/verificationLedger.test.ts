/**
 * M-A / M-B 隔离测试：验证账本「环境阻断收尾」与远程验证入队拒绝原因。
 *
 * 约定：
 * - 全部夹具写入都放在 `db.transaction()` 内并**主动回滚**（抛 ROLLBACK 标记），
 *   因此不向数据库留下任何数据；本项目单测运行在隔离沙箱（data/ 随沙箱目录），
 *   绝不触碰生产 code.db。
 * - **不启动 Pi、不跑真实审计/验证、不调用任何真实写接口**。
 * - 只依赖同步的纯库层函数；不触碰内存队列（因此不会意外调度真实任务）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import db from './db';
import { getProject } from './projectsService';
import {
  VERIFY_WORKSPACE_MISSING_MESSAGE,
  enqueueVerify,
  enqueueVerifyDetailed,
  enqueueVerifyOne,
  explainVerifyEnqueueBlock,
  markVerificationItemsEnvBlocked,
  recoverPendingVerifyOneJobs,
  requeueStaleVerifyJobs,
} from './runner';
import {
  ensureProjectVerificationItems,
  getProjectVerificationProgress,
  listProjectVerificationItems,
  setVerificationItemState,
  syncProjectVerificationItems,
} from './verificationStore';

const ROLLBACK = Symbol('rollback-test');
const ENV_BLOCK_REASON = '靶机环境搭建失败，远程验证未执行';

/** 在「写后被回滚」的事务里跑夹具断言：断言失败同样会触发回滚并向上抛出。 */
function runInRollback(body: () => void): void {
  try {
    db.transaction(() => {
      body();
      throw ROLLBACK;
    })();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`;
}

function insertProject(
  projectId: string,
  opts: {
    status?: string;
    verify_status?: string;
    env_status?: string;
    workspace_path?: string | null;
  } = {}
): void {
  db.prepare(
    `INSERT INTO projects
       (id, project_name, archive_name, source_type, source_ref, workspace_path,
        status, verify_status, env_status, has_web, created_at)
     VALUES (?, ?, '', 'github', 'https://example.test/ledger.git', ?,
             ?, ?, ?, 1, ?)`
  ).run(
    projectId,
    projectId,
    opts.workspace_path ?? null,
    opts.status ?? 'completed',
    opts.verify_status ?? 'failed',
    opts.env_status ?? 'failed',
    Date.now()
  );
}

function insertVuln(projectId: string, id: string, severity: string, title: string): void {
  db.prepare(
    `INSERT INTO vulnerabilities
       (id, project_id, title, severity, category, file_path, line, description,
        recommendation, code_snippet, taint_chain, created_at, verified)
     VALUES (?, ?, ?, ?, 'test', 'a.php', 1, 'desc', '', '', '', ?, 0)`
  ).run(id, projectId, title, severity, Date.now());
}

/** 建 1 high + 2 medium（入账本）+ 1 low（不入账本）的标准夹具。 */
function seedProject(projectId: string): { chm: string[]; low: string } {
  const chm = [`v_${projectId}_h`, `v_${projectId}_m1`, `v_${projectId}_m2`];
  insertVuln(projectId, chm[0], 'high', 'high finding');
  insertVuln(projectId, chm[1], 'medium', 'medium finding 1');
  insertVuln(projectId, chm[2], 'medium', 'medium finding 2');
  const low = `v_${projectId}_low`;
  insertVuln(projectId, low, 'low', 'low finding');
  return { chm, low };
}

function itemStates(projectId: string): Map<string, any> {
  const items = listProjectVerificationItems(projectId) as any[];
  return new Map(items.map((item) => [item.vulnerability_id, item]));
}

/* ------------------------------- M-A ------------------------------- */

test('M-A：环境失败收尾把 pending 账本流转为 restricted，且不动漏洞发现本身', () => {
  const projectId = uid('p_ledger_block');
  runInRollback(() => {
    insertProject(projectId);
    const { chm, low } = seedProject(projectId);
    assert.equal(listProjectVerificationItems(projectId).length, 0, '收尾前尚无账本行');

    const changed = markVerificationItemsEnvBlocked(projectId, ENV_BLOCK_REASON);
    assert.equal(changed, 3, '只流转 严重/高危/中危 的 3 条');

    const items = itemStates(projectId);
    assert.equal(items.size, 3, '低危不进入账本');
    assert.equal(items.has(low), false);
    for (const id of chm) {
      const item = items.get(id);
      assert.equal(item.state, 'restricted', `${id} → restricted`);
      assert.equal(item.remote_status, 'restricted', 'remote_status 不是 success');
      assert.equal(item.error, ENV_BLOCK_REASON, '原因写明环境失败、远程验证未执行');
      assert.equal(item.attempt_count, 0, '从未尝试 ⇒ attempt_count 保持 0');
      assert.equal(item.queued_at, null, '没有被排队');
      assert.ok(item.finished_at, '终态写 finished_at');
    }

    // 漏洞发现本身（名称/等级/verified）不受影响
    const vulns = db
      .prepare('SELECT id, title, severity, verified FROM vulnerabilities WHERE project_id = ?')
      .all(projectId) as any[];
    assert.equal(vulns.length, 4, '漏洞发现一条都没被删除');
    assert.equal(vulns.every((v) => v.verified === 0), true, '漏洞不会被标成"已验证"');
    assert.equal(
      (db.prepare('SELECT severity FROM vulnerabilities WHERE id = ?').get(low) as any).severity,
      'low'
    );
  });
});

test('M-A：重复收尾幂等 —— 不二次流转、不增加 attempt_count、不重复排队', () => {
  const projectId = uid('p_ledger_idem');
  runInRollback(() => {
    insertProject(projectId);
    seedProject(projectId);

    assert.equal(markVerificationItemsEnvBlocked(projectId, ENV_BLOCK_REASON), 3);
    const first = itemStates(projectId);
    const stamps = new Map([...first].map(([id, item]) => [id, item.updated_at]));

    // 第二次（换一条原因文案）：必须一条都不再流转，既有原因也不被改写
    assert.equal(markVerificationItemsEnvBlocked(projectId, '第二次收尾（应为 no-op）'), 0);

    const second = itemStates(projectId);
    for (const [id, item] of second) {
      assert.equal(item.state, 'restricted');
      assert.equal(item.error, ENV_BLOCK_REASON, '既有原因不被覆盖');
      assert.equal(item.updated_at, stamps.get(id), '没有产生第二次写入');
      assert.equal(item.attempt_count, 0, 'attempt_count 不增加');
      assert.equal(item.queued_at, null, '不会重复排队');
    }
    assert.equal(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM vulnerability_verifications
              WHERE project_id = ? AND state IN ('queued','running')`
          )
          .get(projectId) as any
      ).c,
      0,
      '收尾后不留 queued/running（避免被当成"验证中"或被恢复器重复入队）'
    );
  });
});

test('M-A：已有终态（success / failed / timeout）一律不被覆盖', () => {
  const projectId = uid('p_ledger_terminal');
  runInRollback(() => {
    insertProject(projectId);
    const { chm } = seedProject(projectId);
    ensureProjectVerificationItems(projectId); // 建行（等价于审计收尾时的建账）
    setVerificationItemState(projectId, chm[0], 'success');
    setVerificationItemState(projectId, chm[1], 'failed', '原有失败结论');
    setVerificationItemState(projectId, chm[2], 'timeout', '原有超时结论');

    assert.equal(markVerificationItemsEnvBlocked(projectId, ENV_BLOCK_REASON), 0, '没有可流转的条目');

    const items = itemStates(projectId);
    assert.equal(items.get(chm[0]).state, 'success', '成功的结论不被冲掉');
    assert.equal(items.get(chm[1]).state, 'failed', '失败的结论不被改写');
    assert.equal(items.get(chm[1]).error, '原有失败结论', '失败原因不被改写');
    assert.equal(items.get(chm[2]).state, 'timeout', '超时结论不被改写');
    assert.equal(items.get(chm[2]).error, '原有超时结论');
  });
});

test('M-A：残留的 queued/running 也会被归入 restricted（不会一直显示"验证中"）', () => {
  const projectId = uid('p_ledger_stale');
  runInRollback(() => {
    insertProject(projectId);
    const { chm } = seedProject(projectId);
    ensureProjectVerificationItems(projectId);
    setVerificationItemState(projectId, chm[0], 'queued');
    setVerificationItemState(projectId, chm[1], 'running');

    assert.equal(markVerificationItemsEnvBlocked(projectId, ENV_BLOCK_REASON), 3);
    const items = itemStates(projectId);
    for (const id of chm) assert.equal(items.get(id).state, 'restricted');
    assert.ok(items.get(chm[0]).attempt_count >= 1, '曾经的排队记录保留（不被清零）');
  });
});

test('M-A：全部 restricted 时进度为 concluded、pending=0', () => {
  const projectId = uid('p_ledger_progress');
  runInRollback(() => {
    insertProject(projectId);
    seedProject(projectId);
    markVerificationItemsEnvBlocked(projectId, ENV_BLOCK_REASON);
    assert.deepEqual(getProjectVerificationProgress(projectId), {
      total: 3,
      pending: 0,
      queued: 0,
      running: 0,
      success: 0,
      restricted: 3,
      failed: 0,
      timeout: 0,
      concluded: 3,
    });
  });
});

test('M-A：收尾不改项目级 verify_status 与原有错误记录', () => {
  const projectId = uid('p_ledger_project');
  runInRollback(() => {
    // 复刻项目级 env 失败现场：项目级已判 failed 并带原有错误文案
    insertProject(projectId, { verify_status: 'failed', env_status: 'failed' });
    db.prepare('UPDATE projects SET verify_error = ? WHERE id = ?').run(
      '靶机环境搭建失败，未进行远程验证',
      projectId
    );
    seedProject(projectId);

    markVerificationItemsEnvBlocked(projectId, ENV_BLOCK_REASON);

    const project = getProject(projectId)!;
    assert.equal(project.verify_status, 'failed', '项目级状态保持 failed');
    assert.equal(project.env_status, 'failed');
    assert.equal(
      (project as any).verify_error,
      '靶机环境搭建失败，未进行远程验证',
      '原有项目级错误记录一字不改'
    );
  });
});

/* ------------------------------- M-B ------------------------------- */

test('M-B：工作区/源码包缺失时 /verify 返回明确原因，而非"已在运行或排队中"', () => {
  const projectId = uid('p_reject_ws');
  runInRollback(() => {
    // 复刻项目清理后的失败现场：审计完成、验证 failed、源码与工作区已被清理
    insertProject(projectId, { verify_status: 'failed', env_status: 'failed', workspace_path: null });
    seedProject(projectId);

    const outcome = enqueueVerifyDetailed(projectId);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, 'workspace_missing');
    assert.equal(outcome.status, 409);
    assert.equal(outcome.message, VERIFY_WORKSPACE_MISSING_MESSAGE);
    assert.match(outcome.message, /源码包/, '文案必须指向"重新上传源码包"这一真实出路');
    assert.doesNotMatch(
      outcome.message,
      /验证已在进行中或排队中/,
      '不得把工作区缺失误报成"已在运行或排队中"'
    );

    // 布尔入口与结构化入口判定一致（重构未改变原有拒绝行为）
    assert.equal(enqueueVerify(projectId), false);

    // 门控的结构化副作用：env 标 failed，且事件落在 verify 阶段（不再混进 audit）
    const project = getProject(projectId)!;
    assert.equal(project.env_status, 'failed');
    assert.equal(project.verify_status, 'failed', '拒绝入队不得改动项目级验证状态');
    const ev = db
      .prepare(
        `SELECT phase, kind, text FROM agent_events
          WHERE project_id = ? AND text LIKE '%拒绝远程验证%'
          ORDER BY ts DESC LIMIT 1`
      )
      .get(projectId) as { phase: string; kind: string; text: string } | undefined;
    assert.ok(ev, '必须留下可诊断事件');
    assert.equal(ev!.phase, 'verify');
    assert.equal(ev!.kind, 'error');
  });
});

test('M-B：只读解释零副作用（不重复落事件、不改状态、不入队）', () => {
  const projectId = uid('p_explain_silent');
  runInRollback(() => {
    insertProject(projectId, { verify_status: 'failed', env_status: 'failed', workspace_path: null });
    seedProject(projectId);
    const eventsOf = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM agent_events
              WHERE project_id = ? AND text LIKE '%拒绝远程验证%'`
          )
          .get(projectId) as any
      ).c;

    for (let i = 0; i < 3; i += 1) {
      const rejection = explainVerifyEnqueueBlock(projectId);
      assert.equal(rejection?.code, 'workspace_missing');
      assert.equal(rejection?.status, 409);
    }
    assert.equal(eventsOf(), 0, '只读解释不得写任何事件');

    // 真正尝试入队才会落一条事件（且仅一条）
    assert.equal(enqueueVerifyDetailed(projectId).ok, false);
    assert.equal(eventsOf(), 1);
    assert.equal(getProject(projectId)!.verify_status, 'failed');
  });
});

test('M-B：审计未完成 / 项目不存在 / 非 Web-only 各自返回准确原因', () => {
  const cursorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cursor-'));
  try {
    runInRollback(() => {
      // a) 项目不存在
      const missing = enqueueVerifyDetailed(uid('p_absent'));
      assert.equal(missing.ok, false);
      if (!missing.ok) {
        assert.equal(missing.code, 'not_found');
        assert.equal(missing.status, 404);
      }

      // b) 审计未完成（即便工作区缺失，也必须先报"未完成审计"）
      const running = uid('p_running_audit');
      insertProject(running, { status: 'running', verify_status: 'none', env_status: 'none' });
      const r1 = enqueueVerifyDetailed(running);
      assert.equal(r1.ok, false);
      if (!r1.ok) {
        assert.equal(r1.code, 'not_completed');
        assert.equal(r1.status, 400);
      }

      // c) Cursor 编排托管（shouldRemoteVerify=false）→ 不满足远程验证条件
      fs.mkdirSync(path.join(cursorDir, '_cursor_verify'), { recursive: true });
      fs.writeFileSync(path.join(cursorDir, '_cursor_verify', 'CURSOR_ONLY.json'), '{}', 'utf8');
      const cursor = uid('p_cursor_managed');
      insertProject(cursor, { workspace_path: cursorDir, verify_status: 'none', env_status: 'none' });
      const r2 = enqueueVerifyDetailed(cursor);
      assert.equal(r2.ok, false);
      if (!r2.ok) {
        assert.equal(r2.code, 'not_web_only');
        assert.equal(r2.status, 409);
        assert.doesNotMatch(r2.message, /验证已在进行中或排队中/);
      }
    });
  } finally {
    fs.rmSync(cursorDir, { recursive: true, force: true });
  }
});

test('M-B：单漏洞入口在拒绝时给出可读原因（不再静默失败）', () => {
  const projectId = uid('p_one_reason');
  runInRollback(() => {
    insertProject(projectId, { verify_status: 'failed', env_status: 'failed', workspace_path: null });
    seedProject(projectId);
    const outcome = enqueueVerifyOne(projectId, 'high finding');
    assert.equal(outcome.queued, false);
    assert.equal(outcome.pending, false);
    assert.equal(outcome.reason, VERIFY_WORKSPACE_MISSING_MESSAGE);
  });
});

/* --------------- M-A 补齐：!isTargetFullyReady / doVerifyChain --------------- */

test('M-A 补齐：组合链路径只收尾"尚无结论"的相关条目，终态一律保留', () => {
  const projectId = uid('p_chain_block');
  runInRollback(() => {
    insertProject(projectId, { verify_status: 'failed', env_status: 'failed' });
    const { chm } = seedProject(projectId);
    ensureProjectVerificationItems(projectId);
    // 场景：早前的单漏洞验证已把 1 条做成 success、1 条做成 failed，只剩 1 条无结论
    setVerificationItemState(projectId, chm[0], 'success');
    setVerificationItemState(projectId, chm[1], 'failed', '早前实测未命中');

    const changed = markVerificationItemsEnvBlocked(
      projectId,
      '靶机环境未就绪，组合链验证未执行：靶机未就绪'
    );
    assert.equal(changed, 1, '只有"尚无结论"的那 1 条被收尾');

    const items = itemStates(projectId);
    assert.equal(items.get(chm[0]).state, 'success', '已有成功不被覆盖');
    assert.equal(items.get(chm[1]).state, 'failed', '已有失败不被覆盖');
    assert.equal(items.get(chm[2]).state, 'restricted');
    assert.match(items.get(chm[2]).error, /组合链验证未执行/);

    // 组合链模式收尾后，项目级状态语义不变
    assert.equal(getProject(projectId)!.verify_status, 'failed');
    // 进度：2 条终态 + 1 条受限 ⇒ 无 pending
    assert.deepEqual(getProjectVerificationProgress(projectId), {
      total: 3,
      pending: 0,
      queued: 0,
      running: 0,
      success: 1,
      restricted: 1,
      failed: 1,
      timeout: 0,
      concluded: 3,
    });
  });
});

test('M-A 补齐：不同阻断来源写入不同原因（可区分"未真实就绪"与"组合链未执行"）', () => {
  const projectId = uid('p_reason_variants');
  runInRollback(() => {
    insertProject(projectId);
    const { chm } = seedProject(projectId);
    markVerificationItemsEnvBlocked(
      projectId,
      '靶机尚未真实就绪，远程验证未执行：靶机尚未真实就绪（容器未运行或 HTTP 地址不可达），请稍后重试或检查 Docker'
    );
    const items = itemStates(projectId);
    for (const id of chm) assert.match(items.get(id).error, /靶机尚未真实就绪，远程验证未执行：/);
    // 已 restricted 的条目不会被第二次（换原因）改写
    assert.equal(markVerificationItemsEnvBlocked(projectId, '靶机环境未就绪，组合链验证未执行：x'), 0);
    for (const id of chm) assert.match(items.get(id).error, /靶机尚未真实就绪/);
  });
});

test('M-A 补齐：doVerifyChain !isTargetFullyReady 的阻断原因独立可辨、且幂等', () => {
  const projectId = uid('p_chain_notready');
  runInRollback(() => {
    insertProject(projectId);
    const { chm } = seedProject(projectId);
    const reason = '靶机尚未真实就绪，组合链验证未执行：靶机尚未真实就绪（容器未运行或 HTTP 地址不可达），请稍后重试或检查 Docker';
    assert.equal(markVerificationItemsEnvBlocked(projectId, reason), 3);
    const items = itemStates(projectId);
    for (const id of chm) {
      assert.equal(items.get(id).state, 'restricted');
      assert.equal(items.get(id).error, reason, '组合链·未真实就绪 的原因原文入账');
      assert.equal(items.get(id).attempt_count, 0);
    }
    // 幂等：重复调用（含同分支重入）不再流转、不增加 attempt_count
    assert.equal(markVerificationItemsEnvBlocked(projectId, reason), 0);
    for (const id of chm) assert.equal(items.get(id).attempt_count, 0);
    // 项目级状态不受收尾函数影响
    assert.equal(getProject(projectId)!.verify_status, 'failed');
  });
});

test('M-A 补齐 §5：restricted 终态不会被后续报告同步打回 pending', () => {
  const projectId = uid('p_no_regress');
  runInRollback(() => {
    insertProject(projectId);
    const { chm } = seedProject(projectId);
    markVerificationItemsEnvBlocked(projectId, ENV_BLOCK_REASON);
    assert.equal(itemStates(projectId).get(chm[0]).state, 'restricted');

    // 模拟后续一次 exploit_report 同步：给出的条目是 unknown（无有效结论）
    const progress = syncProjectVerificationItems(
      projectId,
      [{ vulnerability: 'high finding', local_exploitable: 'unknown' }],
      'test-unknown-sync'
    );
    assert.equal(itemStates(projectId).get(chm[0]).state, 'restricted', '终态护栏生效，不被 unknown 打回 pending');
    assert.equal(progress.pending, 0);
    assert.equal(progress.restricted, 3);
  });
});

test('M-A 补齐 §6：收尾后不存在能把受限记录重新置为 running 的遗留队列项', () => {
  const projectId = uid('p_no_residual');
  runInRollback(() => {
    insertProject(projectId, { verify_status: 'failed', env_status: 'failed', workspace_path: null });
    const { chm } = seedProject(projectId);
    ensureProjectVerificationItems(projectId);
    setVerificationItemState(projectId, chm[0], 'queued');
    setVerificationItemState(projectId, chm[1], 'running');
    markVerificationItemsEnvBlocked(projectId, ENV_BLOCK_REASON);

    // 隔离前提：沙箱库里不应有别的 queued/running 账本行（否则恢复器可能真的入队）
    assert.equal(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM vulnerability_verifications WHERE state IN ('queued','running')`
          )
          .get() as any
      ).c,
      0,
      '隔离前提：不得存在 queued/running 账本行'
    );

    // 两个"持久化恢复器"都看不到 restricted 行 ⇒ 不可能把受限记录重新入队/置 running
    assert.equal(recoverPendingVerifyOneJobs(), 0, '单漏洞等待队列恢复器不得复活受限记录');
    assert.equal(requeueStaleVerifyJobs(), 0, 'stale queued 恢复器不得复活受限记录');

    const items = itemStates(projectId);
    for (const id of chm) assert.equal(items.get(id).state, 'restricted');
    assert.equal(getProject(projectId)!.verify_status, 'failed', '不会被恢复器改成 queued');
  });
});

/* ------------------------- 结构不变式（静态） ------------------------- */

test('M-B 结构不变式：入队拒绝条件与改造前同序同条件，且误导文案已移除', () => {
  const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf8');
  const start = src.indexOf('function verifyEnqueueRejection(');
  const end = src.indexOf('function pushVerifyJob(');
  assert.ok(start > 0 && end > start, '必须存在 verifyEnqueueRejection（入队前置条件判定）');
  const block = src.slice(start, end);

  // 原有关键条件一个都不能少：忙碌/已排队仍按"内存真相"判定（刻意不引入 DB verify_status 判定，
  // 否则会打断 restartVerify 的重排与启动期孤儿恢复这类"DB 状态仍为 running/queued 的合法重入队"）
  assert.match(block, /isBusy\(projectId\)/);
  assert.match(block, /queue\.some\(/);
  assert.match(block, /verifyWorkspaceReady\(projectId, \{ silent: opts\.silentGate === true \}\)/);
  assert.match(block, /shouldRemoteVerify\(projectId\)/);
  // 原门控函数与其 6 处调用方保持不变（只是内部转调 verifyWorkspaceReady）
  assert.match(src, /function strictVerifyQueueGate\(projectId: string, resetQueued = false\): boolean \{/);
  assert.match(src, /return verifyWorkspaceReady\(projectId, \{ resetQueued \}\);/);
  assert.match(block, /p\.status === 'completed'/, '完整验证仍要求审计完成');
  assert.match(block, /hasAuditForChain\(p\)/, '组合链入口沿用原有前置判定');
  // 结构化标签齐备
  for (const code of [
    'not_found',
    'not_completed',
    'not_web_only',
    'already_running',
    'already_queued',
    'workspace_missing',
  ]) {
    assert.ok(block.includes(`'${code}'`), `拒绝原因必须包含 ${code}`);
  }
  // 已运行 / 已排队 的标签分别挂在 isBusy / queue 判定上
  assert.match(block, /isBusy\(projectId\)\)\s*\{[\s\S]{0,200}'already_running'/);
  assert.match(block, /queue\.some\(\(j\) => j\.id === projectId\)\)\s*\{[\s\S]{0,200}'already_queued'/);
});

test('M-A 结构不变式：两条环境失败收尾路径都接上了逐漏洞账本', () => {
  const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf8');

  // 路径 1：审计完成后因 env=failed 跳过远程验证
  assert.match(src, /verify_error: '靶机环境搭建失败，未进行远程验证'/, '项目级错误记录保持不变');
  assert.match(
    src,
    /markVerificationItemsEnvBlocked\(\s*job\.id,\s*'靶机环境搭建失败，远程验证未执行'\s*\)/,
    '跳过远程验证的分支必须收尾账本'
  );

  // 路径 2：doVerify 中 ensureTargetUp 失败
  assert.match(
    src,
    /markVerificationItemsEnvBlocked\(\s*projectId,\s*`靶机环境未就绪，远程验证未执行：\$\{reason\}`\s*\)/,
    'ensureTargetUp 失败分支必须收尾账本'
  );

  // 账本收尾只能落在"非终态"条目上（success 等终态必须被保留）
  assert.match(src, /TERMINAL_VERIFICATION_STATES\.has\(row\.state\)/);
  // 工作区缺失事件必须归到 verify 阶段（此前误落在 audit）
  assert.match(
    src,
    /'⛔ 拒绝远程验证：工作区\/源码包已不存在，无法重建靶机环境',[\s\S]{0,60}?'verify'/,
    '工作区缺失事件必须记录在 verify 阶段'
  );
});

test('M-B 结构不变式：三个验证入口都按结构化原因返回，工作区缺失不再被误报', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes.ts'), 'utf8');

  // /verify：直接走结构化入队
  assert.match(routes, /enqueueVerifyDetailed\(req\.params\.id\)/, '/verify 必须走结构化入队');
  assert.match(
    routes,
    /res\.status\(outcome\.status\)\.json\(\{ error: outcome\.message, code: outcome\.code \}\)/
  );

  // /reverify 与 /resume：失败后先用只读解释拿到准确原因
  const reverify = routes.slice(routes.indexOf("'/projects/:id/reverify'"));
  assert.match(
    reverify.slice(0, 900),
    /explainVerifyEnqueueBlock\(req\.params\.id\)/,
    '/reverify 失败时必须先解释真实原因'
  );
  const resume = routes.slice(routes.indexOf("'/projects/:id/resume'"));
  assert.match(
    resume.slice(0, 900),
    /explainVerifyEnqueueBlock\(req\.params\.id\)/,
    '/resume 失败时必须先解释真实原因'
  );

  // "工作区缺失"必须是结构化解释给出的，而不是靠解析错误文案
  assert.match(routes, /explainVerifyEnqueueBlock,/, '必须导入只读解释函数');
  const runnerSrc = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf8');
  assert.match(
    runnerSrc,
    /export function explainVerifyEnqueueBlock\([\s\S]{0,400}?silentGate: true/,
    '解释函数必须走 silent 门控（零副作用）'
  );
});

test('M-A 补齐 结构不变式：两个遗漏分支都已接线，且项目级文案保持不变', () => {
  const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf8');

  // 分支 1：doVerify 的 !isTargetFullyReady
  assert.match(
    src,
    /markVerificationItemsEnvBlocked\(\s*projectId,\s*`靶机尚未真实就绪，远程验证未执行：\$\{notReadyReason\}`\s*\)/,
    '!isTargetFullyReady 分支必须收尾账本'
  );
  // 分支 2：doVerifyChain 的 !targetUp
  assert.match(
    src,
    /markVerificationItemsEnvBlocked\(\s*projectId,\s*`靶机环境未就绪，组合链验证未执行：\$\{reason\}`\s*\)/,
    'doVerifyChain 的 !targetUp 分支必须收尾账本'
  );
  // 分支 3（本轮补齐）：doVerifyChain 的 !isTargetFullyReady
  assert.match(
    src,
    /markVerificationItemsEnvBlocked\(\s*projectId,\s*`靶机尚未真实就绪，组合链验证未执行：\$\{notReadyReason\}`\s*\)/,
    'doVerifyChain 的 !isTargetFullyReady 分支必须收尾账本'
  );
  // 两处 finishVerify 的原有文案一字未改
  assert.match(src, /: '靶机尚未真实就绪（容器未运行或 HTTP 地址不可达），请稍后重试或检查 Docker'/);
  assert.match(src, /'外部靶机尚未可达（mode=external），请由 Cursor Agent 重新拉起后再续跑'/);
  // 5 条 M-A 收尾路径共用同一实现
  assert.equal(
    (src.match(/markVerificationItemsEnvBlocked\(/g) || []).length,
    6,
    '应为 1 处定义 + 5 处调用'
  );
});

test('M-A 补齐 结构不变式：不存在能把受限记录重新置为 running 的调度残留', () => {
  const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf8');

  // 全仓唯一把账本写回 'running' 的位置就是 doVerifyOne 的开头（只由显式单漏洞验证触发）
  const runningWrites = src.match(/setVerificationItemState\([^)]*'running'/g) || [];
  assert.equal(runningWrites.length, 1, "只有一处写 'running'");
  const doVerifyOneStart = src.indexOf('async function doVerifyOne(');
  const doVerifyOneEnd = src.indexOf('async function doVerify(');
  assert.ok(doVerifyOneStart > 0 && doVerifyOneStart < doVerifyOneEnd);
  assert.ok(
    src.indexOf("setVerificationItemState(projectId, vuln.id, 'running')") > doVerifyOneStart &&
      src.indexOf("setVerificationItemState(projectId, vuln.id, 'running')") < doVerifyOneEnd,
    '唯一的 running 写入点在 doVerifyOne 内'
  );

  // 调度器在真正启动 verify/verifyone 之前会再查一次门控，不满足即把该队列项**摘除**
  assert.match(
    src,
    /\(job\.kind === 'verify' \|\| job\.kind === 'verifyone'\) && p\.verify_status !== 'queued'\) continue;/,
    '队列项必须与 verify_status=queued 对齐'
  );
  assert.match(
    src,
    /if \(provenanceRequiredNow && !strictVerifyQueueGate\(job\.id, true\)\) \{\s*\n\s*queue\.splice\(i, 1\)/,
    '启动前门控不过 ⇒ 直接从队列摘除（工作区缺失的项目不会被调度）'
  );

  // 两个持久化恢复器只认 queued/running（restricted 天然不可见）
  assert.match(
    src,
    /WHERE p\.status = 'completed' AND vv\.state IN \('queued','running'\)/,
    '单漏洞等待队列恢复器只认 queued/running'
  );
  assert.match(
    src,
    /SELECT id FROM projects WHERE status = 'completed' AND verify_status = 'queued'/,
    'stale queued 恢复器只认 verify_status=queued'
  );
});

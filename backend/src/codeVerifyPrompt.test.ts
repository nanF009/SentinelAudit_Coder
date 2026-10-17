/**
 * 代码级验证提示词静态断言：确保 design_decision 的收紧约束确实存在于
 * 实际生效的 buildCodeVerifyWorkerPrompt 中（不启动 Pi / 不调用模型）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodeVerifyWorkerPrompt } from './schema';

function buildPrompt(): string {
  return buildCodeVerifyWorkerPrompt('/tmp/probe', '/tmp/group.json', '/tmp/out.json', 3, 1, 2);
}

test('code verify prompt：design_decision 定义已收紧为"须有依据认为无真实安全影响"', () => {
  const p = buildPrompt();
  assert.match(p, /design_decision/);
  assert.match(p, /仅当有依据认为该功能不构成任何真实安全影响/);
  assert.match(p, /"有意设计的功能"本身不等于"安全"/);
});

test('code verify prompt：前置条件（权限/确认/配置/上传/安装/模板）不能证明安全', () => {
  const p = buildPrompt();
  assert.match(
    p,
    /严禁仅因"需要管理员权限 \/ 用户主动确认 \/ 需特定配置 \/ 属于上传·安装·模板导入功能"就判 design_decision/
  );
  assert.match(p, /本身不能证明功能安全/);
});

test('code verify prompt：design_decision 仅限"确认不存在真实安全后果"', () => {
  const p = buildPrompt();
  assert.match(p, /design_decision 只用于"确认不存在真实安全后果"的场景/);
  assert.match(p, /不得因"这是有意设计的功能"就判 design_decision/);
});

test('code verify prompt：判定必须有代码依据，不得仅凭不确定性认定漏洞', () => {
  const p = buildPrompt();
  assert.match(p, /判定必须有代码依据/);
  assert.match(p, /不得仅凭"拿不准"就认定/);
  assert.match(p, /核实后仍无法判断的/);
  assert.match(p, /保守归 conditional/);
});

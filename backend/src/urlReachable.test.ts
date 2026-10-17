/**
 * urlReachable / anyTargetUrlReachable 的 HTTP 行为测试。
 *
 * 只依赖本地临时 HTTP server，不触碰公网、真实靶场或 Docker。
 * import './runner' 会初始化 db（在隔离沙箱 data/ 下），与 verificationLedger.test.ts 同理。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anyTargetUrlReachable, urlReachable } from './runner';

interface ProbeServer {
  port: number;
  close: () => Promise<void>;
}

/** 起一个本地 HTTP server，对每个请求返回指定状态码。 */
function startStatusServer(statusCode: number): Promise<ProbeServer> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = statusCode;
      res.end('probe');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** 起一个「接受连接但永不响应」的 server，用于验证超时。 */
function startHangingServer(): Promise<ProbeServer> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, _res) => {
      /* 故意不写响应，让客户端等待超时 */
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function probeUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** 向临时目录写 TARGET_ENV.json，供 collectTargetProbeUrls 收集多个探测 URL。 */
function writeTargetEnv(
  dir: string,
  fields: { url?: string; login_url?: string; proofTarget?: string }
): void {
  const env: Record<string, unknown> = { mode: 'web' };
  if (fields.url) env.url = fields.url;
  if (fields.login_url) env.login_url = fields.login_url;
  if (fields.proofTarget) {
    env.runtime_version_proof = { type: 'http', target: fields.proofTarget, contains: 'v1' };
  }
  fs.writeFileSync(path.join(dir, 'TARGET_ENV.json'), JSON.stringify(env));
}

test('urlReachable：2xx/3xx/401/403 在默认与严格模式下均可达', async () => {
  for (const code of [200, 204, 302, 401, 403]) {
    const s = await startStatusServer(code);
    assert.equal(await urlReachable(probeUrl(s.port)), true, `${code} 默认模式应可达`);
    assert.equal(
      await urlReachable(probeUrl(s.port), 8000, { reject5xx: true }),
      true,
      `${code} 严格模式应可达`
    );
    await s.close();
  }
});

test('urlReachable：5xx 默认保持旧行为（可达），严格模式不可达', async () => {
  for (const code of [500, 502, 503]) {
    const s = await startStatusServer(code);
    assert.equal(await urlReachable(probeUrl(s.port)), true, `${code} 默认模式应可达（旧行为）`);
    assert.equal(
      await urlReachable(probeUrl(s.port), 8000, { reject5xx: true }),
      false,
      `${code} 严格模式应不可达`
    );
    await s.close();
  }
});

test('urlReachable：连接失败（端口未监听）不可达', async () => {
  // 先占用一个端口再关闭，拿到一个「大概率未监听」的端口
  const s = await startStatusServer(200);
  const port = s.port;
  await s.close();
  assert.equal(await urlReachable(probeUrl(port)), false, '连接失败应不可达');
  assert.equal(
    await urlReachable(probeUrl(port), 8000, { reject5xx: true }),
    false,
    '严格模式连接失败同样不可达'
  );
});

test('urlReachable：请求超时不可达', async () => {
  const s = await startHangingServer();
  assert.equal(await urlReachable(probeUrl(s.port), 400), false, '超时应不可达');
  await s.close();
});

test('anyTargetUrlReachable：一个 500 + 一个 200，严格模式应通过（5xx 不抢先）', async () => {
  const s500 = await startStatusServer(500);
  const s200 = await startStatusServer(200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  try {
    // proof 端点 500、主 url 200 → 探测顺序含 500 在前，仍应通过 200
    writeTargetEnv(dir, { url: probeUrl(s200.port), proofTarget: probeUrl(s500.port) });
    const hit = await anyTargetUrlReachable('p_probe_multi', dir, { reject5xx: true });
    assert.equal(hit, probeUrl(s200.port), '严格模式应返回 200 的 URL，而非 500');
  } finally {
    await s500.close();
    await s200.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('anyTargetUrlReachable：一个连接失败 + 一个 200，应能通过', async () => {
  const s200 = await startStatusServer(200);
  const dead = await startStatusServer(200);
  const deadPort = dead.port;
  await dead.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  try {
    writeTargetEnv(dir, { url: probeUrl(s200.port), login_url: probeUrl(deadPort) });
    const hit = await anyTargetUrlReachable('p_probe_dead', dir, { reject5xx: true });
    assert.equal(hit, probeUrl(s200.port), '连接失败的 URL 不应拖垮整组探测');
  } finally {
    await s200.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('anyTargetUrlReachable：默认模式仍把 500 视为可达（旧行为）', async () => {
  const s500 = await startStatusServer(500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  try {
    writeTargetEnv(dir, { url: probeUrl(s500.port) });
    const hit = await anyTargetUrlReachable('p_probe_legacy', dir);
    assert.equal(hit, probeUrl(s500.port), '默认模式 500 仍可达（向后兼容）');
  } finally {
    await s500.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

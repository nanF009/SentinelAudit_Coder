import db from './db';
import type { Vulnerability } from './types';
import { deriveRemoteStatus } from './verificationStatus';

const SEV_LABEL: Record<string, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '提示',
};

const AUTH_LABEL: Record<string, string> = {
  none: '无需登录',
  user: '需登录（普通用户）',
  admin: '需管理员',
};

function norm(s: string): string {
  return String(s || '')
    .replace(/\\([_*`[\]()#+\-.!|{}])/g, '$1')
    .replace(/['"“”‘’]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function matchExploit(title: string, reportJson: string | null): any | null {
  if (!reportJson) return null;
  let report: any;
  try {
    report = JSON.parse(reportJson);
  } catch {
    return null;
  }
  const exploits: any[] = Array.isArray(report?.exploits) ? report.exploits : [];
  const nt = norm(title);
  for (const ex of exploits) {
    const en = norm(ex?.vulnerability || '');
    if (!en) continue;
    if (en === nt || en.includes(nt) || nt.includes(en.slice(0, Math.min(en.length, 12)))) return ex;
  }
  return null;
}

function findVuln(projectId: string, title: string) {
  const rows = db
    .prepare(
      `SELECT v.*, p.project_name, p.system_name, p.source_version, p.target_url, p.exploit_report
       FROM vulnerabilities v JOIN projects p ON p.id = v.project_id
       WHERE v.project_id = ?`
    )
    .all(projectId) as (Vulnerability & {
    project_name?: string;
    system_name?: string | null;
    source_version?: string | null;
    target_url?: string | null;
    exploit_report?: string | null;
  })[];
  const nt = norm(title);
  return (
    rows.find((v) => {
      const vt = norm(v.title);
      return vt === nt || vt.includes(nt) || nt.includes(vt);
    }) || null
  );
}

/** 解析项目内漏洞标题（用于下载文件名等）。 */
export function resolveVulnTitle(projectId: string, title: string): string | null {
  return findVuln(projectId, title)?.title ?? null;
}

/** 从 exploit_report 提取单漏洞 POC 文本（验证过程 + 技术细节）。 */
export function buildPocText(projectId: string, title: string): string | null {
  const v = findVuln(projectId, title);
  if (!v) return null;
  const ex = matchExploit(v.title, v.exploit_report ?? null);
  if (!ex || deriveRemoteStatus(ex) !== 'success') return null;
  const lines: string[] = [
    `# POC: ${v.title}`,
    '',
    `项目: ${v.project_name || projectId}`,
    `严重度: ${SEV_LABEL[v.severity] || v.severity}`,
    `定位: ${v.file_path}${v.line ? ':' + v.line : ''}`,
    '',
  ];
  if (ex.auth_required) lines.push(`所需权限: ${AUTH_LABEL[String(ex.auth_required)] || ex.auth_required}`, '');
  if (ex.local_result) {
    lines.push('## 验证过程', String(ex.local_result), '');
  }
  if (ex.detail) {
    lines.push('## 技术细节', String(ex.detail), '');
  }
  // 可复现信息（Runtime 实际执行）：仅当 exploit 带 reproduction 且至少一个有效字段时追加；
  // 旧数据没有 reproduction 时保持原有输出完全不变。
  const repro =
    ex.reproduction && typeof ex.reproduction === 'object' && !Array.isArray(ex.reproduction)
      ? ex.reproduction
      : null;
  if (repro) {
    const txt = (value: unknown) => String(value ?? '').trim();
    const req =
      repro.request && typeof repro.request === 'object' && !Array.isArray(repro.request)
        ? repro.request
        : null;
    const res =
      repro.response && typeof repro.response === 'object' && !Array.isArray(repro.response)
        ? repro.response
        : null;
    const reqText = req
      ? [txt(req.method) || txt(req.url) ? `${txt(req.method)} ${txt(req.url)}`.trim() : '', txt(req.headers), txt(req.body)]
          .filter(Boolean)
          .join('\n')
      : '';
    const resText = res
      ? [
          res.status != null && String(res.status).trim() !== ''
            ? `HTTP ${String(res.status).trim()}`
            : '',
          txt(res.headers),
          txt(res.body),
        ]
          .filter(Boolean)
          .join('\n')
      : '';
    const reproType = txt(repro.type);
    const command = txt(repro.command);
    const output = txt(repro.output);
    if (reproType || reqText || resText || command || output) {
      lines.push('REPRODUCTION', '');
      if (reproType) lines.push(`TYPE: ${reproType}`, '');
      if (reqText) lines.push('REQUEST', '```', reqText, '```', '');
      if (resText) lines.push('RESPONSE', '```', resText, '```', '');
      if (command) lines.push('COMMAND', '```', command, '```', '');
      if (output) lines.push('OUTPUT', '```', output, '```', '');
    }
  }
  if (v.target_url) lines.push(`靶机地址: ${v.target_url}`, '');
  return lines.join('\n').trim();
}

/** 生成单漏洞 Markdown 报告。 */
export function buildVulnMarkdown(projectId: string, title: string): string | null {
  const v = findVuln(projectId, title);
  if (!v) return null;
  const ex = matchExploit(v.title, v.exploit_report ?? null);
  const remoteStatus = ex ? deriveRemoteStatus(ex) : 'unknown';
  const verified = remoteStatus === 'success';
  const lines: string[] = [
    `# ${v.title}`,
    '',
    `- **项目**: ${v.project_name || projectId}`,
    v.system_name ? `- **系统**: ${v.system_name}` : '',
    v.source_version ? `- **版本**: ${v.source_version}` : '',
    `- **严重度**: ${SEV_LABEL[v.severity] || v.severity}`,
    v.regrade_value ? `- **实战等级**: ${v.regrade_value}` : '',
    v.category ? `- **类型**: ${v.category}` : '',
    `- **定位**: \`${v.file_path}${v.line ? ':' + v.line : ''}\``,
    v.auth_required
      ? `- **所需权限**: ${AUTH_LABEL[String(v.auth_required)] || v.auth_required}${v.auth_reason ? ' — ' + v.auth_reason : ''}`
      : ex?.auth_required
        ? `- **验证权限**: ${AUTH_LABEL[String(ex.auth_required)] || ex.auth_required}`
        : '',
    remoteStatus === 'success'
      ? '- **远程验证**: 成功'
      : remoteStatus === 'restricted'
        ? '- **远程验证**: 受限（源码/本地证据存在，但当前靶机未打通）'
        : remoteStatus === 'failed'
          ? '- **远程验证**: 失败'
          : '- **远程验证**: 待验证',
    '',
    '## 漏洞描述',
    '',
    v.description || '（无）',
    '',
  ].filter((l) => l !== '');

  // 结构化 Finding 字段（逐项渲染：单项为空不输出；四项全空则不产生任何小节）。
  if (v.root_cause) {
    lines.push('## 根因', '', v.root_cause, '');
  }
  if (v.endpoint) {
    lines.push('## 入口', '', v.endpoint, '');
  }
  if (v.exploitation) {
    lines.push('## 利用方式', '', v.exploitation, '');
  }
  if (v.payload) {
    lines.push('## Payload', '', '```', v.payload, '```', '');
  }

  if (v.taint_chain) {
    lines.push('## 污点链', '', v.taint_chain, '');
  }
  if (v.code_snippet) {
    lines.push('## 代码片段', '', '```', v.code_snippet, '```', '');
  }
  if (v.recommendation) {
    lines.push('## 修复建议', '', v.recommendation, '');
  }
  if (ex?.local_result) {
    lines.push('## 远程验证过程', '', String(ex.local_result), '');
  }
  // 权限降级验证（none/user/admin 三档）：整体缺失则不输出该章节；单档缺失不输出该档。
  const priv = ex?.privilege_results;
  const privTierBlocks = (['none', 'user', 'admin'] as const)
    .map((tier) => {
      const cell = priv && typeof priv === 'object' ? priv[tier] : null;
      if (!cell || typeof cell !== 'object') return '';
      const status = String(cell.status ?? '').trim();
      const evidence = String(cell.evidence ?? '').trim();
      if (!status && !evidence) return '';
      const block: string[] = [`### ${tier}`, ''];
      if (status) block.push(`- **状态**: ${status}`);
      if (evidence) block.push(`- **证据**: ${evidence}`);
      return block.join('\n');
    })
    .filter(Boolean);
  if (privTierBlocks.length > 0) {
    lines.push('## 权限降级验证', '', privTierBlocks.join('\n\n'), '');
  }
  if (ex?.detail) {
    lines.push('## 利用细节', '', String(ex.detail), '');
  }
  // 可复现信息（Runtime 实际执行）：任一有效字段才输出该章节；整体缺失或全空则不出现。
  const repro =
    ex?.reproduction && typeof ex.reproduction === 'object' && !Array.isArray(ex.reproduction)
      ? ex.reproduction
      : null;
  const reproTxt = (value: unknown) => String(value ?? '').trim();
  const reproReq =
    repro && repro.request && typeof repro.request === 'object' && !Array.isArray(repro.request)
      ? repro.request
      : null;
  const reproRes =
    repro && repro.response && typeof repro.response === 'object' && !Array.isArray(repro.response)
      ? repro.response
      : null;
  const reproReqText = reproReq
    ? [
        reproTxt(reproReq.method) || reproTxt(reproReq.url)
          ? `${reproTxt(reproReq.method)} ${reproTxt(reproReq.url)}`.trim()
          : '',
        reproTxt(reproReq.headers),
        reproTxt(reproReq.body),
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const reproResText = reproRes
    ? [
        reproRes.status != null && String(reproRes.status).trim() !== ''
          ? `HTTP ${String(reproRes.status).trim()}`
          : '',
        reproTxt(reproRes.headers),
        reproTxt(reproRes.body),
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const reproType = reproTxt(repro?.type);
  const reproCommand = reproTxt(repro?.command);
  const reproOutput = reproTxt(repro?.output);
  if (reproType || reproReqText || reproResText || reproCommand || reproOutput) {
    lines.push('## 可复现信息', '');
    if (reproType) lines.push('### 类型', '', reproType, '');
    if (reproReqText) lines.push('### 请求', '', '```', reproReqText, '```', '');
    if (reproResText) lines.push('### 响应', '', '```', reproResText, '```', '');
    if (reproCommand) lines.push('### 命令', '', '```', reproCommand, '```', '');
    if (reproOutput) lines.push('### 执行输出', '', '```', reproOutput, '```', '');
  }
  const hist = Array.isArray(ex?.historical_verification) ? ex.historical_verification : [];
  const okHist = hist.filter((h: any) => h?.status === 'success');
  if (okHist.length > 0) {
    lines.push('## 历史版本验证', '');
    for (const h of okHist) {
      lines.push(`- **${h.version || '?'}** (${h.status})${h.reason ? ': ' + h.reason : ''}`);
    }
    lines.push('');
  }
  lines.push('---', '', `*生成时间: ${new Date().toISOString()}*`);
  return lines.join('\n');
}

// 本仓维护用的薄组合入口：按 package.json 已有脚本依次执行检查，保留原始输出和可留存摘要。
// 它不新增断言、不改变 failure 语义；失败或必需检查未完成时整体退出码非零。
// 合成 smoke（demo）在摘要中明确标识，不能替代真实宿主、模型或外部系统验收。
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_LABEL = { passed: '通过', failed: '失败', 'not-run': '未运行' };

// 顺序固定：先跑快速一致性检查，再跑行为测试和合成 smoke。任一项失败都继续执行其余项，保留完整结果。
export const CHECK_DEFINITIONS = [
  { id: 'check', script: 'check', synthetic: false, note: '仓库一致性：语法、发布清单、版本与 hook 声明、文档本地链接' },
  { id: 'test', script: 'test', synthetic: false, note: '行为与回归测试（node --test）' },
  { id: 'demo', script: 'demo', synthetic: true, note: '合成 smoke：synthetic-isolated-cli，不代表真实 ACP、模型或用户宿主' },
];

export function checksFromScripts(scripts = {}) {
  return CHECK_DEFINITIONS.map(definition => {
    const command = typeof scripts[definition.script] === 'string' && scripts[definition.script].trim() ? scripts[definition.script] : null;
    return { ...definition, command, selected: true };
  });
}

// 未选择的检查保留在摘要里并标为未运行（未选择），不冒充已通过。
export function selectChecks(checks, ids) {
  const known = new Set(checks.map(check => check.id));
  for (const id of ids) if (!known.has(id)) throw new Error(`未知检查：${id}；可选：${[...known].join('、')}`);
  return checks.map(check => ({ ...check, selected: ids.includes(check.id) }));
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function defaultOutDir(date = new Date()) {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'workflow-verify')
    : process.env.XDG_STATE_HOME
      ? path.join(process.env.XDG_STATE_HOME, 'workflow-verify')
      : path.join(os.homedir(), '.local', 'state', 'workflow-verify');
  return path.join(base, path.basename(root), stamp(date));
}

function gitInfo(cwd) {
  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (head.status !== 0) return { head: null, changes: null };
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const changes = status.status === 0 ? status.stdout.trim().split(/\r?\n/).filter(Boolean).length : null;
  return { head: head.stdout.trim(), changes };
}

function runOne(check, { cwd, outDir, timeoutMs }) {
  const selected = check.selected !== false;
  const record = { id: check.id, command: check.command, synthetic: Boolean(check.synthetic), note: check.note || null, selected, status: 'not-run', exitCode: null, durationMs: 0, log: null, reason: null };
  if (!selected) { record.reason = '未选择'; return record; }
  if (!check.command) { record.reason = `package.json 缺少 ${check.script} 脚本`; return record; }
  const log = path.join(outDir, `${check.id}.log`);
  const started = Date.now();
  const result = spawnSync(check.command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  record.durationMs = Date.now() - started;
  writeFileSync(log, `$ ${check.command}\n\n--- stdout ---\n${result.stdout || ''}\n--- stderr ---\n${result.stderr || ''}\n`);
  record.log = log;
  if (result.error) {
    record.reason = result.error.code === 'ETIMEDOUT' ? `超过时限（${timeoutMs}ms）被终止` : `无法启动：${result.error.code || result.error.message}`;
  } else if (result.status === null) {
    record.reason = `被信号 ${result.signal || '未知'} 终止`;
  } else if (result.status === 0) {
    record.status = 'passed';
    record.exitCode = 0;
  } else {
    record.status = 'failed';
    record.exitCode = result.status;
  }
  return record;
}

function render(summary) {
  const rows = summary.checks.map(check => `| ${check.id}${check.synthetic ? '（合成 smoke）' : ''} | ${STATUS_LABEL[check.status]} | ${check.exitCode ?? '—'} | ${check.durationMs}ms | ${check.log ?? '—'} | ${check.reason || check.note || ''} |`);
  // 末尾未运行项覆盖所有 not-run（未选择、缺脚本、启动失败或被终止），逐项附原因。
  const notRun = summary.checks.filter(check => check.status === 'not-run').map(check => `${check.id}（${check.reason || '原因未记录'}）`);
  return [
    '# workflow 验证摘要',
    '',
    `- 生成时间：${summary.generatedAt}`,
    `- 验证对象：${summary.target.root}`,
    `- 提交：${summary.target.head ?? '不是 Git 仓库或读取失败'}${summary.target.changes === null ? '' : `（未提交变更 ${summary.target.changes} 项，含未跟踪文件）`}`,
    `- 环境：Node ${summary.target.node} / ${summary.target.platform}`,
    `- 总体：${STATUS_LABEL[summary.overall]}（退出码 ${summary.exitCode}）`,
    '',
    '| 检查 | 状态 | 退出码 | 耗时 | 原始输出 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `未运行项：${notRun.length ? notRun.join('、') : '无'}`,
    '',
    '边界：',
    '- demo 是合成 smoke（synthetic-isolated-cli），不代表真实 ACP、模型调用或用户宿主回调。',
    '- 摘要只记录本地命令的退出状态与原始输出，不认证测试内容、覆盖率或真实环境行为。',
    '- 环境预置（例如外部 NODE_OPTIONS 适配器）不由本脚本保证；子进程若覆盖 NODE_OPTIONS，该预置不会继续生效。',
    '',
  ].join('\n');
}

export function runChecks(checks, { outDir, cwd = root, timeoutMs = 15 * 60 * 1000, now = new Date() } = {}) {
  if (!outDir) throw new Error('runChecks 需要 outDir');
  mkdirSync(outDir, { recursive: true });
  const records = checks.map(check => runOne(check, { cwd, outDir, timeoutMs }));
  const failed = records.filter(record => record.selected && record.status !== 'passed');
  const target = { root: cwd, node: process.version, platform: process.platform, ...gitInfo(cwd) };
  const summary = {
    generatedAt: now.toISOString(),
    mode: 'composed-existing-commands',
    target,
    checks: records,
    overall: failed.length ? 'failed' : 'passed',
    exitCode: failed.length ? 1 : 0,
  };
  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = render(summary);
  writeFileSync(path.join(outDir, 'summary.md'), markdown);
  return { summary, markdown };
}

export function parseArgs(argv) {
  const ids = [];
  let out = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') {
      out = argv[++index];
      if (!out) throw new Error('--out 需要目录参数');
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数：${arg}`);
    } else {
      ids.push(arg);
    }
  }
  return { ids, out };
}

const usage = `用法：node scripts/verify.mjs [检查...] [--out <目录>]
检查：${CHECK_DEFINITIONS.map(definition => definition.id).join('、')}（默认全部）
报告：默认写到系统状态目录（Windows 为 %LOCALAPPDATA%\\workflow-verify\\<仓库>\\<时间>），可用 --out 指定。`;

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(`${usage}\n`); return; }
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
  const all = checksFromScripts(scripts);
  const checks = args.ids.length ? selectChecks(all, args.ids) : all;
  const outDir = args.out ? path.resolve(args.out) : defaultOutDir();
  const { summary, markdown } = runChecks(checks, { outDir });
  process.stdout.write(markdown);
  process.exitCode = summary.exitCode;
}

// 只有作为脚本直接执行时才运行检查；被测试导入时不产生副作用。
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage}\n`);
    process.exitCode = 2;
  }
}

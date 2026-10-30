import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cp, copyFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { isSignalInvocation } from '../src/hooks.mjs';
import { signalUsage } from '../src/context.mjs';
import { cliPath } from '../src/entry.mjs';
import { root, temporary } from './helpers.mjs';

// 测试独立给出期望，不复用生产实现里的引号函数。
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

// 真实宿主里的两个 PowerShell 都验证；不把 pwsh 的结果冒充 Windows PowerShell 5.1。
function discover(name) {
  if (process.platform !== 'win32') return null;
  const probe = spawnSync(name, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (probe.error || probe.status !== 0) return null;
  return { command: name, version: probe.stdout.trim() };
}
const SHELLS = ['powershell.exe', 'pwsh.exe'].map(discover).filter(Boolean);
const shellArgs = source => ['-NoProfile', '-NonInteractive', '-Command', source];
const shell = (item, source, options = {}) => spawnSync(item.command, shellArgs(source), { encoding: 'utf8', windowsHide: true, timeout: 30000, ...options });

// 复刻安装目录：只复制运行 context 所需的 bin/src/package.json。
// 目录名本身带子表达式和 $HOME，双引号模板会在这里被 PowerShell 展开或执行。
async function copyPlugin(area) {
  const plugin = path.join(area, '$(Set-Content canary-q-w-b.txt x)', '$HOME', 'plugin');
  await mkdir(path.dirname(plugin), { recursive: true });
  await cp(path.join(root, 'src'), path.join(plugin, 'src'), { recursive: true });
  await cp(path.join(root, 'bin'), path.join(plugin, 'bin'), { recursive: true });
  await copyFile(path.join(root, 'package.json'), path.join(plugin, 'package.json'));
  return plugin;
}
const parse = (text, label) => {
  try { return JSON.parse(text); } catch { assert.fail(`${label} 的输出不是 JSON：${JSON.stringify(text.slice(0, 400))}`); }
};
// 把 signalUsage 的模板替换成可直接执行的形式；--help 只验证入口路径能原样到达 Node。
function runnable(usage) {
  return usage.command
    .replace('<action>', '--help')
    .replace('<identity.sessionId>', 'session-1')
    .replace('<identity.turnId>', 'turn-1')
    .replace('<新 signalId>', 'signal-1');
}

test('signalUsage 用单引号字面量书写入口路径，不用可展开的双引号', () => {
  const cli = 'C:/Users/me/$(Set-Content canary-q-w-b.txt x)/$HOME/bin/workflow.mjs';
  const usage = signalUsage(cli);
  assert.ok(usage.command.startsWith(`node ${psQuote(cli)} signal `), usage.command);
  assert.ok(!usage.command.includes(`"${cli}"`), usage.command);
  for (const line of usage.examples) assert.ok(!line.includes(`"${cli}"`), line);
  // 单独直接调用、身份字段模板和 rule 仍保持原样，不引入 cd、组合命令或变量赋值。
  const templates = [usage.command, ...usage.examples, usage.fallback].join('\n');
  assert.doesNotMatch(templates, /\bcd\s|&&|;|\$wf=/);
  assert.match(usage.command, /--session <identity\.sessionId> --turn <identity\.turnId> --id <新 signalId>/);
});

test('signalUsage 生成的实际调用仍被宿主 PostToolUse 识别为单独直接调用', async () => {
  const entry = cliPath();
  const usage = signalUsage(entry);
  // 按用户复制后的样子填上身份和动作；命令里不再有占位符。
  const command = usage.command
    .replace('<action>', 'task-start')
    .replace('<identity.sessionId>', 'session-1')
    .replace('<identity.turnId>', 'turn-1')
    .replace('<新 signalId>', 'signal-1')
    .replace(/ \[字段参数\]$/, ' --task task-1 --route lead-direct');
  assert.equal(await isSignalInvocation({ tool_name: 'Bash', tool_input: { command } }, entry), true, command);
});

for (const item of SHELLS) {
  test(`${item.command} ${item.version}：安装路径含 $HOME/子表达式时公开 context 入口的命令安全可执行`, async t => {
    t.diagnostic(`shell=${item.command} version=${item.version}`);
    const area = await temporary('context-shell-');
    const plugin = await copyPlugin(area);
    const project = path.join(area, 'project');
    const state = path.join(area, 'state');
    await mkdir(project);
    await writeFile(path.join(project, 'README.md'), '# 项目\n');
    const entry = path.join(plugin, 'bin', 'workflow.mjs');
    const enable = spawnSync(process.execPath, [entry, 'project', 'enable', '--root', project, '--state-dir', state], { encoding: 'utf8', windowsHide: true, cwd: area });
    assert.equal(enable.status, 0, enable.stdout + enable.stderr);

    // 公开入口：hook 会给出 context，用户/代理从 signal.command 复制命令。
    const context = shell(item, `node ${psQuote(entry)} context --role lead --project ${psQuote(project)} --state-dir ${psQuote(state)}`, { cwd: area });
    const parsed = parse(context.stdout, item.command);
    assert.equal(parsed.enabled, true, JSON.stringify(parsed));
    const usage = parsed.signal;
    const literal = entry.replaceAll('\\', '/');
    assert.ok(usage.command.includes(psQuote(literal)), usage.command);
    assert.ok(!usage.command.includes(`"${literal}"`), usage.command);

    const executed = shell(item, runnable(usage), { cwd: area });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    assert.ok(executed.stdout.includes('"usage"'), executed.stdout);
    assert.equal(await lstat(path.join(area, 'canary-q-w-b.txt')).catch(() => null), null, '命令里的子表达式不能被执行');
  });
}

if (process.platform === 'win32' && !SHELLS.length) {
  test('未找到真实 PowerShell，上下文入口的命令安全未验证', { skip: 'powershell.exe 与 pwsh.exe 均不可用' }, () => {});
}

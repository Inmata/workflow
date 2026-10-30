import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { preflight, runProcess, claudePreflight, claudeOutcome, EXECUTORS } from '../src/runner.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../src/learning-config.mjs';
import { temporary } from './helpers.mjs';

const features = ['hooks','shell_tool','multi_agent','plugins','apps','unified_exec'];
test('执行器预检禁用 hooks、工具、MCP，继承指定 profile，不调用模型', async () => {
  const calls = [];
  const run = async (exe, args) => {
    calls.push(args);
    if (args.includes('--help')) return { code: 0, stdout: '--json --output-schema --ephemeral --sandbox' };
    // unified_exec 仅托管配置能关，用户 -c 覆盖后仍报 true。
    if (args.includes('features')) return { code: 0, stdout: features.map(f => f + ' stable ' + (f === 'unified_exec' || !args.includes('features.' + f + '=false'))).join('\n') };
    return { code: 0, stdout: JSON.stringify([{ name: 'test-server', enabled: !args.includes('mcp_servers.test-server.enabled=false') }]) };
  };
  const result = await preflight({ ...DEFAULT_CONFIG, profile: 'nightly' }, await temporary(), run);
  assert.equal(result.modelInvocation, false);
  assert.deepEqual(result.common, ['--profile','nightly']);
  // Codex 0.164 的 features 子命令拒绝 --profile。
  assert.equal(calls.some(a => a.includes('features') && a.includes('--profile')), false);
  assert.ok(calls.some(a => a.includes('mcp') && a.includes('--profile')));
  assert.ok(result.flags.includes('features.hooks=false'));
  assert.ok(result.flags.includes('agents.enabled=false'));
  assert.ok(result.flags.includes('mcp_servers.test-server.enabled=false'));
  assert.equal(calls.some(a => a.includes('exec') && !a.includes('--help')), false);
});
test('shell_tool 关不掉时仍停止', async () => {
  const run = async (exe, args) => {
    if (args.includes('--help')) return { code: 0, stdout: '--json --output-schema --ephemeral --sandbox' };
    if (args.includes('features')) return { code: 0, stdout: features.map(f => f + ' stable ' + (f === 'shell_tool' || !args.includes('features.' + f + '=false'))).join('\n') };
    return { code: 0, stdout: '[]' };
  };
  await assert.rejects(preflight(DEFAULT_CONFIG, await temporary(), run), { code: 'ISOLATION' });
});
test('隔离能力缺失或 MCP 禁用失败时停止', async () => {
  const run = async (exe, args) => args.includes('--help') ? { code: 0, stdout: '--json --output-schema --ephemeral --sandbox' } : { code: 0, stdout: 'shell_tool stable true' };
  await assert.rejects(preflight(DEFAULT_CONFIG, await temporary(), run), { code: 'ISOLATION' });
});
test('真实本地子进程超时被终止，只有程序输出，不调用模型', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
});
test('真实子进程 stdout/stderr 的 UTF-8 跨块解码完整，字符预算合并计算', async () => {
  const script = `
    const bytes = Buffer.from('中');
    let index = 0;
    function emit() {
      process.stdout.write(bytes.subarray(index, index + 1));
      process.stderr.write(bytes.subarray(index, index + 1));
      if (++index < bytes.length) setTimeout(emit, 40);
    }
    emit();
  `;
  const result = await runProcess(process.execPath, ['-e', script], { maxOutputChars: 2 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '中');
  assert.equal(result.stderr, '中');
  assert.equal(result.overflow, false, '两个流总计两个字符，跨块字节不应膨胀预算');
  assert.equal(result.timedOut, false);
  const limited = await runProcess(process.execPath, ['-e', script], { maxOutputChars: 1 });
  assert.equal(limited.overflow, true, 'stdout 和 stderr 必须共享输出预算');
  assert.equal(limited.timedOut, false);
});

test('执行器结束时冲刷不完整 UTF-8 尾字节，尾字符仍受总输出预算保护', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xe4])); process.stderr.write(Buffer.from([0xe4]));'], { maxOutputChars: 1 });
  assert.equal(result.stdout, '�');
  assert.equal(result.stderr, '�');
  assert.equal(result.overflow, true);
  assert.equal(result.timedOut, false);
});

const claudeHelp = '--bare --setting-sources --settings --strict-mcp-config --tools --json-schema --output-format --no-session-persistence --include-hook-events';
test('Claude 预检核对是 Claude Code 与隔离参数，不调用模型', async () => {
  const calls = [];
  const run = async (exe, args) => { calls.push(args); return args[0] === '--version' ? { code: 0, stdout: '2.1.310 (Claude Code)' } : { code: 0, stdout: claudeHelp }; };
  const result = await claudePreflight({ ...DEFAULT_CONFIG, executor: 'claude' }, await temporary(), run);
  assert.equal(result.modelInvocation, false);
  for (const flag of ['--bare', '--strict-mcp-config', '--no-session-persistence']) assert.ok(result.flags.includes(flag));
  assert.equal(result.flags[result.flags.indexOf('--tools') + 1], '');
  assert.equal(calls.some(a => a.includes('-p')), false);
  // 把 codex 路径误配给 Claude 时停止，而不是用 Claude 参数调用它。
  await assert.rejects(claudePreflight(DEFAULT_CONFIG, await temporary(), async () => ({ code: 0, stdout: 'codex-cli 0.164' })), { code: 'EXECUTOR' });
  await assert.rejects(claudePreflight(DEFAULT_CONFIG, await temporary(), async (e, a) => a[0] === '--version' ? { code: 0, stdout: 'Claude Code' } : { code: 0, stdout: '--bare' }), { code: 'ISOLATION' });
});
test('Claude 专用设置文件取代用户设置；带 hooks 的文件或相对路径被拒绝', async () => {
  const dir = await temporary(), file = path.join(dir, 'learning-claude.json');
  await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'x' } }));
  const run = async (exe, args) => args[0] === '--version' ? { code: 0, stdout: 'Claude Code' } : { code: 0, stdout: claudeHelp };
  const { flags } = await claudePreflight(validateConfig({ executor: 'claude', claudeSettings: file }), dir, run);
  assert.equal(flags[flags.indexOf('--setting-sources') + 1], '');
  assert.equal(flags[flags.indexOf('--settings') + 1], file);
  await writeFile(file, JSON.stringify({ hooks: { Stop: [] } }));
  await assert.rejects(claudePreflight(validateConfig({ claudeSettings: file }), dir, run), { code: 'ISOLATION' });
  await assert.rejects(claudePreflight(validateConfig({ claudeSettings: path.join(dir, 'missing.json') }), dir, run), { code: 'CONFIG' });
  assert.throws(() => validateConfig({ claudeSettings: 'relative.json' }), { code: 'CONFIG' });
});
const init = { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] };
const ok = { type: 'result', subtype: 'success', is_error: false, structured_output: { decisions: [] }, usage: { input_tokens: 10, output_tokens: 2 } };
const stream = events => ({ code: 0, stdout: events.map(e => JSON.stringify(e)).join('\n') + '\n' });
test('Claude 执行读取结构化结果与用量；出现 hook、工具或 MCP 时不采用', () => {
  const done = claudeOutcome(stream([init, ok]));
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.answer, { decisions: [] });
  assert.equal(done.usage.input_tokens, 10);
  for (const events of [[init, { type: 'system', subtype: 'hook_started' }, ok], [{ ...init, tools: ['Bash', 'StructuredOutput'] }, ok], [{ ...init, mcp_servers: [{ name: 'x' }] }, ok], [init, { ...ok, structured_output: null }], [ok]]) assert.equal(claudeOutcome(stream(events)).status, 'failed', JSON.stringify(events));
  assert.equal(claudeOutcome({ ...stream([init]), timedOut: true }).status, 'timeout');
  assert.equal(claudeOutcome({ ...stream([init, ok]), code: 1 }).status, 'failed');
});
test('执行器配置：默认 codex，按项目可选 claude，拒绝未知值', () => {
  assert.equal(validateConfig({}).executor, 'codex');
  assert.equal(validateConfig({ executor: 'claude' }).claudePath, 'claude');
  assert.throws(() => validateConfig({ executor: 'gemini' }), { code: 'CONFIG' });
  assert.deepEqual(Object.keys(EXECUTORS), ['codex', 'claude']);
});

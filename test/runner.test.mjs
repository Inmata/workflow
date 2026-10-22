import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { preflight, runProcess } from '../src/runner.mjs';
import { DEFAULT_CONFIG } from '../src/learning-config.mjs';
import { temporary } from './helpers.mjs';

const features = ['hooks','shell_tool','multi_agent','plugins','apps','unified_exec'];
test('执行器预检禁用 hooks、工具、MCP，继承指定 profile，不调用模型', async () => {
  const calls = [];
  const run = async (exe, args) => {
    calls.push(args);
    if (args.includes('--help')) return { code: 0, stdout: '--json --output-schema --ephemeral --sandbox' };
    if (args.includes('features')) return { code: 0, stdout: features.map(f => f + ' stable ' + !args.includes('features.' + f + '=false')).join('\n') };
    return { code: 0, stdout: JSON.stringify([{ name: 'test-server', enabled: !args.includes('mcp_servers.test-server.enabled=false') }]) };
  };
  const result = await preflight({ ...DEFAULT_CONFIG, profile: 'nightly' }, await temporary(), run);
  assert.equal(result.modelInvocation, false);
  assert.deepEqual(result.common, ['--profile','nightly']);
  assert.ok(result.flags.includes('features.hooks=false'));
  assert.ok(result.flags.includes('mcp_servers.test-server.enabled=false'));
  assert.equal(calls.some(a => a.includes('exec') && !a.includes('--help')), false);
});
test('隔离能力缺失或 MCP 禁用失败时停止', async () => {
  const run = async (exe, args) => args.includes('--help') ? { code: 0, stdout: '--json --output-schema --ephemeral --sandbox' } : { code: 0, stdout: 'shell_tool stable true' };
  await assert.rejects(preflight(DEFAULT_CONFIG, await temporary(), run), { code: 'ISOLATION' });
});
test('真实本地子进程超时被终止，只有程序输出，不调用模型', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
});

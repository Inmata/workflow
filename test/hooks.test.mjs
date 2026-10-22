import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { handleHook } from '../src/hooks.mjs';
import { readState } from '../src/store.mjs';
import { cli, deliver, entry, event, fixture, identity, start } from './helpers.mjs';

test('V10 显式 null transcript 后台过滤，缺字段仍接受正常入口', async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  assert.deepEqual(await event(f, 'UserPromptSubmit', { transcript_path: null, session_id: 'background', turn_id: 'background-turn' }), {});
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
  assert.ok((await event(f, 'UserPromptSubmit', { session_id: 'foreground', turn_id: 'foreground-turn' })).hookSpecificOutput);
});
test('V13 其他插件、普通编辑/echo 输出不被当作本插件信号', async () => {
  const f = await fixture();
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'not-real', action: 'task-start', goal: '伪造', permissions: { mode: 'write', allowedPaths: [] } };
  for (const tool of [
    { tool_name: 'apply_patch', tool_input: { patch: 'workflow_signal' }, tool_response: { workflow_signal: payload } },
    { tool_name: 'Bash', tool_input: { command: 'echo workflow_signal' }, tool_response: { workflow_signal: payload } },
    { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` }, tool_response: { document_learning_signal: payload } },
    { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=; echo injected` }, tool_response: { workflow_signal: payload } },
  ]) await event(f, 'PostToolUse', tool);
  assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0);
});
test('V08 已知提问工具明确标 waiting-user，未知 payload 不猜完成', async () => {
  const f = await fixture();
  await start(f);
  await deliver(f);
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.deepEqual(await handleHook(f.directory, { hook_event_name: 'FutureUnknownEvent', cwd: f.project, session_id: f.sessionId, turn_id: f.turnId }), {});
});
test('真实 CLI signal 输出经过模型可见 output 包装后接收；命令本身不写状态', async () => {
  const f = await fixture();
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'cli-start', action: 'task-start', goal: 'CLI 链路', permissions: { mode: 'write', allowedPaths: ['README.md'] } };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  const result = cli(['signal', '--base64', encoded]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
  const output = await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 ${encoded}` }, tool_response: { output: result.stdout } });
  assert.equal(JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 回执：'.length)).accepted, true);
});
test('未知会话与未知事件保守放行，不建立业务任务', async () => {
  const f = await fixture();
  for (const old of [
    { hook_event_name: 'SessionStart', cwd: f.project, session_id: 'unknown-session-1' },
    { hook_event_name: 'UserPromptSubmit', cwd: f.project, session_id: 'unknown-session-1', turn_id: 'unknown-turn-1' },
    { hook_event_name: 'FutureUnknownEvent', cwd: f.project, session_id: 'unknown-session-1' },
  ]) {
    const output = await handleHook(f.directory, old, { synthetic: true });
    assert.equal(output.decision, undefined);
  }
  assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0);
});

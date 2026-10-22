import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHook } from '../src/hooks.mjs';
import { mutate, readState } from '../src/store.mjs';
import { doctor } from '../src/install.mjs';
import { claudeEmit, claudeEvent, claudeStart, entry, fixture, identity } from './helpers.mjs';

test('Claude 入口无 turn_id 也建立 Lead 身份，并用宿主 prompt_id 作为回合标识', async () => {
  const f = await fixture({ claude: true });
  const output = await claudeEvent(f, 'UserPromptSubmit');
  assert.ok(output.hookSpecificOutput.additionalContext.includes('workflow 入口'));
  const id = await identity(f);
  assert.equal(id.sessionId, f.sessionId);
  assert.equal(id.turnId, f.promptId);
  assert.ok(id.ticket);
});

test('Claude 入口缺 prompt_id 时本机建立回合，后续事件仍按当前回合关联', async () => {
  const f = await fixture({ claude: true });
  const sessionId = 'session-without-prompt';
  const entered = await handleHook(f.directory, { hook_event_name: 'UserPromptSubmit', cwd: f.project, session_id: sessionId }, { synthetic: true, entry, agent: 'claude' });
  assert.ok(entered.hookSpecificOutput.additionalContext.includes('workflow 入口'));
  const session = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === sessionId);
  assert.ok(session.turnId);
  const observed = await claudeEvent(f, 'PostToolUse', {
    session_id: sessionId, prompt_id: 'host-prompt-later', tool_name: 'Bash',
    tool_input: { command: `node "${entry}" signal --base64 e30=` }, tool_response: { stdout: '普通输出' },
  });
  assert.ok(observed.hookSpecificOutput.additionalContext.includes('未接受'));
});

test('Claude PostToolUse 从 stdout 消费 signal，完成交付和显式结束', async () => {
  const f = await fixture({ claude: true });
  await claudeStart(f);
  await claudeEmit(f, { action: 'phase', phase: 'delivering', deliveryId: 'delivery-1' });
  const disposition = await claudeEmit(f, { action: 'disposition', deliveryId: 'delivery-1', disposition: { status: 'no-new-learning', reason: '隔离验证没有新经验' } });
  assert.equal(disposition.result.accepted, true);
  const ended = await claudeEmit(f, { action: 'task-end' });
  assert.equal(ended.result.accepted, true);
  const state = await readState(f.directory);
  assert.equal(Object.values(state.tasks)[0].lifecycle, 'complete');
});

test('Claude Stop 无 turn_id 时核对当前回合，漏处置只补一轮', async () => {
  const f = await fixture({ claude: true });
  await claudeStart(f);
  await claudeEmit(f, { action: 'phase', phase: 'delivering', deliveryId: 'delivery-1' });
  const stop = await claudeEvent(f, 'Stop', { stop_hook_active: false });
  assert.equal(stop.decision, 'block');
  assert.ok(stop.reason.includes('缺少处置'));
  assert.deepEqual(await claudeEvent(f, 'Stop', { stop_hook_active: true }), {});
  const pending = Object.values((await readState(f.directory)).pending);
  assert.equal(pending.filter(item => item.kind === 'knowledge-pending').length, 1);
});

test('Claude StopFailure 保存中断，新回合沿用任务预算后可明确结束', async () => {
  const f = await fixture({ claude: true });
  await claudeStart(f);
  assert.deepEqual(await claudeEvent(f, 'StopFailure', { error: 'interrupted' }), {});
  const interrupted = await readState(f.directory);
  const session = Object.values(interrupted.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.interrupted, true);
  assert.equal(session.ticket, null);
  assert.equal(Object.values(interrupted.pending).filter(item => item.kind === 'business-incomplete').length, 1);
  assert.ok((await claudeEvent(f, 'UserPromptSubmit')).hookSpecificOutput);
  const ended = await claudeEmit(f, { action: 'task-end' });
  assert.equal(ended.result.accepted, true);
});

test('PowerShell 直接调用可识别；stderr、普通输出和组合命令不误识别', async () => {
  const f = await fixture({ claude: true });
  const node = process.execPath.replaceAll('\\', '/');
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'powershell-start', action: 'task-start', goal: 'PowerShell 链路', permissions: { mode: 'write', allowedPaths: ['README.md'] } };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const accepted = await claudeEvent(f, 'PostToolUse', {
    tool_name: 'PowerShell', tool_input: { command: `& "${node}" "${entry}" signal --base64 ${encoded}` },
    tool_response: { stdout: JSON.stringify({ workflow_signal: payload }) },
  });
  assert.equal(JSON.parse(accepted.hookSpecificOutput.additionalContext.slice('workflow 回执：'.length)).accepted, true);
  const forged = { ...await identity(f), taskId: 'task-forged', signalId: 'forged', action: 'task-start', goal: '伪造', permissions: { mode: 'write', allowedPaths: [] } };
  await claudeEvent(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` }, tool_response: { stdout: '普通输出', stderr: JSON.stringify({ workflow_signal: forged }) } });
  await claudeEvent(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=; echo injected` }, tool_response: { stdout: JSON.stringify({ workflow_signal: forged }) } });
  const state = await readState(f.directory);
  assert.deepEqual(Object.values(state.tasks).map(task => task.goal), ['PowerShell 链路']);
});

test('回调观测按宿主分层，旧扁平记录只算 Codex 证据', async () => {
  const f = await fixture();
  await handleHook(f.directory, { hook_event_name: 'UserPromptSubmit', cwd: f.project, session_id: f.sessionId, turn_id: 'turn-callback' });
  assert.equal((await doctor(f.directory)).execution.status, 'callback-observed-host-unverified');
  assert.equal((await doctor(f.directory, undefined, { agent: 'claude' })).execution, 'unknown');
  const layered = await readState(f.directory);
  assert.ok(layered.hostObservations.codex.UserPromptSubmit);
  assert.equal(layered.hostObservations.claude, undefined);
  await mutate(f.directory, async state => { state.hostObservations = { SessionStart: { at: '2026-01-01T00:00:00.000Z', sessionId: 'legacy', source: 'callback' } }; });
  const legacy = await doctor(f.directory);
  assert.deepEqual(legacy.execution.events.map(item => item.event), ['SessionStart']);
  assert.equal((await doctor(f.directory, undefined, { agent: 'claude' })).execution, 'unknown');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { handleHook } from '../src/hooks.mjs';
import { mutate, readState, withLock } from '../src/store.mjs';
import { cli, deliver, emit, entry, event, fixture, identity, start } from './helpers.mjs';

test('P11 未接入目录不先核验发布副本，已接入项目仍按指纹拦截', async () => {
  const f = await fixture();
  const release = path.join(f.area, 'release');
  await mkdir(release, { recursive: true });
  await writeFile(path.join(release, 'entry.js'), '被修改的发布副本');
  await mutate(f.directory, async state => {
    state.install = { status: 'installed', releaseRoot: release, files: [{ path: 'entry.js', hash: '0'.repeat(64) }] };
  });
  const revision = (await readState(f.directory)).revision;
  const outside = path.join(f.area, 'outside');
  await mkdir(outside, { recursive: true });
  // 未接入目录：不读取发布副本、不写状态，也不声称维护不可用。
  assert.deepEqual(await handleHook(f.directory, { hook_event_name: 'UserPromptSubmit', cwd: outside, session_id: 'other-session', turn_id: 'turn-other' }), {});
  assert.equal((await readState(f.directory)).revision, revision);
  // 已接入项目：保守放行的提示仍在，校验没有被移除。
  const output = await handleHook(f.directory, { hook_event_name: 'UserPromptSubmit', cwd: f.project, session_id: f.sessionId, turn_id: 'turn-2' });
  assert.match(output.systemMessage || '', /发布副本指纹变化/);
});
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
test('P01 入口短暂争用后有总预算等待，新会话最终持久化；预算耗尽只给恢复提示不冒充成功', async () => {
  const f = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withLock(f.directory, 'state', async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 30));
  const entered = event({ ...f, sessionId: 'session-contended', turnId: 'turn-contended' }, 'UserPromptSubmit');
  setTimeout(release, 200);
  const output = await entered;
  await holder;
  assert.ok(output.hookSpecificOutput?.additionalContext.startsWith('workflow 入口：'), JSON.stringify(output));
  const persisted = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === 'session-contended');
  assert.equal(persisted.turnId, 'turn-contended');
  assert.ok(persisted.ticket);
});
test('P01 入口拿不到身份时只给恢复提示，不输出入口成功也不建立猜测身份', async () => {
  const f = await fixture();
  const before = Object.keys((await readState(f.directory)).sessions).length;
  // SessionStart 没有宿主回合标识，也没有既有会话：本机不知道这是哪一回合。
  const output = await handleHook(f.directory, { hook_event_name: 'SessionStart', cwd: f.project, session_id: 'session-cold-start' }, { synthetic: true, entry });
  assert.equal(output.hookSpecificOutput.additionalContext.includes('workflow 入口：'), false);
  assert.match(output.hookSpecificOutput.additionalContext, /未建立入口身份/);
  assert.equal(Object.keys((await readState(f.directory)).sessions).length, before);
});
test('P01 结束事件落盘失败如实报告，不把内存写入当作已持久化', async () => {
  const f = await fixture();
  await start(f);
  // 用同名文件占住 lifecycle-events 目录，令事件记录无法落盘。
  await writeFile(path.join(f.directory, 'lifecycle-events'), '故意占用目录名称');
  const output = await event(f, 'Interrupt');
  assert.match(output.systemMessage, /未能保存 Interrupt 事件记录/);
  assert.match(output.systemMessage, /仅尝试写入当前状态/);
});
test('P01 结束事件记录与状态锁同时失败时如实报告：既未落盘也未应用', async () => {
  const f = await fixture();
  await start(f);
  await writeFile(path.join(f.directory, 'lifecycle-events'), '故意占用目录名称');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withLock(f.directory, 'state', async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 30));
  const output = await event(f, 'Interrupt');
  release();
  await holder;
  assert.match(output.systemMessage, /未能保存 Interrupt 事件记录/);
  assert.match(output.systemMessage, /LOCKED/);
  assert.match(output.systemMessage, /事件未应用/);
  assert.doesNotMatch(output.systemMessage, /已另存为本机待办/);
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
test('结构化提问自动记 waiting-user 且同一回合只改一次；未知工具不自动记', async () => {
  const phaseOf = async f => Object.values((await readState(f.directory)).sessions).find(s => s.sessionId === f.sessionId).phase;
  const revisionOf = async f => Object.values((await readState(f.directory)).sessions).find(s => s.sessionId === f.sessionId).revision;
  const f = await fixture();
  await start(f);
  const before = await revisionOf(f);
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.equal(await phaseOf(f), 'waiting-user');
  assert.equal(await revisionOf(f), before + 1);
  // 同一回合再次调用提问工具：状态已相同，不再产生第二次修改。
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.equal(await revisionOf(f), before + 1);

  // 已显式发过 waiting-user 时，提问工具不再重复修改。
  const g = await fixture();
  await start(g);
  await emit(g, { action: 'phase', phase: 'waiting-user' });
  const declared = await revisionOf(g);
  await event(g, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.equal(await revisionOf(g), declared);

  // 不认识的工具不自动记录。
  const h = await fixture();
  await start(h);
  const plain = await revisionOf(h);
  await event(h, 'PostToolUse', { tool_name: 'some_other_question_tool', tool_input: {}, tool_response: {} });
  assert.equal(await phaseOf(h), 'executing');
  assert.equal(await revisionOf(h), plain);
});
test('提问工具按宿主分表：原生与 Codeg MCP 名称置 waiting-user，跨宿主名称不误认', async () => {
  const { claudeEvent, claudeStart } = await import('./helpers.mjs');
  const phase = async f => Object.values((await readState(f.directory)).sessions).find(s => s.sessionId === f.sessionId).phase;
  for (const tool of ['request_user_input', 'request_user_input_async', 'mcp__codeg-mcp__ask_user_question', 'mcp__codeg_mcp__ask_user_question']) {
    const f = await fixture();
    await start(f);
    await event(f, 'PostToolUse', { tool_name: tool, tool_input: {}, tool_response: {} });
    assert.equal(await phase(f), 'waiting-user', tool);
  }
  for (const tool of ['AskUserQuestion', 'mcp__codeg-mcp__ask_user_question']) {
    const f = await fixture({ claude: true });
    await claudeStart(f);
    await claudeEvent(f, 'PostToolUse', { tool_name: tool, tool_input: {}, tool_response: {} });
    assert.equal(await phase(f), 'waiting-user', tool);
  }
  const codex = await fixture();
  await start(codex);
  await event(codex, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {} });
  assert.equal(await phase(codex), 'executing');
  const claude = await fixture({ claude: true });
  await claudeStart(claude);
  await claudeEvent(claude, 'PostToolUse', { tool_name: 'request_user_input', tool_input: {}, tool_response: {} });
  assert.equal(await phase(claude), 'executing');
});

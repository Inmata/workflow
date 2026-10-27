import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mutate, readState } from '../src/store.mjs';
import { buildSignal } from '../src/signal.mjs';
import { sessionKey } from '../src/protocol.mjs';
import { resolveProject } from '../src/projects.mjs';
import { cli, entry, event, fixture, start } from './helpers.mjs';

// 便捷子命令：CLI 只读状态拼 payload，交给 PostToolUse 接受；返回 CLI 结果与 hook 回执。
function build(f, action, args = [], session = f) {
  return cli(['signal', action, '--state-dir', f.directory, '--root', f.project, '--session', session.sessionId, '--turn', session.turnId, ...args]);
}
const quote = value => /\s/.test(value) ? `"${value}"` : value;
async function accept(f, action, args, session = f) {
  const run = build(f, action, args, session);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const command = `node "${entry}" signal ${action} --session ${session.sessionId} --turn ${session.turnId} ${args.map(quote).join(' ')}`;
  const output = await event({ ...f, sessionId: session.sessionId, turnId: session.turnId }, 'PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { output: run.stdout } });
  const text = output.hookSpecificOutput?.additionalContext;
  assert.ok(text?.startsWith('workflow 回执：'), JSON.stringify(output));
  return { payload: JSON.parse(run.stdout).workflow_signal, receipt: JSON.parse(text.slice('workflow 回执：'.length)) };
}
const startArgs = (id, extra = []) => ['--id', id, '--task', 'task-1', '--route', 'lead-direct', '--goal', '便捷 信号', '--mode', 'write', '--paths', 'README.md', ...extra];

test('lead-direct 两条子命令完成任务；CLI 本身不写状态', async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  const run = build(f, 'task-start', startArgs('s1'));
  assert.equal(run.status, 0, run.stdout);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
  const started = await accept(f, 'task-start', startArgs('s1'));
  assert.equal(started.receipt.accepted, true, JSON.stringify(started));
  assert.deepEqual(started.payload.permissions, { mode: 'write', allowedPaths: ['README.md'] });
  const ended = await accept(f, 'task-end', ['--id', 'e1']);
  assert.equal(ended.receipt.accepted, true, JSON.stringify(ended));
  const task = Object.values((await readState(f.directory)).tasks)[0];
  assert.equal(task.lifecycle, 'complete');
  assert.equal(task.route, 'lead-direct');
});
test('同 signalId 重试输出相同正文并命中回执；改正文返回 SIGNAL_ID', async () => {
  const f = await fixture();
  const first = await accept(f, 'task-start', startArgs('s1'));
  // 中间状态又变化一次，重放仍要复原首次的 expectedRevision。
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: {}, tool_response: {} });
  const again = await accept(f, 'task-start', startArgs('s1'));
  assert.deepEqual(again.payload, first.payload);
  assert.equal(again.receipt.replayed, true);
  const changed = await accept(f, 'task-start', startArgs('s1', ['--plans', 'docs/a.md']));
  assert.equal(changed.receipt.accepted, false);
  assert.equal(changed.receipt.reason, 'SIGNAL_ID');
});
test('读写之间 revision 变化被拒；回合过期、中断、未知会话在 CLI 直接报错', async () => {
  const f = await fixture();
  const run = build(f, 'task-start', startArgs('s1'));
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: {}, tool_response: {} });
  const output = await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal task-start --id s1` }, tool_response: { output: run.stdout } });
  const receipt = JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 回执：'.length));
  assert.equal(receipt.reason, 'REVISION');
  const stale = build({ ...f, turnId: 'turn-old' }, 'task-start', startArgs('s2'));
  assert.equal(JSON.parse(stale.stdout).error, 'STALE');
  const unknown = build({ ...f, sessionId: 'nobody' }, 'task-start', startArgs('s3'));
  assert.equal(JSON.parse(unknown.stdout).error, 'IDENTITY');
  await event(f, 'Interrupt');
  assert.equal(JSON.parse(build(f, 'task-start', startArgs('s4')).stdout).error, 'STALE');
});
test('并发两个会话各自补齐自己的身份，互不串用', async () => {
  const f = await fixture();
  const other = { sessionId: 'session-2', turnId: 'turn-9' };
  await event({ ...f, ...other }, 'UserPromptSubmit');
  const a = await accept(f, 'task-start', startArgs('a1'));
  const b = await accept(f, 'task-start', ['--id', 'b1', '--task', 'task-2', '--goal', '另一个', '--mode', 'read-only'], other);
  assert.equal(a.receipt.accepted && b.receipt.accepted, true);
  assert.notEqual(a.payload.ticket, b.payload.ticket);
  assert.equal(b.payload.sessionId, 'session-2');
});
test('packages 用 --input 只放结构化字段；带身份字段或缺 packages 被拒；未知动作被拒', async () => {
  const f = await fixture();
  await start(f);
  const { writeFile } = await import('node:fs/promises');
  const file = path.join(f.area, 'pkg.json');
  await writeFile(file, JSON.stringify({ packages: [{ packageId: 'w1', role: 'worker', status: 'dispatched', handle: 'h1' }] }));
  const sent = await accept(f, 'packages', ['--id', 'p1', '--input', file]);
  assert.equal(sent.receipt.accepted, true, JSON.stringify(sent));
  await writeFile(file, JSON.stringify({ ticket: 'forged', packages: [] }));
  assert.equal(JSON.parse(build(f, 'packages', ['--id', 'p2', '--input', file]).stdout).error, 'INPUT');
  assert.equal(JSON.parse(build(f, 'packages', ['--id', 'p3']).stdout).error, 'INPUT');
  assert.equal(JSON.parse(build(f, 'launch', ['--id', 'p4']).stdout).error, 'ACTION');
  // hook 拒收含 shell 元字符的命令，CLI 先报错而不是输出一条注定不被接受的信号。
  assert.equal(JSON.parse(build(f, 'phase', ['--id', 'p5', '--phase', 'a&b']).stdout).error, 'INPUT');
});
test('委派子会话不带 --task 也能 role-claim；声明后入口换成角色指引', async () => {
  const f = await fixture();
  await start(f);
  const worker = { sessionId: 'worker-session', turnId: 'worker-turn' };
  await event({ ...f, ...worker }, 'UserPromptSubmit');
  const claimed = await accept(f, 'role-claim', ['--id', 'c1', '--role', 'worker', '--package', 'w1'], worker);
  assert.equal(claimed.receipt.accepted, true, JSON.stringify(claimed));
  const entry = await event({ ...f, sessionId: worker.sessionId, turnId: 'worker-turn-2' }, 'UserPromptSubmit');
  assert.match(entry.hookSpecificOutput.additionalContext, /"role":"worker"/);
  assert.doesNotMatch(entry.hookSpecificOutput.additionalContext, /入口与本会话上一回合相同/);
});
test('回执 revision 为 1 时重放仍复原 expectedRevision=0', () => {
  const session = { turnId: 't1', taskId: 'task-1', ticket: 'k', interruptEpoch: 0, revision: 1, receipts: { e1: { hash: 'h', result: { revision: 1 } } } };
  const state = { sessions: { [sessionKey('p1', 's1')]: session } };
  const payload = buildSignal(state, { project: { projectId: 'p1' } }, 'task-end', { session: 's1', turn: 't1', id: 'e1' });
  assert.equal(payload.expectedRevision, 0);
});
test('同会话后续回合入口只给短指引；SessionStart 恢复完整入口', async () => {
  const f = await fixture();
  const parse = output => JSON.parse(output.hookSpecificOutput.additionalContext.replace(/^[\s\S]*?workflow 入口：/, ''));
  const second = parse(await event({ ...f, turnId: 'turn-2' }, 'UserPromptSubmit'));
  assert.match(second.instruction, /入口与本会话上一回合相同/);
  assert.equal(second.signal.examples, undefined);
  const resumed = parse(await event({ ...f, turnId: 'turn-2' }, 'SessionStart', { source: 'compact' }));
  assert.ok(resumed.signal.examples.length);
  assert.doesNotMatch(resumed.instruction, /入口与本会话上一回合相同/);
});
test('Stop 与显式 save 后未再改状态不重复落盘；中间 save 后继续改状态仍二次落盘；未注册目录零匹配返回 null', async () => {
  const f = await fixture();
  await start(f);
  const r0 = (await readState(f.directory)).revision;
  await event(f, 'Stop');
  assert.equal((await readState(f.directory)).revision, r0 + 1);
  await mutate(f.directory, async (state, save) => {
    state.customStep = 1;
    await save();
    state.customStep = 2;
  });
  const after = await readState(f.directory);
  assert.equal(after.revision, r0 + 3);
  assert.equal(after.customStep, 2);
  assert.equal(await resolveProject(after, path.dirname(f.directory)), null);
});


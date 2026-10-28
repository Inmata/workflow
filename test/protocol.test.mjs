import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { archiveLifecycleEvents, digest, mutate, pendingLifecycleEvents, readState, recordLifecycleEvent, withLock } from '../src/store.mjs';
import { consumeLifecycleEvents, taskKey } from '../src/protocol.mjs';
import { handleHook } from '../src/hooks.mjs';
import { createPending } from '../src/knowledge.mjs';
import { assertRoundCheck, deadPid, deliver, emit, entry, event, fixture, identity, start, temporary } from './helpers.mjs';

test('交付不要求复盘：Stop 每回合最多挡一次提醒 task-end，重启、跨 turn 与压缩不补偿经验', async () => {
  const f = await fixture();
  await start(f);
  assert.equal((await deliver(f)).result.accepted, true);
  assertRoundCheck(await event(f, 'Stop'));
  assert.deepEqual(await event(f, 'Stop'), {});
  const persisted = await readState(f.directory);
  assert.equal(persisted.tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  assertRoundCheck(await event(f, 'Stop'));
  await start(f);
  await deliver(f, null, 'delivery-2');
  const beforeCompact = await identity(f);
  await event(f, 'PreCompact');
  assert.deepEqual(await event(f, 'PostCompact'), {});
  await event(f, 'SessionStart', { source: 'compact' });
  assert.deepEqual(await identity(f), beforeCompact);
  // 压缩不开新回合，本回合已挡过。
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  assert.equal((await emit(f, { action: 'task-end' })).result.accepted, true);
});
test('V03/V08 未绑定任务、operation-only、waiting-user 不核对；executing 挡一次', async () => {
  const f = await fixture();
  assert.deepEqual(await event(f, 'Stop'), {});
  await start(f);
  for (const phase of ['operation-only', 'waiting-user']) {
    await emit(f, { action: 'phase', phase });
    assert.deepEqual(await event(f, 'Stop', { last_assistant_message: '这里是否已经完成？' }), {});
  }
  await emit(f, { action: 'phase', phase: 'executing' });
  assertRoundCheck(await event(f, 'Stop'));
  await emit(f, { action: 'phase', phase: 'unknown' });
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
});
test('V06 有理由无新经验和可定位待办放行，伪造 updated 拒绝且不改变阶段', async () => {
  const f = await fixture();
  await start(f);
  const invalid = await deliver(f, { status: 'updated', transactionIds: ['fake'] });
  assert.equal(invalid.result.accepted, false);
  assertRoundCheck(await event(f, 'Stop'));
  await deliver(f, { status: 'no-new-learning', reason: '已有资料完整承接' });
  assert.deepEqual(await event(f, 'Stop'), {});
  const pending = await createPending(f.directory, { ...await identity(f), reason: '证据尚缺', evidence: ['test:原始记录'] });
  await deliver(f, { status: 'pending-recovery', pendingId: pending.pendingId, reason: '待补原始证据' }, 'delivery-2');
  assert.deepEqual(await event(f, 'Stop'), {});
});
test('V09 中断撤销票据，迟到信号拒绝，新用户回合不恢复业务', async () => {
  const f = await fixture();
  await start(f);
  const stale = { ...await identity(f), taskId: f.taskId, signalId: 'late', action: 'phase', phase: 'delivering', deliveryId: 'late-delivery' };
  await event(f, 'Interrupt');
  const late = await emit(f, stale);
  assert.equal(late.result.accepted, false);
  assert.deepEqual(await event(f, 'Stop'), {});
  f.turnId = 'turn-after-interrupt';
  await event(f, 'UserPromptSubmit');
  assert.deepEqual(await event(f, 'Stop'), {});
  const state = await readState(f.directory);
  assert.ok(Object.values(state.pending).some(p => p.kind === 'business-incomplete'));
});
test('P01 两个 Lead 会话共用任务时，结束其中一个不挂起任务；最后一个结束才保存待办', async () => {
  const f = await fixture();
  await start(f);
  // 第二个 Lead 会话显式接续同一任务。
  const other = { ...f, sessionId: 'session-2', turnId: 'turn-2b' };
  await event(other, 'UserPromptSubmit');
  const relayed = await emit(other, { action: 'task-start' });
  assert.equal(relayed.result.accepted, true, JSON.stringify(relayed.result));
  await event(f, 'Interrupt');
  let state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 0);
  assert.equal(Object.values(state.sessions).find(s => s.sessionId === 'session-1').interrupted, true);
  await event(other, 'SessionEnd');
  state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'suspended');
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 1);
});
test('P01 旧状态的会话缺 interrupted/ticket 字段时保守按未中断，不挂起仍在用的任务', async () => {
  const f = await fixture();
  await start(f);
  // 第二个 Lead 会话接续同一任务后，清掉它的 interrupted/ticket 字段，模拟升级前的旧状态。
  const other = { ...f, sessionId: 'session-2', turnId: 'turn-2b' };
  await event(other, 'UserPromptSubmit');
  await emit(other, { action: 'task-start' });
  await mutate(f.directory, async state => {
    for (const session of Object.values(state.sessions)) if (session.sessionId !== f.sessionId) { delete session.interrupted; delete session.lastSeenAt; delete session.ticket; }
  });
  await event(f, 'Interrupt');
  const state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 0);
});
test('P01 结束事件在锁竞争时先落盘，下一次入口幂等消费，重复事件只生效一次', async () => {
  const f = await fixture();
  await start(f);
  // 状态锁被短暂占用：Interrupt 事件独立落盘但拿不到锁，不声称已应用。
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withLock(f.directory, 'state', async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 30));
  const contended = await event(f, 'Interrupt');
  assert.match(contended.systemMessage, /已另存为本机待办/);
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  release();
  await holder;
  // 下一次入口消费待办：任务挂起，票据失效。
  f.turnId = 'turn-after-interrupt';
  await event(f, 'UserPromptSubmit');
  let state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'suspended');
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 1);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.interrupted, false, '新回合要能继续接续');
  assert.equal(session.turnId, 'turn-after-interrupt');
  // 重复结束事件不再增加中断轮次或待办。
  await event(f, 'SessionEnd');
  await event(f, 'SessionEnd');
  state = await readState(f.directory);
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 1);
  assert.equal(Object.values(state.sessions).find(item => item.sessionId === f.sessionId).interruptEpoch, 2);
});
test('P01 旧回合的结束事件迟到：不打断新回合，只保留待办', async () => {
  const f = await fixture();
  await start(f);
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  f.turnId = 'turn-1';
  await event(f, 'SessionEnd');
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.turnId, 'turn-2');
  assert.equal(session.interrupted, false);
  assert.ok(session.ticket);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  const pending = Object.values(state.pending).filter(item => item.kind === 'business-incomplete');
  assert.equal(pending.length, 1);
  assert.match(pending[0].reason, /晚于新回合/);
});
test('P01 结束事件缺会话关联时保留待办并解释，不猜身份', async () => {
  const f = await fixture();
  await start(f);
  await event({ ...f, sessionId: 'session-never-registered' }, 'SessionEnd');
  const state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  assert.equal((await pendingLifecycleEvents(f.directory)).deferred.length, 1);
});
test('P01 残留的恢复 guard 不再让连续请求一直 LOCKED：死持有者锁可回收，损坏 guard 给诊断', async () => {
  const f = await fixture();
  await start(f);
  const locks = path.join(f.directory, 'locks');
  await mkdir(locks, { recursive: true });
  const lockFile = path.join(locks, `${digest('state')}.lock`);
  const guardFile = `${lockFile}.recovery`;
  const dead = deadPid();  // 崩溃进程留下的锁与 guard：第二次请求能辨认并回收，而不是永远 LOCKED。
  await writeFile(lockFile, JSON.stringify({ pid: dead, token: 'dead-token', name: 'state', createdAt: new Date(0).toISOString() }));
  await writeFile(guardFile, JSON.stringify({ pid: dead, name: 'state', createdAt: new Date(0).toISOString() }));
  const recovered = await event(f, 'Stop');
  assert.equal(recovered.systemMessage, undefined, JSON.stringify(recovered));
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  // 损坏的 guard 不猜成死锁：保留现场并给出可执行诊断。
  await writeFile(lockFile, JSON.stringify({ pid: dead, token: 'second-dead-token', name: 'state', createdAt: new Date(0).toISOString() }));
  await writeFile(guardFile, '{broken');
  const broken = await event(f, 'Stop');
  assert.match(broken.systemMessage, /LOCKED/);
  assert.ok(broken.systemMessage.includes(path.basename(guardFile)));
  assert.equal(await readFile(guardFile, 'utf8'), '{broken');
  assert.ok(await readFile(lockFile, 'utf8'));
});
test('同一 signalId 幂等重放，错误 revision 与篡改正文拒绝', async () => {
  const f = await fixture();
  await start(f);
  const first = await emit(f, { action: 'phase', phase: 'executing', signalId: 'stable-signal' });
  const repeated = await emit(f, first.payload);
  assert.equal(repeated.result.accepted, true);
  assert.equal(repeated.result.replayed, true);
  const changed = await emit(f, { ...first.payload, phase: 'delivering', deliveryId: 'other' });
  assert.equal(changed.result.accepted, false);
  const stale = await emit(f, { action: 'phase', phase: 'waiting-user', expectedRevision: 0 });
  assert.equal(stale.result.accepted, false);
});
test('V02 不同 session/turn 不消费当前回执或 Stop 预算', async () => {
  const f = await fixture();
  await start(f);
  await deliver(f);
  assert.deepEqual(await event(f, 'Stop', { session_id: 'other-session' }), {});
  assert.deepEqual(await event(f, 'Stop', { turn_id: 'other-turn' }), {});
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  assertRoundCheck(await event(f, 'Stop'));
});
test('pending-only 兼容字段不再为无经验交付制造待办', async () => {
  const f = await fixture({ coexistenceMode: 'pending-only' });
  await start(f);
  await deliver(f);
  assertRoundCheck(await event(f, 'Stop'));
  const state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  assert.equal(Object.values(state.pending).filter(p => p.kind === 'knowledge-pending').length, 0);
});
test('未知 schema 和损坏状态不阻断宿主，原字节保持', async () => {
  const f = await fixture();
  const file = path.join(f.directory, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.schemaVersion = 999;
  await writeFile(file, JSON.stringify(state));
  const before = await readFile(file, 'utf8');
  assert.equal((await event(f, 'Stop')).decision, undefined);
  assert.equal(await readFile(file, 'utf8'), before);
  await writeFile(file, '{broken');
  assert.equal((await event(f, 'Stop')).decision, undefined);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('P01 状态已保存但归档前崩溃：事件仍在队列，重放靠已持久化回执只生效一次', async () => {
  const f = await fixture();
  await start(f);
  const recorded = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  // 真实 hook 会把记录时的票据写进事件；缺票据的事件现在按"不可校验"保守处理，见后面的回归测试。
  const name = await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'Interrupt', projectId: f.projectId, sessionId: f.sessionId, taskId: f.taskId, turnId: f.turnId, ticket: recorded.ticket, at: new Date().toISOString() });
  let consumed;
  // 只提交状态、不执行归档，模拟保存成功后进程在归档前退出。
  await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state); });
  assert.equal(consumed.archive.length, 1);
  assert.ok((await pendingLifecycleEvents(f.directory)).queued.includes(name));
  let state = await readState(f.directory);
  assert.equal(Object.values(state.sessions).find(item => item.sessionId === f.sessionId).interruptEpoch, 1);
  // 下一次入口重新消费：回执命中只归档，不再次中断、不重复补待办。
  await event(f, 'SessionEnd');
  state = await readState(f.directory);
  assert.equal(Object.values(state.sessions).find(item => item.sessionId === f.sessionId).interruptEpoch, 1);
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 1);
  assert.deepEqual((await pendingLifecycleEvents(f.directory)).queued, []);
});
test('P01 状态写入失败时不归档事件，恢复后可补消费且只生效一次', async t => {
  const f = await fixture();
  await start(f);
  const file = path.join(f.directory, 'state.json');
  await chmod(file, 0o444);
  const output = await event(f, 'Interrupt');
  await chmod(file, 0o666);
  const persisted = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  if (persisted.interrupted) { t.skip('当前平台可覆盖只读文件，无法注入状态写入失败'); return; }
  assert.match(output.systemMessage, /STATE_WRITE_FAILED/);
  assert.match(output.systemMessage, /已另存为本机待办/);
  assert.equal((await pendingLifecycleEvents(f.directory)).queued.length, 1);
  // 磁盘恢复后下一次入口补消费：中断与回执保存，事件随后归档。
  await event(f, 'Stop');
  const state = await readState(f.directory);
  assert.equal(Object.values(state.sessions).find(item => item.sessionId === f.sessionId).interruptEpoch, 1);
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 1);
  assert.deepEqual((await pendingLifecycleEvents(f.directory)).queued, []);
});
test('P01 结束事件缺少宿主回合标识时不推断当前回合，不撤销新票据', async () => {
  const f = await fixture();
  await start(f);
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  const before = await readState(f.directory);
  const ticket = Object.values(before.sessions).find(item => item.sessionId === f.sessionId).ticket;
  const output = await handleHook(f.directory, { hook_event_name: 'SessionEnd', cwd: f.project, session_id: f.sessionId }, { synthetic: true, entry });
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.turnId, 'turn-2');
  assert.equal(session.interrupted, false);
  assert.equal(session.ticket, ticket);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  const pending = Object.values(state.pending).filter(item => item.kind === 'business-incomplete');
  assert.equal(pending.length, 1);
  assert.match(pending[0].reason, /无法确认属于当前回合/);
  assert.equal((await pendingLifecycleEvents(f.directory)).deferred.length, 1);
  assert.match(output.systemMessage, /缺少可信项目\/会话关联/);
});
test('P01 入口登记与结束事件交错：deferred 记录重试后在会话登记后消费，不撤销新回合', async () => {
  const f = await fixture();
  await start(f);
  const sessionId = 'session-interleaved';
  // 结束事件先到：会话尚未登记，事件只能先落 deferred。
  await handleHook(f.directory, { hook_event_name: 'SessionEnd', cwd: f.project, session_id: sessionId, turn_id: 'turn-old' }, { synthetic: true, entry });
  assert.equal((await pendingLifecycleEvents(f.directory)).deferred.length, 1);
  // 入口随后登记同一会话的新回合。
  await handleHook(f.directory, { hook_event_name: 'UserPromptSubmit', cwd: f.project, session_id: sessionId, turn_id: 'turn-new' }, { synthetic: true, entry });
  // 下一次消费重新读取 deferred：会话已登记，事件属于旧回合，按迟到处理。
  let consumed;
  await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state, { retryIntervalMs: 0 }); });
  await archiveLifecycleEvents(f.directory, consumed.archive);
  assert.equal(consumed.late.length, 1);
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.sessionId === sessionId);
  assert.equal(session.turnId, 'turn-new');
  assert.equal(session.interrupted, false);
  assert.ok(session.ticket);
  assert.deepEqual((await pendingLifecycleEvents(f.directory)).deferred, []);
});
test('P01 deferred 记录有界重试：超限后停止自动重试，留下可操作待办与诊断', async () => {
  const f = await fixture();
  await start(f);
  await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'SessionEnd', projectId: f.projectId, sessionId: 'session-ghost', taskId: f.taskId, turnId: 'turn-ghost', at: new Date().toISOString() });
  const pass = async () => {
    let consumed;
    await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state, { retryIntervalMs: 0, maxAttempts: 3 }); });
    await archiveLifecycleEvents(f.directory, consumed.archive);
    return consumed;
  };
  const first = await pass();
  assert.equal(first.deferred.length, 1);
  assert.equal(first.deferred[0].escalated, undefined);
  await pass();
  const escalated = await pass();
  assert.equal(escalated.deferred[0].escalated, true);
  // 再入一次不再自动重试，也不重复补待办。
  const settled = await pass();
  assert.equal(settled.deferred[0].escalated, true);
  const state = await readState(f.directory);
  const pending = Object.values(state.pending).filter(item => item.kind === 'business-incomplete');
  assert.equal(pending.length, 1);
  const deferredFolder = path.join(f.directory, 'lifecycle-events', 'deferred');
  const notes = (await readdir(deferredFolder)).filter(name => name.endsWith('.reason.txt'));
  assert.equal(notes.length, 1);
  assert.match(await readFile(path.join(deferredFolder, notes[0]), 'utf8'), /不再自动重试/);
});
test('P01 升级诊断提交后崩溃：状态记下待写，下一次入口补写且不重复', async () => {
  const f = await fixture();
  await start(f);
  await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'SessionEnd', projectId: f.projectId, sessionId: 'session-ghost', taskId: f.taskId, turnId: 'turn-ghost', at: new Date().toISOString() });
  const deferredFolder = path.join(f.directory, 'lifecycle-events', 'deferred');
  const consume = async () => {
    let consumed;
    await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state, { retryIntervalMs: 0, maxAttempts: 2 }); });
    return consumed;
  };
  // 第一遍移入 deferred 并写初始原因；第二遍升级后只提交状态，模拟写完状态就崩溃。
  await archiveLifecycleEvents(f.directory, (await consume()).archive);
  const escalated = await consume();
  assert.equal(escalated.deferred[0].escalated, true);
  assert.equal(escalated.deferred[0].notePending, true);
  assert.match(escalated.deferred[0].note, /不再自动重试/);
  assert.doesNotMatch(await readFile(path.join(deferredFolder, (await readdir(deferredFolder)).find(name => name.endsWith('.reason.txt'))), 'utf8'), /不再自动重试/);
  let state = await readState(f.directory);
  const meta = Object.values(state.lifecycleDeferred).find(item => item.escalated);
  assert.equal(meta.notePending, true);
  assert.match(meta.note, /不再自动重试/);
  // 下一次入口重新发现原因文件与状态不一致，补写。
  const retried = await consume();
  assert.equal(retried.deferred[0].notePending, true);
  const archived = await archiveLifecycleEvents(f.directory, retried.archive);
  assert.deepEqual(archived.failed, []);
  const notes = (await readdir(deferredFolder)).filter(name => name.endsWith('.reason.txt'));
  assert.equal(notes.length, 1);
  assert.match(await readFile(path.join(deferredFolder, notes[0]), 'utf8'), /不再自动重试/);
  // 再入一次确认一致后清除待写标记，不重复写。
  const settled = await consume();
  await archiveLifecycleEvents(f.directory, settled.archive);
  state = await readState(f.directory);
  assert.equal(Object.values(state.lifecycleDeferred).find(item => item.escalated).notePending, false);
  assert.equal((await readdir(deferredFolder)).filter(name => name.endsWith('.reason.txt')).length, 1);
});
test('P01 原因文件写入失败如实上报、状态保留待写并在下一次入口重试', async () => {
  const f = await fixture();
  await start(f);
  await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'SessionEnd', projectId: f.projectId, sessionId: 'session-ghost', taskId: f.taskId, turnId: 'turn-ghost', at: new Date().toISOString() });
  const deferredFolder = path.join(f.directory, 'lifecycle-events', 'deferred');
  const pass = async () => {
    let consumed;
    await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state, { retryIntervalMs: 0, maxAttempts: 2 }); });
    const archived = await archiveLifecycleEvents(f.directory, consumed.archive);
    return { consumed, archived };
  };
  await pass();
  const [eventName] = (await readdir(deferredFolder)).filter(name => name.endsWith('.json'));
  const notePath = path.join(deferredFolder, `${eventName}.reason.txt`);
  // 让原因路径无法写入：把已有原因文件移开，用同名目录占住（归档移动，不删除）。
  await rename(notePath, `${notePath}.moved`);
  await mkdir(notePath);
  const escalated = await pass();
  assert.equal(escalated.consumed.deferred[0].escalated, true);
  assert.equal(escalated.consumed.deferred[0].notePending, true);
  assert.equal(escalated.archived.failed.length, 1);
  assert.equal(escalated.archived.failed[0].to, 'deferred-note');
  const state = await readState(f.directory);
  assert.equal(Object.values(state.lifecycleDeferred).find(item => item.escalated).notePending, true);
  // 下一次入口仍会重试；移除障碍（改名移开目录）后写入成功。
  await rename(notePath, `${notePath}.blocked`);
  const retried = await pass();
  assert.deepEqual(retried.archived.failed, []);
  assert.match(await readFile(notePath, 'utf8'), /不再自动重试/);
});
test('P01 原因文件写入失败时入口提示不指向不存在的文件，并带出诊断正文', async () => {
  const f = await fixture();
  await start(f);
  await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'SessionEnd', projectId: f.projectId, sessionId: 'session-ghost', taskId: f.taskId, turnId: 'turn-ghost', at: new Date().toISOString() });
  const deferredFolder = path.join(f.directory, 'lifecycle-events', 'deferred');
  const pass = async () => {
    let consumed;
    await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state, { retryIntervalMs: 0, maxAttempts: 1 }); });
    return archiveLifecycleEvents(f.directory, consumed.archive);
  };
  await pass();
  await pass();
  const [eventName] = (await readdir(deferredFolder)).filter(name => name.endsWith('.json'));
  const notePath = path.join(deferredFolder, `${eventName}.reason.txt`);
  await rename(notePath, `${notePath}.moved`);
  await mkdir(notePath);
  // 下一次入口消费时原因文件仍不可写：提示带出状态里的诊断正文，并如实说明写入失败。
  const output = await event(f, 'SessionEnd');
  assert.match(output.systemMessage, /原因文件尚未确认写入/);
  assert.match(output.systemMessage, /不再自动重试/);
  assert.match(output.systemMessage, /原因文件写入失败/);
});
test('P01 deferred 目录损坏时保留诊断元数据，不当作已清空', async () => {
  const directory = await temporary('lifecycle-meta-');
  const folder = path.join(directory, 'lifecycle-events');
  await mkdir(folder, { recursive: true });
  // 目录被同名文件占住：不能读成"没有 deferred 记录"，否则状态里的待写诊断会被剪掉。
  await writeFile(path.join(folder, 'deferred'), 'occupied');
  const meta = { attempts: 5, reason: '关联不足', escalated: true, note: '诊断正文', notePending: true };
  const state = { lifecycleDeferred: { 'ghost.json': { ...meta } } };
  const consumed = await consumeLifecycleEvents(directory, state);
  assert.ok(consumed.deferred.some(item => item.reason === 'unreadable-deferred'));
  assert.deepEqual(state.lifecycleDeferred['ghost.json'], meta);
});
test('P01 同一 turnId 重建票据后，记录旧票据的结束事件不撤销新票据', async () => {
  const f = await fixture();
  await start(f);
  const recorded = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'Interrupt', projectId: f.projectId, sessionId: f.sessionId, taskId: f.taskId, turnId: f.turnId, ticket: recorded.ticket, at: new Date().toISOString() });
  // 会话中断后入口用相同 turnId 重建票据；事件记录的旧票据此时已失效。
  await mutate(f.directory, async state => {
    const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
    session.interruptEpoch += 1;
    session.ticket = 'ticket-rebuilt';
  });
  let consumed;
  await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state); });
  await archiveLifecycleEvents(f.directory, consumed.archive);
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(consumed.applied.length, 0);
  assert.equal(consumed.late.length, 1);
  assert.equal(session.interrupted, false);
  assert.equal(session.ticket, 'ticket-rebuilt');
  assert.equal(session.interruptEpoch, 1);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  const pending = Object.values(state.pending).filter(item => item.kind === 'business-incomplete');
  assert.equal(pending.length, 1);
  assert.match(pending[0].reason, /票据/);
});
test('P01 结束事件没有记录票据时不中断当前回合，只保留待办', async () => {
  const f = await fixture();
  await start(f);
  const before = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'SessionEnd', projectId: f.projectId, sessionId: f.sessionId, taskId: f.taskId, turnId: f.turnId, at: new Date().toISOString() });
  let consumed;
  await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state); });
  await archiveLifecycleEvents(f.directory, consumed.archive);
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(consumed.applied.length, 0);
  assert.equal(consumed.late.length, 1);
  assert.equal(session.interrupted, false);
  assert.equal(session.ticket, before.ticket);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  const pending = Object.values(state.pending).filter(item => item.kind === 'business-incomplete');
  assert.equal(pending.length, 1);
  assert.match(pending[0].reason, /票据/);
});
test('P01 不同事件/回合复用同一宿主事件 ID 不会被误判重复', async () => {
  const f = await fixture();
  await start(f);
  const recorded = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  const base = { kind: 'lifecycle', projectId: f.projectId, sessionId: f.sessionId, taskId: f.taskId, ticket: recorded.ticket, hostEventId: 'host-shared-id', at: new Date().toISOString() };
  await recordLifecycleEvent(f.directory, { ...base, event: 'Interrupt', turnId: f.turnId });
  await recordLifecycleEvent(f.directory, { ...base, event: 'SessionEnd', turnId: 'turn-other' });
  let first;
  await mutate(f.directory, async state => { first = await consumeLifecycleEvents(f.directory, state); });
  // 同 ID 但事件/回合不同：两个都要被处理，而不是后一个被当成重复归档。
  assert.equal(first.applied.length, 1);
  assert.equal(first.late.length, 1);
  assert.equal(first.archive.filter(item => item.outcome === 'duplicate').length, 0);
  let state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.interruptEpoch, 1);
  assert.equal(Object.keys(session.lifecycleReceipts).length, 2);
  assert.ok(Object.keys(session.lifecycleReceipts).every(key => key.startsWith('scope:')));
  // 再消费同一批文件：各自命中自己的回执，只归档为重复，不再生效。
  let second;
  await mutate(f.directory, async state => { second = await consumeLifecycleEvents(f.directory, state); });
  assert.equal(second.applied.length, 0);
  assert.equal(second.late.length, 0);
  assert.equal(second.archive.length, 2);
  assert.ok(second.archive.every(item => item.outcome === 'duplicate'));
  await archiveLifecycleEvents(f.directory, second.archive);
});
test('P01 旧版只按宿主事件 ID 记的回执兼容读取，不重复生效', async () => {
  const f = await fixture();
  await start(f);
  const recorded = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'Interrupt', projectId: f.projectId, sessionId: f.sessionId, taskId: f.taskId, turnId: f.turnId, ticket: recorded.ticket, hostEventId: 'legacy-host-id', at: new Date().toISOString() });
  await mutate(f.directory, async state => {
    const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
    session.lifecycleReceipts = { 'event:legacy-host-id': { event: 'Interrupt', turnId: f.turnId, at: new Date().toISOString(), outcome: 'applied' } };
  });
  let consumed;
  await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state); });
  await archiveLifecycleEvents(f.directory, consumed.archive);
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(consumed.applied.length, 0);
  assert.equal(consumed.archive[0].outcome, 'duplicate');
  assert.equal(session.interrupted, false);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
});
test('P01 移入 deferred 后原因文件写入失败：报告真实位置并在下一次入口补写', async () => {
  const f = await fixture();
  await start(f);
  const name = await recordLifecycleEvent(f.directory, { kind: 'lifecycle', event: 'SessionEnd', projectId: f.projectId, sessionId: 'session-ghost', taskId: f.taskId, turnId: 'turn-ghost', at: new Date().toISOString() });
  const deferredFolder = path.join(f.directory, 'lifecycle-events', 'deferred');
  await mkdir(deferredFolder, { recursive: true });
  const notePath = path.join(deferredFolder, `${name}.reason.txt`);
  // 用同名目录占住原因文件路径：移动本身成功，只有原因副本写入失败。
  await mkdir(notePath);
  let consumed;
  await mutate(f.directory, async state => { consumed = await consumeLifecycleEvents(f.directory, state); });
  const archived = await archiveLifecycleEvents(f.directory, consumed.archive);
  assert.equal(archived.failed.length, 1);
  assert.equal(archived.failed[0].stage, 'note');
  assert.equal(archived.failed[0].location, 'deferred');
  const pending = await pendingLifecycleEvents(f.directory);
  assert.deepEqual(pending.queued, []);
  assert.ok(pending.deferred.includes(name), '事件已经移入 deferred/，不能报告成仍在原处');
  let state = await readState(f.directory);
  const meta = state.lifecycleDeferred[name];
  assert.equal(meta.notePending, true);
  assert.equal(meta.note, meta.reason);
  // 下一次入口按状态里的待写标记补写原因文件。
  await rename(notePath, `${notePath}.blocked`);
  let retried;
  await mutate(f.directory, async state => { retried = await consumeLifecycleEvents(f.directory, state); });
  const retriedArchive = await archiveLifecycleEvents(f.directory, retried.archive);
  assert.deepEqual(retriedArchive.failed, []);
  assert.match(await readFile(notePath, 'utf8'), /会话未登记/);
  state = await readState(f.directory);
  assert.equal(state.lifecycleDeferred[name].notePending, true, '写成功后的待写标记由下一次入口确认清除');
  let confirmed;
  await mutate(f.directory, async state => { confirmed = await consumeLifecycleEvents(f.directory, state); });
  await archiveLifecycleEvents(f.directory, confirmed.archive);
  assert.equal((await readState(f.directory)).lifecycleDeferred[name].notePending, false);
});

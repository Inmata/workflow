import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { digest, readState, withLock, recordLifecycleEvent, pendingLifecycleEvents } from '../src/store.mjs';
import { applyKnowledge, inspectKnowledge, recoverTransaction } from '../src/knowledge.mjs';
import { deadPid, event, fixture, identity, LOCK_TEST_HOOKS, root, start, temporary } from './helpers.mjs';

test('V11 活锁竞争不抢占，持有者释放后可继续', async () => {
  const directory = await temporary('lock-');
  let acquired, release;
  const entered = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const owner = withLock(directory, 'shared', async () => { acquired(); await gate; return 'done'; });
  await entered;
  await assert.rejects(withLock(directory, 'shared', async () => 'bad', { budgetMs: 120 }), { code: 'LOCKED' });
  release();
  assert.equal(await owner, 'done');
  assert.equal(await withLock(directory, 'shared', async () => 'next'), 'next');
});
test('P01 短暂锁争用有总预算重试：持有者释放后请求成功，预算耗尽才 LOCKED', async () => {
  const directory = await temporary('lock-wait-');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const owner = withLock(directory, 'state', async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiter = withLock(directory, 'state', async () => 'waited', { budgetMs: 1500 });
  setTimeout(release, 300);
  assert.equal(await waiter, 'waited');
  await owner;
  // 预算耗尽后保守失败，不按锁年龄抢活锁：持有者仍在运行时锁保持原位。
  let releaseHeld;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const owner2 = withLock(directory, 'state', async () => { await held; });
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(withLock(directory, 'state', async () => 'no', { budgetMs: 100 }), { code: 'LOCKED' });
  assert.equal((await readdir(path.join(directory, 'locks'))).filter(name => name.endsWith('.hold')).length, 1);
  releaseHeld();
  await owner2;
});
test('P01 旧格式残留只读辨认：损坏 guard 给诊断，死持有者不再阻塞，原文件保留', async () => {
  const directory = await temporary('lock-legacy-');
  const locks = path.join(directory, 'locks');
  await mkdir(locks, { recursive: true });
  const lockFile = path.join(locks, `${digest('state')}.lock`);
  const guardFile = `${lockFile}.recovery`;
  const dead = deadPid();
  // 旧格式死锁 + 损坏 guard：guard 不猜成死锁，诊断指向具体文件；两者都原样保留。
  await writeFile(lockFile, JSON.stringify({ pid: dead, token: 't-dead', name: 'state', createdAt: new Date(0).toISOString() }));
  await writeFile(guardFile, '{}');
  const old = new Date(Date.now() - 60_000);
  await utimes(guardFile, old, old);
  await assert.rejects(withLock(directory, 'state', async () => 'no', { budgetMs: 100 }), error => {
    assert.equal(error.code, 'LOCKED');
    assert.match(error.message, /guard/);
    assert.ok(error.message.includes(path.basename(guardFile)));
    return true;
  });
  assert.equal(await readFile(guardFile, 'utf8'), '{}');
  assert.ok(await readFile(lockFile, 'utf8'));
  // 旧格式死持有者不再需要被"摘走"：新协议忽略它并留一份有界诊断，原文件仍在。
  await writeFile(guardFile, JSON.stringify({ pid: dead, name: 'state', createdAt: new Date(0).toISOString() }));
  assert.equal(await withLock(directory, 'state', async () => 'recovered', { budgetMs: 800 }), 'recovered');
  assert.ok(await readFile(lockFile, 'utf8'));
  assert.ok(await readFile(guardFile, 'utf8'));
  const retired = path.join(directory, 'retired-locks');
  const notes = (await readdir(retired)).filter(name => name.endsWith('.legacy-note.txt'));
  assert.ok(notes.length >= 1);
  assert.match(await readFile(path.join(retired, notes[0]), 'utf8'), /旧格式/);
});
test('P01 恢复者延迟归档不会移走后来者的活跃持有者（A/B/C 确定性交错）', async () => {
  const directory = await temporary('lock-interleave-');
  const locks = path.join(directory, 'locks');
  const retired = path.join(directory, 'retired-locks');
  await mkdir(locks, { recursive: true });
  const prefix = digest('state');
  const dead = deadPid();
  const deadTicket = path.join(locks, `${prefix}.lock.${dead}.${randomUUID()}.hold`);
  await writeFile(deadTicket, JSON.stringify({ pid: dead, token: 'dead-token', name: 'state', createdAt: new Date(0).toISOString() }));
  let releaseB, pausedB;
  const pausedGate = new Promise(resolve => { pausedB = resolve; });
  const bGate = new Promise(resolve => { releaseB = resolve; });
  let pauseB = true;
  globalThis[LOCK_TEST_HOOKS] = { beforeArchive: async () => {
    if (!pauseB) return;
    pauseB = false;
    pausedB();
    await bGate;
  } };
  let releaseAOperation, holdingA;
  const holdingGate = new Promise(resolve => { holdingA = resolve; });
  const aOperationGate = new Promise(resolve => { releaseAOperation = resolve; });
  let active = 0, maxActive = 0;
  const entered = [];
  const operation = label => async () => {
    active += 1; maxActive = Math.max(maxActive, active); entered.push(label);
    if (label === 'A') { holdingA(); await aOperationGate; }
    active -= 1;
    return label;
  };
  try {
    // B 先读到死票据并在归档前暂停（模拟延迟的恢复者）。
    const b = withLock(directory, 'state', operation('B'), { budgetMs: 4000 });
    await pausedGate;
    // A 完成回收并成为新的活跃持有者。
    const a = withLock(directory, 'state', operation('A'), { budgetMs: 4000 });
    await holdingGate;
    // C 在 A 持有期间进入。
    const c = withLock(directory, 'state', operation('C'), { budgetMs: 4000 });
    // B 恢复：它的归档目标只是那张死票据的唯一名；A 的活跃票据绝不能被动到。
    releaseB();
    await new Promise(resolve => setTimeout(resolve, 150));
    const holds = (await readdir(locks)).filter(name => name.endsWith('.hold'));
    assert.equal(holds.length, 1, `唯一持有票据应保留：${holds.join(', ')}`);
    assert.ok(await readFile(path.join(locks, holds[0]), 'utf8'));
    assert.deepEqual(entered, ['A']);
    assert.equal(maxActive, 1);
    assert.equal((await readdir(retired)).filter(name => name.endsWith('dead-holder.lock')).length, 1);
    releaseAOperation();
    assert.deepEqual((await Promise.all([a, b, c])).sort(), ['A', 'B', 'C']);
    assert.equal(maxActive, 1);
  } finally {
    globalThis[LOCK_TEST_HOOKS].beforeArchive = null;
  }
});
test('P01 持有票据身份以文件名为准：正文 pid 指向死进程时活持有者不被归档', async () => {
  const directory = await temporary('lock-corrupt-');
  const locks = path.join(directory, 'locks');
  const retired = path.join(directory, 'retired-locks');
  await mkdir(locks, { recursive: true });
  const prefix = digest('state');
  const token = randomUUID();
  const liveTicket = path.join(locks, `${prefix}.lock.${process.pid}.${token}.hold`);
  // 文件名 pid 是活进程，正文却指向已退出进程：不能按正文 pid 把活票据当成死锁移走。
  await writeFile(liveTicket, JSON.stringify({ pid: deadPid(), token, name: 'state', createdAt: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 60_000);
  await utimes(liveTicket, old, old);
  await assert.rejects(withLock(directory, 'state', async () => 'bad', { budgetMs: 150 }), error => {
    assert.equal(error.code, 'LOCKED');
    assert.match(error.message, /锁内容不可辨认/);
    assert.ok(error.message.includes(path.basename(liveTicket)));
    return true;
  });
  // 保留现场：既不归档也不删除，等待持有者自行释放或人工核对。
  assert.ok(await readFile(liveTicket, 'utf8'));
  assert.equal((await readdir(retired)).filter(name => name.endsWith('dead-holder.lock')).length, 0);
});
test('P01 多竞争者并发：同一时刻只有一个持有者，全部最终完成', async () => {
  const dead = deadPid();
  for (let round = 0; round < 8; round++) {
    const directory = await temporary('lock-race-');
    const locks = path.join(directory, 'locks');
    await mkdir(locks, { recursive: true });
    const prefix = digest('state');
    const deadTicket = path.join(locks, `${prefix}.lock.${dead}.${randomUUID()}.hold`);
    await writeFile(deadTicket, JSON.stringify({ pid: dead, token: `dead-${round}`, name: 'state', createdAt: new Date(0).toISOString() }));
    let active = 0, maxActive = 0;
    const results = await Promise.all(['a', 'b', 'c'].map(label => withLock(directory, 'state', async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return label;
    }, { budgetMs: 4000 })));
    assert.deepEqual(results.sort(), ['a', 'b', 'c']);
    assert.equal(maxActive, 1, `第 ${round} 轮出现并发持有者`);
    assert.deepEqual((await readdir(locks)).filter(name => /\.(hold|wait)$/.test(name)), [], `第 ${round} 轮遗留票据`);
  }
});
test('P01 崩溃残留都有出口：死持有者、空等待票据、旧待复核文件均按唯一名归档', async () => {
  const directory = await temporary('lock-residue-');
  const locks = path.join(directory, 'locks');
  const retired = path.join(directory, 'retired-locks');
  await mkdir(locks, { recursive: true });
  const prefix = digest('state');
  const dead = deadPid();
  const old = new Date(Date.now() - 60_000);
  // 1) 持有者崩溃留下的唯一票据。
  const deadTicket = path.join(locks, `${prefix}.lock.${dead}.${randomUUID()}.hold`);
  await writeFile(deadTicket, JSON.stringify({ pid: dead, token: 'dead-holder', name: 'state', createdAt: new Date(0).toISOString() }));
  // 2) 创建等待票据后、写入正文前崩溃：文件名带死 pid，可安全归档。
  const emptyWait = path.join(locks, `${prefix}.lock.${dead}.${randomUUID()}.wait`);
  await writeFile(emptyWait, '');
  await utimes(emptyWait, old, old);
  // 3) 旧实现"摘到待复核名"后崩溃留下的唯一文件。
  const legacyQuarantine = path.join(locks, `.${prefix}.lock.recheck-${randomUUID()}`);
  await writeFile(legacyQuarantine, JSON.stringify({ pid: dead, token: 'legacy', name: 'state', createdAt: new Date(0).toISOString() }));
  assert.equal(await withLock(directory, 'state', async () => 'ok', { budgetMs: 1500 }), 'ok');
  const retiredNames = await readdir(retired);
  assert.ok(retiredNames.some(name => name.endsWith('dead-holder.lock')));
  assert.ok(retiredNames.some(name => name.endsWith('dead-waiter.lock')));
  assert.ok(retiredNames.some(name => name.endsWith('legacy-quarantine.lock')));
  assert.deepEqual((await readdir(locks)).filter(name => /\.(hold|wait)$/.test(name)), []);
});
test('P01 生命周期结束事件独立落盘，未消费前保留待办并可用于诊断', async () => {
  const directory = await temporary('lifecycle-');
  await recordLifecycleEvent(directory, { kind: 'lifecycle', event: 'SessionEnd', projectId: 'p', sessionId: 's', turnId: 't', at: new Date().toISOString() });
  const pending = await pendingLifecycleEvents(directory);
  assert.equal(pending.queued.length, 1);
  assert.deepEqual(pending.deferred, []);
});
// 运行中的活进程不能回收；用一个已退出子进程的 pid 作死持有者。
test('V11 真实子进程写入后退出：旧锁只凭操作系统确认进程退出回收，事务辨认成功', async () => {
  const f = await fixture();
  await start(f);
  const before = await inspectKnowledge(f.directory, f.project, 'README.md');
  const request = { ...await identity(f), changes: [{ path: 'README.md', baseline: before.fingerprint, content: '# 新事实\n', responsibility: '项目事实', reason: '真实崩溃测试', evidence: ['test:crash'], candidateIds: [] }] };
  const moduleURL = pathToFileURL(path.join(root, 'src', 'knowledge.mjs')).href;
  const source = `import {applyKnowledge} from ${JSON.stringify(moduleURL)}; await applyKnowledge(process.argv[1], JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8')), {checkpoint(stage) {if(stage==='written') process.exit(23)}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.directory, Buffer.from(JSON.stringify(request)).toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 23, child.stderr);
  const tx = Object.values((await readState(f.directory)).transactions)[0];
  assert.equal(tx.files[0].status, 'prepared');
  const recovered = await recoverTransaction(f.directory, tx.transactionId, f.project);
  assert.equal(recovered.status, 'applied');
  assert.equal(await readFile(path.join(f.project, 'README.md'), 'utf8'), '# 新事实\n');
});
test('V11 快照目录不可写不改正文，状态可写时保留候选待办', async () => {
  const f = await fixture();
  await start(f);
  const before = await inspectKnowledge(f.directory, f.project, 'README.md');
  await writeFile(path.join(f.directory, 'transactions'), '故意占用目录名称');
  const result = await applyKnowledge(f.directory, { ...await identity(f), changes: [{ path: 'README.md', baseline: before.fingerprint, content: '# 不应写入\n', responsibility: '项目资料', reason: '故障注入', evidence: ['test:snapshot-failure'], candidateIds: [] }] });
  assert.equal(result.status, 'pending');
  assert.ok(result.pendingId);
  assert.equal(await readFile(path.join(f.project, 'README.md'), 'utf8'), before.content);
});
test('V11 hook 锁超时/占用保守放行，不消费任务预算', async () => {
  const f = await fixture();
  await start(f);
  await mkdir(path.join(f.directory, 'locks'), { recursive: true });
  const lockFile = path.join(f.directory, 'locks', `${digest('state')}.lock`);
  await writeFile(lockFile, JSON.stringify({ pid: process.pid }));
  assert.equal((await event(f, 'Stop')).decision, undefined);
  const state = await readState(f.directory);
  assert.equal(Object.values(state.tasks)[0].repairIssued, false);
});

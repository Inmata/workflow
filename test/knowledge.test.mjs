import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { applyKnowledge, createPending, inspectKnowledge, recoverTransaction, safeDocument } from '../src/knowledge.mjs';
import { readState } from '../src/store.mjs';
import { deliver, event, fixture, identity, start } from './helpers.mjs';

const candidate = (taskId, id = 'finding-1') => ({ id, taskId, workPackage: 'A1', conditions: '当前隔离项目', finding: '资料缺少已核实前置条件', recommendation: '补写条件并引用证据', evidence: ['test:已核实的输入'] });
async function input(f, changes, candidates = [candidate(f.taskId)]) {
  return { ...await identity(f), changes, candidates };
}
async function change(f, relative = 'README.md', content = '# 项目\n补充已核实条件\n', candidateIds = ['finding-1']) {
  const before = await inspectKnowledge(f.directory, f.project, relative);
  return { path: relative, baseline: before.fingerprint, content, responsibility: '项目事实', reason: '补齐本任务核实的信息', evidence: ['test:原始资料'], candidateIds };
}
test('V06 真实事务保存前快照，updated 引用事务后放行', async () => {
  const f = await fixture();
  await start(f);
  const original = await readFile(path.join(f.project, 'README.md'), 'utf8');
  const request = await input(f, [await change(f)]);
  const tx = await applyKnowledge(f.directory, request);
  assert.equal(tx.status, 'applied');
  assert.equal(await readFile(tx.files[0].snapshot, 'utf8'), original);
  const result = await deliver(f, { status: 'updated', transactionIds: [tx.transactionId] });
  assert.equal(result.result.accepted, true);
  assert.deepEqual(await event(f, 'Stop'), {});
});
test('V11 用户编辑指纹冲突不覆盖，保留候选和待办', async () => {
  const f = await fixture();
  await start(f);
  const request = await input(f, [await change(f)]);
  await writeFile(path.join(f.project, 'README.md'), '用户的新内容\n');
  const tx = await applyKnowledge(f.directory, request);
  assert.equal(tx.status, 'pending');
  assert.equal(tx.files[0].status, 'conflict');
  assert.equal(await readFile(path.join(f.project, 'README.md'), 'utf8'), '用户的新内容\n');
  assert.ok(tx.pendingId);
});
test('V11 多文件部分成功，重交只续未完成项，不重复合并已处置候选', async () => {
  const f = await fixture();
  await start(f);
  const first = await change(f);
  const second = await change(f, 'LESSONS.md', '# 经验\n适用当前版本的有据条目\n', ['finding-2']);
  const request = await input(f, [first, second], [candidate(f.taskId), candidate(f.taskId, 'finding-2')]);
  await writeFile(path.join(f.project, 'LESSONS.md'), '用户已创建的经验\n');
  const partial = await applyKnowledge(f.directory, request);
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.files.map(file => file.status), ['applied', 'conflict']);
  second.baseline = (await inspectKnowledge(f.directory, f.project, 'LESSONS.md')).fingerprint;
  const resumed = await applyKnowledge(f.directory, await input(f, [first, second], []));
  assert.equal(resumed.status, 'applied');
  assert.equal(resumed.files[0].reusedFrom, partial.transactionId);
  assert.equal((await readFile(path.join(f.project, 'README.md'), 'utf8')).split('补充').length, 2);
});
test('V11 崩溃后依前后指纹辨认已写，第三种内容冲突且不重写', async () => {
  const f = await fixture();
  await start(f);
  const request = await input(f, [await change(f)]);
  await assert.rejects(applyKnowledge(f.directory, request, { checkpoint(stage) { if (stage === 'written') { const error = new Error('模拟进程退出'); error.code = 'SIMULATED_CRASH'; throw error; } } }), { code: 'SIMULATED_CRASH' });
  const tx = Object.values((await readState(f.directory)).transactions)[0];
  assert.equal(tx.files[0].status, 'prepared');
  const recovered = await recoverTransaction(f.directory, tx.transactionId, f.project);
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.automaticWrites, 0);
  await writeFile(path.join(f.project, 'README.md'), '用户的第三种内容');
  const conflict = await recoverTransaction(f.directory, tx.transactionId, f.project);
  assert.equal(conflict.files[0].status, 'conflict');
  assert.equal(await readFile(path.join(f.project, 'README.md'), 'utf8'), '用户的第三种内容');
});

test('同一候选的两个目标必须全部成功；独立待办不会随其他事务关闭', async () => {
  const f = await fixture(); await start(f);
  const independent = await createPending(f.directory, { ...await identity(f), reason: '另一项材料缺少证据' });
  const first = await change(f);
  const second = await change(f, 'LESSONS.md', '# 同一发现的第二个目标\n');
  await writeFile(path.join(f.project, 'LESSONS.md'), '用户写入');
  const partial = await applyKnowledge(f.directory, await input(f, [first, second]));
  assert.equal(partial.status, 'partial');
  let state = await readState(f.directory);
  assert.equal(Object.values(state.tasks)[0].candidates['finding-1'].status, 'pending');
  second.baseline = (await inspectKnowledge(f.directory, f.project, 'LESSONS.md')).fingerprint;
  assert.equal((await applyKnowledge(f.directory, await input(f, [second], []))).status, 'applied');
  state = await readState(f.directory);
  assert.equal(Object.values(state.tasks)[0].candidates['finding-1'].status, 'applied');
  assert.equal(state.pending[partial.pendingId].status, 'closed');
  assert.equal(state.pending[independent.pendingId].status, 'open');
});
test('快照准备后外部编辑仍拒绝覆盖', async () => {
  const f = await fixture();
  await start(f);
  const tx = await applyKnowledge(f.directory, await input(f, [await change(f)]), { async checkpoint(stage) { if (stage === 'prepared') await writeFile(path.join(f.project, 'README.md'), '准备后的用户编辑'); } });
  assert.equal(tx.files[0].status, 'conflict');
  assert.equal(await readFile(path.join(f.project, 'README.md'), 'utf8'), '准备后的用户编辑');
});
test('V02 多个 Lead 会话都可写；另一会话先写后旧指纹返回冲突', async () => {
  const f = await fixture({ autoOwner: true });
  await start(f);
  const other = { ...f, sessionId: 'session-2', turnId: 'turn-other', taskId: 'task-other' };
  await event(other, 'UserPromptSubmit');
  await start(other);
  const stale = await change(f);
  assert.equal((await applyKnowledge(other.directory, await input(other, [await change(other, 'README.md', '# 项目\n另一会话的修改\n')], [candidate(other.taskId)]))).status, 'applied');
  const tx = await applyKnowledge(f.directory, await input(f, [stale]));
  assert.equal(tx.files[0].status, 'conflict');
  assert.equal(await readFile(path.join(f.project, 'README.md'), 'utf8'), '# 项目\n另一会话的修改\n');
  assert.equal((await applyKnowledge(f.directory, await input(f, [await change(f)]))).status, 'applied');
});
test('计划、只读、任务范围外、路径逃逸、敏感正文和硬链接拒绝', async () => {
  for (const mode of ['plan', 'read-only']) {
    const f = await fixture();
    await start(f, { mode, allowedPaths: ['README.md'] });
    await assert.rejects(applyKnowledge(f.directory, await input(f, [await change(f)])), { code: 'PERMISSION' });
  }
  const f = await fixture();
  await start(f);
  const outside = { ...await change(f), path: 'outside.md' };
  await assert.rejects(applyKnowledge(f.directory, await input(f, [outside])), { code: 'PERMISSION' });
  for (const relative of ['../outside.md', '/outside.md', 'docs/../../outside.md', '.git/config.md', 'readme.js', 'docs\\escape.md']) await assert.rejects(safeDocument(f.project, relative), { code: 'PATH' });
  const secret = { ...await change(f), content: '-----BEGIN PRIVATE KEY-----\nsynthetic-test-only' };
  await assert.rejects(applyKnowledge(f.directory, await input(f, [secret])), { code: 'SENSITIVE' });
  await link(path.join(f.project, 'README.md'), path.join(f.project, 'hardlink.md'));
  await assert.rejects(safeDocument(f.project, 'hardlink.md'), { code: 'LINK' });
});
test('目录 Junction 逃逸拒绝且不读取目标正文', async () => {
  const f = await fixture();
  const outside = path.join(f.area, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.md'), '非本项目内容');
  await symlink(outside, path.join(f.project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safeDocument(f.project, 'linked/secret.md'), { code: 'LINK' });
});

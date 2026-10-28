// 合成 fixture（synthetic）：验证 task-update 的声明变更、宿主权限优先与失败回滚，不代表真实宿主执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readState } from '../src/store.mjs';
import { taskKey } from '../src/protocol.mjs';
import { applyKnowledge } from '../src/knowledge.mjs';
import { applyAlignment } from '../src/alignment.mjs';
import { entry, event, fixture, identity, start } from './helpers.mjs';

const task = async f => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
const update = (f, value) => emitSignal(f, { action: 'task-update', ...value });
// 直接投递指定 payload：用于验证 revision 冲突与同 signalId 重放，emit 会每次补最新 identity。
async function emitSignal(f, value) {
  const payload = { ...await identity(f), taskId: f.taskId, signalId: `signal-${crypto.randomUUID()}`, ...value };
  return receive(f, payload);
}
async function receive(f, payload) {
  const output = await event(f, 'PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: `node "${entry}" signal --base64 e30=` },
    tool_response: { output: JSON.stringify({ workflow_signal: payload }) },
  });
  const text = output.hookSpecificOutput?.additionalContext;
  assert.ok(text?.startsWith('workflow 回执：'), JSON.stringify(output));
  return JSON.parse(text.slice('workflow 回执：'.length));
}

test('P07 plan→write 在宿主可写时完成，回执返回有效权限与变更摘要', async () => {
  const f = await fixture();
  await start(f, { mode: 'plan', allowedPaths: ['README.md'] });
  const changed = await update(f, { permissions: { mode: 'write', allowedPaths: ['README.md', 'docs/a.md'] } });
  assert.equal(changed.accepted, true, JSON.stringify(changed));
  assert.deepEqual(changed.permissions, { mode: 'write', allowedPaths: ['README.md', 'docs/a.md'] });
  assert.deepEqual(changed.change.permissions.mode, { from: 'plan', to: 'write' });
  assert.deepEqual(changed.change.permissions.allowedPaths, { mode: 'replace', added: ['docs/a.md'], removed: [] });
  assert.match(changed.note, /只记录声明/);
  assert.equal(changed.hostPermissionMode, 'default');
  const stored = await task(f);
  assert.equal(stored.permissions.mode, 'write');
  assert.deepEqual(stored.permissions.allowedPaths, ['README.md', 'docs/a.md']);
  assert.equal(stored.updates.length, 1);
  assert.deepEqual(stored.updates[0].change, changed.change);
});

test('P07 宿主 plan/read-only 时不能经 payload 提升权限；拒绝后状态不变，回到可写再完成', async () => {
  for (const mode of ['plan', 'read-only']) {
    const f = await fixture();
    await start(f, { mode: 'plan', allowedPaths: ['README.md'] });
    f.turnId = `turn-${mode}`;
    await event(f, 'UserPromptSubmit', { permission_mode: mode });
    const before = JSON.stringify(await task(f));
    const denied = await update(f, { permissions: { mode: 'write', allowedPaths: ['README.md', 'docs/a.md'] }, allowedPathsMode: 'append' });
    assert.equal(denied.accepted, false, JSON.stringify(denied));
    assert.equal(denied.reason, 'PERMISSION');
    assert.equal(JSON.stringify(await task(f)), before);
    // 只改目标不扩大权限，在只读/计划宿主下仍可记录。
    assert.equal((await update(f, { goal: '只改目标' })).accepted, true);
    f.turnId = `turn-${mode}-write`;
    await event(f, 'UserPromptSubmit', { permission_mode: 'default' });
    assert.equal((await update(f, { permissions: { mode: 'write' } })).accepted, true);
  }
});

test('P07 追加与收缩 allowedPaths：追加去重，替换按新集合收缩', async () => {
  const f = await fixture();
  await start(f);
  const appended = await update(f, { permissions: { allowedPaths: ['docs/new.md', 'README.md'] }, allowedPathsMode: 'append' });
  assert.equal(appended.accepted, true, JSON.stringify(appended));
  assert.deepEqual(appended.permissions.allowedPaths, ['README.md', 'LESSONS.md', 'docs/说明.md', 'docs/new.md']);
  assert.deepEqual(appended.change.permissions.allowedPaths, { mode: 'append', added: ['docs/new.md'], removed: [] });
  const shrunk = await update(f, { goal: '收缩后的目标', permissions: { allowedPaths: ['README.md'] } });
  assert.equal(shrunk.accepted, true, JSON.stringify(shrunk));
  assert.equal(shrunk.goal, '收缩后的目标');
  assert.deepEqual(shrunk.permissions.allowedPaths, ['README.md']);
  assert.deepEqual(shrunk.change.permissions.allowedPaths, { mode: 'replace', added: [], removed: ['LESSONS.md', 'docs/说明.md', 'docs/new.md'] });
  assert.deepEqual(shrunk.change.goal, { from: '隔离验证任务', to: '收缩后的目标' });
  const stored = await task(f);
  assert.deepEqual(stored.permissions.allowedPaths, ['README.md']);
  assert.equal(stored.goal, '收缩后的目标');
});

test('P07 revision 冲突拒绝且状态不变', async () => {
  const f = await fixture();
  await start(f);
  const stale = { ...await identity(f), taskId: f.taskId, signalId: 'stale-revision', action: 'task-update', permissions: { mode: 'read-only' } };
  await emitSignal(f, { action: 'phase', phase: 'executing' });
  const before = JSON.stringify(await task(f));
  const denied = await receive(f, stale);
  assert.equal(denied.accepted, false);
  assert.equal(denied.reason, 'REVISION');
  assert.equal(JSON.stringify(await task(f)), before);
});

test('P07 同 signalId 同正文命中重放；同 signalId 换正文按 SIGNAL_ID 拒绝', async () => {
  const f = await fixture();
  await start(f);
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'replay-update', action: 'task-update', goal: '重放目标', permissions: { allowedPaths: ['README.md'] } };
  const first = await receive(f, payload);
  assert.equal(first.accepted, true, JSON.stringify(first));
  const again = await receive(f, payload);
  assert.equal(again.replayed, true);
  assert.equal(again.goal, '重放目标');
  const changed = await receive(f, { ...payload, goal: '换正文' });
  assert.equal(changed.accepted, false);
  assert.equal(changed.reason, 'SIGNAL_ID');
  const stored = await task(f);
  assert.equal(stored.goal, '重放目标');
  assert.equal(stored.updates.length, 1);
});

test('P07 Worker/Reviewer 不能扩大自身权限，请求被拒且任务不变', async () => {
  for (const role of ['worker', 'reviewer']) {
    const f = await fixture();
    await start(f);
    const sub = { ...f, sessionId: `${role}-session`, turnId: `${role}-turn` };
    await event(sub, 'UserPromptSubmit');
    const claimed = await emitSignal(sub, { action: 'role-claim', role, packageId: 'p1' });
    assert.equal(claimed.accepted, true, JSON.stringify(claimed));
    const before = JSON.stringify(await task(f));
    const denied = await emitSignal(sub, { action: 'task-update', taskId: f.taskId, permissions: { mode: 'write', allowedPaths: ['README.md', 'secret.md'] } });
    assert.equal(denied.accepted, false, JSON.stringify(denied));
    assert.equal(denied.reason, 'ROLE');
    assert.equal(JSON.stringify(await task(f)), before);
  }
});

test('P07 旧 task-start 接续兼容：保留原 goal/permissions，回执带 kept 与提示', async () => {
  const f = await fixture();
  const first = await start(f);
  assert.equal(first.result.kept, undefined);
  const continued = await emitSignal(f, { action: 'task-start', goal: '试图改目标', permissions: { mode: 'read-only', allowedPaths: [] } });
  assert.equal(continued.accepted, true, JSON.stringify(continued));
  const stored = await task(f);
  assert.deepEqual(continued.kept, { goal: '隔离验证任务', permissions: { mode: 'write', allowedPaths: ['README.md', 'LESSONS.md', 'docs/说明.md'] } });
  assert.match(continued.note, /保留原 goal 与 permissions.*goal、permissions 未生效.*task-update/);
  assert.equal(stored.goal, '隔离验证任务');
  assert.equal(stored.permissions.mode, 'write');
  assert.deepEqual(stored.permissions.allowedPaths, ['README.md', 'LESSONS.md', 'docs/说明.md']);
  // 接续后的回执不会改写首次 task-start 的回执。
  assert.equal(first.result.kept, undefined);
});

test('P07 知识写入按更新后的有效范围检查：追加后可写，收缩后旧路径拒绝', async () => {
  const f = await fixture();
  await start(f, { mode: 'write', allowedPaths: ['README.md'] });
  const request = (id, path, content) => ({
    ...f,
    taskId: f.taskId,
    changes: [{ path, baseline: null, content, responsibility: '项目事实', reason: '验证更新后的授权范围', evidence: ['test:P07'], candidateIds: [id] }],
    candidates: [{ id, taskId: f.taskId, workPackage: 'A1', conditions: '隔离项目', finding: `写入 ${path}`, recommendation: '按任务声明范围写入', evidence: ['test:P07'] }],
  });
  const requestFor = async (id, path, content) => ({ ...await identity(f), ...request(id, path, content) });
  await assert.rejects(applyKnowledge(f.directory, await requestFor('c1', 'LESSONS.md', '# 经验\n范围外\n')), { code: 'PERMISSION' });
  assert.equal((await update(f, { permissions: { allowedPaths: ['LESSONS.md'] }, allowedPathsMode: 'append' })).accepted, true);
  assert.equal((await applyKnowledge(f.directory, await requestFor('c1', 'LESSONS.md', '# 经验\n范围内\n'))).status, 'applied');
  assert.equal((await update(f, { permissions: { allowedPaths: ['README.md'] } })).accepted, true);
  await assert.rejects(applyKnowledge(f.directory, await requestFor('c2', 'LESSONS.md', '# 经验\n收缩后\n')), { code: 'PERMISSION' });
});

test('P07 对齐写入同样按更新后的范围检查：追加后可写，收缩后拒绝', async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, 'docs'), { recursive: true });
  await start(f, { mode: 'write', allowedPaths: ['README.md'] });
  const request = async extra => ({ ...await identity(f), baseline: null, content: '# 对齐\n', ...extra });
  await assert.rejects(applyAlignment(f.directory, f.project, await request()), { code: 'PERMISSION' });
  assert.equal((await update(f, { permissions: { allowedPaths: ['docs/WORKFLOW-ALIGNMENT.md'] }, allowedPathsMode: 'append' })).accepted, true);
  assert.equal((await applyAlignment(f.directory, f.project, await request())).status, 'applied');
  assert.equal((await update(f, { permissions: { allowedPaths: ['README.md'] } })).accepted, true);
  await assert.rejects(applyAlignment(f.directory, f.project, await request()), { code: 'PERMISSION' });
});

test('P07 task-update 拒绝 route/channels/账本等越界字段与空更新', async () => {
  const f = await fixture();
  await start(f);
  const before = JSON.stringify(await task(f));
  for (const field of ['route', 'channels', 'plans', 'packages']) {
    const denied = await update(f, { [field]: field === 'route' ? 'delegated' : field === 'plans' ? ['docs/a.md'] : field === 'packages' ? [] : { worker: 'lead' } });
    assert.equal(denied.accepted, false, field);
    assert.equal(denied.reason, 'UNSUPPORTED');
  }
  assert.equal((await update(f, {})).reason, 'INPUT');
  assert.equal((await update(f, { mode: 'write' })).reason, 'PERMISSION');
  assert.equal((await update(f, { permissions: { mode: 'edit' } })).reason, 'PERMISSION');
  assert.equal((await update(f, { permissions: { allowedPaths: ['a'] }, allowedPathsMode: 'merge' })).reason, 'INPUT');
  assert.equal(JSON.stringify(await task(f)), before);
});

test('P07 直接 Edit/Write 不新增拦截器', async () => {
  const f = await fixture();
  await start(f, { mode: 'read-only', allowedPaths: [] });
  for (const tool_name of ['Edit', 'Write']) {
    const output = await event(f, 'PostToolUse', { tool_name, tool_input: { file_path: 'README.md' }, tool_response: { output: '用户自己的编辑' } });
    assert.deepEqual(output, {});
  }
});

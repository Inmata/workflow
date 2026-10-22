import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { enableProject, disableProject, attachWorktree } from '../src/projects.mjs';
import { getContext } from '../src/context.mjs';
import { fixture, git, temporary, cli } from './helpers.mjs';
import { readState } from '../src/store.mjs';

test('V01 Git 身份读取失败不降级为非 Git 接入，也不改 AGENTS', async () => {
  const area = await temporary('git-identity-failure-');
  for (const marker of ['directory', 'worktree-file']) {
    const project = path.join(area, marker);
    const directory = path.join(area, `${marker}-state`);
    await mkdir(project);
    if (marker === 'directory') git(project, ['init']);
    else await writeFile(path.join(project, '.git'), 'gitdir: ./unavailable-worktree-metadata\n');
    const original = '# 原有约定\nGit 身份不可用时保留\n';
    await writeFile(path.join(project, 'AGENTS.md'), original);
    const result = cli(['project', 'enable', '--root', project, '--state-dir', directory], {
      env: { ...process.env, GIT_CONFIG_COUNT: 'invalid' },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).error, 'GIT_UNAVAILABLE');
    assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), original);
    assert.deepEqual((await readState(directory)).projects, {});
  }
});

test('V01 根与子目录有入口，未接入/嵌套独立 Git/复制入口不继承', async () => {
  const f = await fixture();
  const child = path.join(f.project, 'child');
  await mkdir(child);
  assert.equal((await getContext(f.directory, child, 'lead', f.sessionId)).enabled, true);
  const unrelated = path.join(f.area, 'unrelated');
  await mkdir(unrelated);
  await copyFile(path.join(f.project, 'AGENTS.md'), path.join(unrelated, 'AGENTS.md'));
  assert.equal((await getContext(f.directory, unrelated, 'lead', f.sessionId)).enabled, false);
  const nested = path.join(f.project, 'independent');
  await mkdir(nested);
  git(nested, ['init']);
  assert.equal((await getContext(f.directory, nested, 'lead', f.sessionId)).enabled, false);
});
test('V01 移动后不继承，原绑定记录保留', async () => {
  const f = await fixture();
  const moved = path.join(f.area, 'moved-project');
  await rename(f.project, moved);
  assert.equal((await getContext(f.directory, moved, 'lead', f.sessionId)).enabled, false);
});
test('V02 worktree 必须明确关联并核对公共 Git 目录', async () => {
  const f = await fixture({ git: true });
  git(f.project, ['add', 'README.md']);
  git(f.project, ['commit', '-m', 'test baseline']);
  const tree = path.join(f.area, 'worktree');
  git(f.project, ['worktree', 'add', '-b', 'feature', tree]);
  assert.equal((await getContext(f.directory, tree, 'worker')).enabled, false);
  await attachWorktree(f.directory, f.projectId, tree);
  const context = await getContext(f.directory, tree, 'worker');
  assert.equal(context.enabled, true);
  assert.equal(context.projectId, f.projectId);
  const other = path.join(f.area, 'other-repo');
  await mkdir(other);
  git(other, ['init']);
  await assert.rejects(attachWorktree(f.directory, f.projectId, other), { code: 'IDENTITY' });
});
test('V05/V14 资料不完整可接入，已有 AGENTS 原文保留，重复接入和撤下幂等', async () => {
  const area = await temporary();
  const project = path.join(area, 'bare');
  await mkdir(project);
  const directory = path.join(area, 'state');
  const original = '# 人工约定\r\n保留此行与换行\r\n';
  await writeFile(path.join(project, 'AGENTS.md'), original);
  const first = await enableProject(directory, project);
  const second = await enableProject(directory, project);
  assert.equal(first.projectId, second.projectId);
  assert.equal(second.agentsChanged, false);
  const contents = await readFile(path.join(project, 'AGENTS.md'), 'utf8');
  assert.ok(contents.startsWith(original));
  await assert.rejects(readFile(path.join(project, 'LESSONS.md')), { code: 'ENOENT' });
  await disableProject(directory, project);
  assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), original);
});
test('V14 手改管理区后停用保留原文，知识正文不删', async () => {
  const f = await fixture();
  const file = path.join(f.project, 'AGENTS.md');
  const modified = (await readFile(file, 'utf8')).replace('workflow 已在本机明确接入', '用户改写的 workflow 说明');
  await writeFile(file, modified);
  await writeFile(path.join(f.project, 'LESSONS.md'), '# 经验\n保留');
  const result = await disableProject(f.directory, f.project);
  assert.ok(result.conflict);
  assert.equal(await readFile(file, 'utf8'), modified);
  assert.equal(await readFile(path.join(f.project, 'LESSONS.md'), 'utf8'), '# 经验\n保留');
  assert.equal((await getContext(f.directory, f.project, 'lead')).enabled, false);
});

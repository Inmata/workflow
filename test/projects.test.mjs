import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs, { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { enableProject, disableProject, attachWorktree, blockFrom } from '../src/projects.mjs';
import { getContext } from '../src/context.mjs';
import { fixture, git, temporary, cli } from './helpers.mjs';
import { readState, digest } from '../src/store.mjs';

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
test('V05 管理区写的对齐文件路径与 scan 一致：无 docs/ 用根目录，有 docs/ 用 docs 下', async () => {
  const area = await temporary();
  const directory = path.join(area, 'state');
  const bare = path.join(area, 'bare');
  await mkdir(bare);
  await enableProject(directory, bare);
  const bareText = await readFile(path.join(bare, 'AGENTS.md'), 'utf8');
  assert.ok(bareText.includes('结论写入 WORKFLOW-ALIGNMENT.md'), bareText);
  const withDocs = path.join(area, 'with-docs');
  await mkdir(path.join(withDocs, 'docs'), { recursive: true });
  await enableProject(directory, withDocs);
  assert.ok((await readFile(path.join(withDocs, 'AGENTS.md'), 'utf8')).includes('结论写入 docs/WORKFLOW-ALIGNMENT.md'));
});
test('disable 读后用户编辑正文返回 CONFLICT，保留用户全文并已停用绑定', async t => {
  const f = await fixture();
  const file = path.join(f.project, 'AGENTS.md');
  const original = await readFile(file, 'utf8');
  const edited = '# 读取后新增的用户正文\r\n' + original + '\r\n保留用户尾注\r\n';
  let reads = 0;
  const originalRead = fs.readFile;
  const injected = t.mock.method(fs, 'readFile', async (target, ...args) => {
    const result = await originalRead(target, ...args);
    if (path.resolve(target) === path.resolve(file) && ++reads === 1) await writeFile(file, edited);
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(disableProject(f.directory, f.project), { code: 'CONFLICT' });
    assert.equal(reads, 2, '必须在写入前重新读取核对');
  } finally {
    injected.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(file, 'utf8'), edited);
  assert.equal((await readState(f.directory)).projects[f.projectId].enabled, false);
  const retry = await disableProject(f.directory, f.project);
  assert.equal(retry.agentsChanged, true);
  assert.equal(await readFile(file, 'utf8'), '# 读取后新增的用户正文\r\n\r\n保留用户尾注\r\n');
});

test('disable 临时文件同步期间的用户编辑或硬链接替换，在 rename 前被复核并保留', async t => {
  for (const change of ['edit', 'hardlink']) {
    const f = await fixture();
    const file = path.join(f.project, 'AGENTS.md');
    const original = await readFile(file, 'utf8');
    const edited = '# 临时文件准备期间新增正文\r\n' + original;
    const linked = path.join(f.area, 'user-agents.md');
    let prepared = 0;
    const originalOpen = fs.open;
    const injected = t.mock.method(fs, 'open', async (target, ...args) => {
      const handle = await originalOpen(target, ...args);
      if (path.basename(target).startsWith('.AGENTS.md.workflow-')) {
        const originalSync = handle.sync.bind(handle);
        t.mock.method(handle, 'sync', async () => {
          await originalSync();
          prepared++;
          if (change === 'edit') await writeFile(file, edited);
          else {
            await rename(file, linked);
            await fs.link(linked, file);
          }
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(disableProject(f.directory, f.project), { code: change === 'edit' ? 'CONFLICT' : 'LINK' });
    } finally {
      injected.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(prepared, 1);
    assert.equal(await readFile(file, 'utf8'), change === 'edit' ? edited : original);
    if (change === 'hardlink') assert.equal((await fs.lstat(file)).nlink, 2);
    assert.equal((await readState(f.directory)).projects[f.projectId].enabled, false);
    assert.ok(!(await readdir(f.project)).some(name => name.startsWith('.AGENTS.md.workflow-')), '失败时只清理自建临时文件');
  }
});

test('reenable 最终 state save 失败后按 intent 恢复新区，保护正文、拒绝第三种内容并可停用', async t => {
  for (const next of ['enable', 'disable']) {
    const f = await fixture();
    const file = path.join(f.project, 'AGENTS.md');
    const stateFile = path.join(f.directory, 'state.json');
    const oldHash = (await readState(f.directory)).projects[f.projectId].managedBlockHash;
    await writeFile(path.join(f.project, 'spec.md'), '# 新资料\n');
    let failures = 0;
    const originalRename = fs.rename;
    const injected = t.mock.method(fs, 'rename', async (from, to) => {
      if (path.resolve(to) === path.resolve(stateFile)) {
        const saving = JSON.parse(await readFile(from, 'utf8')).projects[f.projectId];
        if (saving.enabled) {
          assert.ok((await readFile(file, 'utf8')).includes('[spec.md](spec.md)'));
          failures++;
          throw Object.assign(new Error('注入最终 state save 失败'), { code: 'EACCES' });
        }
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(enableProject(f.directory, f.project), { code: 'STATE_WRITE_FAILED' });
    } finally {
      injected.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(failures, 1);
    const actual = await readFile(file, 'utf8');
    const pending = (await readState(f.directory)).projects[f.projectId];
    assert.equal(pending.enabled, false);
    assert.equal(pending.managedBlockHash, oldHash);
    assert.equal(pending.bindingIntent.oldManagedBlockHash, oldHash);
    assert.equal(pending.bindingIntent.newManagedBlockHash, digest(blockFrom(actual).content));
    assert.notEqual(pending.bindingIntent.newManagedBlockHash, oldHash);
    // 在未完成 intent 期间手改管理区，不能被误当成已完成的新区。
    const third = actual.replace('workflow 已在本机明确接入', '用户另写管理区');
    await writeFile(file, third);
    await assert.rejects(enableProject(f.directory, f.project), { code: 'CONFLICT' });
    const refused = await disableProject(f.directory, f.project);
    assert.ok(refused.conflict);
    assert.equal(await readFile(file, 'utf8'), third);
    assert.deepEqual((await readState(f.directory)).projects[f.projectId].bindingIntent, pending.bindingIntent);
    // 正文可在失败之后继续编辑，恢复基于管理区 hash，不覆盖用户正文。
    const edited = '# 失败后用户补写正文\r\n' + actual;
    await writeFile(file, edited);
    const result = await (next === 'enable' ? enableProject : disableProject)(f.directory, f.project);
    assert.equal(result.status, next === 'enable' ? 'enabled' : 'disabled');
    const final = (await readState(f.directory)).projects[f.projectId];
    assert.equal(final.enabled, next === 'enable');
    assert.equal(final.bindingIntent, undefined);
    if (next === 'enable') {
      assert.equal(await readFile(file, 'utf8'), edited);
      assert.equal(final.managedBlockHash, digest(blockFrom(edited).content));
    } else assert.equal(await readFile(file, 'utf8'), '# 失败后用户补写正文\r\n');
  }
});

test('reenable 管理区原子写入失败后保留生效 hash 与 intent，重试成功且手改仍冲突', async t => {
  const f = await fixture();
  const file = path.join(f.project, 'AGENTS.md');
  const original = await readFile(file, 'utf8');
  const oldHash = (await readState(f.directory)).projects[f.projectId].managedBlockHash;
  // 新资料改变 portableBlock，确保新旧 managedBlockHash 不同。
  await writeFile(path.join(f.project, 'spec.md'), '# 新规格\n');
  let failures = 0;
  const originalRename = fs.rename;
  const injected = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.resolve(to) === path.resolve(file)) {
      const project = (await readState(f.directory)).projects[f.projectId];
      assert.equal(project.enabled, false, '先停用 intent，再碰管理区');
      assert.equal(project.managedBlockHash, oldHash);
      const changes = await readdir(path.join(f.directory, 'project-changes'));
      const intents = await Promise.all(changes.map(name => readFile(path.join(f.directory, 'project-changes', name), 'utf8').then(JSON.parse)));
      assert.ok(intents.some(item => item.action === 'enable' && item.managedBlock.includes('[spec.md](spec.md)')));
      failures++;
      throw Object.assign(new Error('注入 AGENTS rename 失败'), { code: 'EACCES' });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(enableProject(f.directory, f.project), { code: 'EACCES' });
  } finally {
    injected.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(failures, 1);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await readState(f.directory)).projects[f.projectId].managedBlockHash, oldHash);
  assert.equal((await readState(f.directory)).projects[f.projectId].enabled, false);
  const modified = original.replace('workflow 已在本机明确接入', '用户手改管理区');
  await writeFile(file, modified);
  await assert.rejects(enableProject(f.directory, f.project), { code: 'CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), modified);
  await writeFile(file, original);
  const retry = await enableProject(f.directory, f.project);
  assert.equal(retry.projectId, f.projectId);
  assert.equal(retry.status, 'enabled');
  const updated = await readFile(file, 'utf8');
  assert.ok(updated.includes('[spec.md](spec.md)'));
  const project = (await readState(f.directory)).projects[f.projectId];
  assert.equal(project.enabled, true);
  assert.equal(project.managedBlockHash, digest(blockFrom(updated).content));
  assert.notEqual(project.managedBlockHash, oldHash);
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

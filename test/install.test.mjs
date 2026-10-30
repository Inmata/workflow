import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { doctor, install, uninstall, RELEASE_PATHS } from '../src/install.mjs';
import { mutate, readState } from '../src/store.mjs';
import { createPending } from '../src/knowledge.mjs';
import { emit, fixture, identity, root, start, temporary } from './helpers.mjs';

test('V14 临时用户目录安装/重复安装/撤销保留其他插件和新增配置', async () => {
  const area = await temporary('install-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, 'user', '.codex');
  await mkdir(userDir, { recursive: true });
  const old = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-plugin-hook' }] }] }, userAdded: { preserve: true } };
  await writeFile(path.join(userDir, 'hooks.json'), JSON.stringify(old));
  const installed = await install(directory, { userDir });
  assert.equal(installed.status, 'installed');
  const once = await readFile(path.join(userDir, 'hooks.json'), 'utf8');
  assert.equal((await install(directory, { userDir })).status, 'already-installed');
  assert.equal(await readFile(path.join(userDir, 'hooks.json'), 'utf8'), once);
  const info = await doctor(directory);
  assert.equal(info.registration, 'registered');
  assert.equal(info.discovery, 'unknown');
  assert.equal(info.trust, 'unknown');
  assert.equal(info.execution, 'unknown');
  assert.equal(info.integrity, 'verified');
  const after = JSON.parse(once);
  after.hooks.Stop.push({ hooks: [{ type: 'command', command: 'later-user-hook' }] });
  await writeFile(path.join(userDir, 'hooks.json'), JSON.stringify(after));
  assert.equal((await uninstall(directory)).status, 'uninstalled');
  const restored = JSON.parse(await readFile(path.join(userDir, 'hooks.json'), 'utf8'));
  assert.deepEqual(restored.userAdded, old.userAdded);
  assert.deepEqual(restored.hooks.Stop.map(group => group.hooks[0].command), ['other-plugin-hook', 'later-user-hook']);
  assert.equal((await uninstall(directory)).status, 'not-installed');
});
test('V14 hook 指向固定入口 current，升级只替换链接目标', async () => {
  const area = await temporary('install-current-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  const first = await install(directory, { userDir });
  const link = path.join(directory, 'current');
  assert.equal(await fs.realpath(link), await fs.realpath(first.releaseRoot));
  const configFile = path.join(userDir, 'hooks.json');
  const command = JSON.parse(await readFile(configFile, 'utf8')).hooks.SessionStart[0].hooks[0].command;
  assert.ok(command.includes('/current/'), command);
  assert.ok(!command.includes('/releases/'), command);
  const once = await readFile(configFile, 'utf8');
  assert.equal((await install(directory, { userDir })).status, 'already-installed');
  assert.equal(await readFile(configFile, 'utf8'), once);
  // 源码变化后升级：入口指向新快照，hook 命令字符串保持不变。
  const source = path.join(area, 'source');
  await fs.cp(root, source, { recursive: true, filter: item => !item.includes('.git') && !item.includes('node_modules') });
  await fs.appendFile(path.join(source, 'README.md'), '\n升级标记\n');
  const second = await install(directory, { userDir, sourceRoot: source });
  assert.equal(second.status, 'installed');
  assert.notEqual(second.releaseRoot, first.releaseRoot);
  assert.equal(await fs.realpath(link), await fs.realpath(second.releaseRoot));
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).hooks.SessionStart[0].hooks[0].command, command);
  // 入口被换成普通目录时 doctor 报告不可用。
  await fs.unlink(link);
  await fs.mkdir(link);
  assert.equal((await doctor(directory)).integrity, 'unavailable');
});
test('V14 升级重装保持自有分组原位置，不打乱其他插件的信任序号', async () => {
  const area = await temporary('install-order-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  const configFile = path.join(userDir, 'hooks.json');
  await install(directory, { userDir });
  // 其他插件后装：一个排在本插件之前，一个排在之后。
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'plugin-before' }] });
  config.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'plugin-after' }] });
  await writeFile(configFile, JSON.stringify(config));
  const source = path.join(area, 'source');
  await fs.cp(root, source, { recursive: true, filter: item => !item.includes('.git') && !item.includes('node_modules') });
  await fs.appendFile(path.join(source, 'README.md'), '\n升级标记\n');
  assert.equal((await install(directory, { userDir, sourceRoot: source })).status, 'installed');
  const commands = JSON.parse(await readFile(configFile, 'utf8')).hooks.SessionStart.map(group => group.hooks[0].command);
  assert.equal(commands.length, 3);
  assert.equal(commands[0], 'plugin-before');
  assert.ok(commands[1].includes('workflow.mjs'), commands[1]);
  assert.equal(commands[2], 'plugin-after');
});
test('V14 自有 handler 被手改时撤销不覆盖，发布副本被改时停止维护', async () => {
  const area = await temporary('install-conflict-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  const result = await install(directory, { userDir });
  const configFile = path.join(userDir, 'hooks.json');
  const current = JSON.parse(await readFile(configFile, 'utf8'));
  current.hooks.Stop[0].hooks[0].timeout = 9;
  const modified = JSON.stringify(current);
  await writeFile(configFile, modified);
  assert.equal((await uninstall(directory)).status, 'conflict');
  assert.equal(await readFile(configFile, 'utf8'), modified);
  await writeFile(path.join(result.releaseRoot, 'docs', 'workflow.md'), '用户的发布副本编辑');
  assert.equal((await doctor(directory)).integrity, 'unavailable');
  await assert.rejects(install(directory, { userDir }), { code: 'INTEGRITY' });
});
test('V14 活动任务阻止首次安装/升级，明确结束后可应用', async () => {
  const f = await fixture();
  await start(f);
  const userDir = path.join(f.area, '.codex');
  const postponed = await install(f.directory, { userDir, sourceRoot: root });
  assert.equal(postponed.status, 'deferred');
  await assert.rejects(readFile(path.join(userDir, 'hooks.json')), { code: 'ENOENT' });
  await emit(f, { action: 'task-end' });
  assert.equal((await install(f.directory, { userDir })).status, 'installed');
  const state = await readState(f.directory);
  assert.ok(state.install.releaseRoot);
});
test('V01 doctor 指定未绑定目录时不暴露其他项目待办', async () => {
  const f = await fixture();
  await start(f);
  await createPending(f.directory, { ...await identity(f), reason: '只属于已绑定项目的知识待办' });
  const unknown = path.join(f.area, 'unbound');
  await mkdir(unknown);
  assert.equal((await doctor(f.directory, f.project)).pending.length, 1);
  assert.equal((await doctor(f.directory)).pending.length, 1);
  assert.deepEqual((await doctor(f.directory, unknown)).pending, []);
});
test('V14 全部 hook 被外部移除时保留原配置并报告冲突', async () => {
  const area = await temporary('install-removed-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  await install(directory, { userDir });
  const file = path.join(userDir, 'hooks.json');
  const edited = '{"userAdded":"保留"}';
  await writeFile(file, edited);
  assert.equal((await uninstall(directory)).status, 'conflict');
  await assert.rejects(install(directory, { userDir }), { code: 'CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), edited);
});
test('V14 旧版 prepared 的 after 指纹与入口一致时重装确认原事务', async () => {
  const area = await temporary('install-prepared-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  await install(directory, { userDir });
  const previous = (await readState(directory)).install;
  await mutate(directory, async state => { state.install.status = 'prepared'; delete state.install.previousCurrentTarget; });
  const before = await readFile(path.join(userDir, 'hooks.json'), 'utf8');
  assert.equal((await install(directory, { userDir })).status, 'installed');
  assert.equal(await readFile(path.join(userDir, 'hooks.json'), 'utf8'), before);
  assert.equal((await readState(directory)).install.status, 'installed');
  assert.equal((await readState(directory)).install.changeId, previous.changeId);
});

async function changedSource(area) {
  const source = path.join(area, 'source');
  for (const item of RELEASE_PATHS) await fs.cp(path.join(root, item), path.join(source, item), { recursive: true });
  await fs.appendFile(path.join(source, 'README.md'), '\n事务恢复升级标记\n');
  return source;
}
async function failedRename(t, predicate, operation) {
  const original = fs.rename;
  const injected = t.mock.method(fs, 'rename', async (...args) => {
    if (predicate(...args)) throw Object.assign(new Error('模拟原子写入失败'), { code: 'EACCES' });
    return original(...args);
  });
  syncBuiltinESMExports();
  try { await operation(); }
  finally { injected.mock.restore(); syncBuiltinESMExports(); }
}

test('V14 升级意图或 prepared 状态写入失败时保留旧 current、双宿主登记与配置', async t => {
  const area = await temporary('install-intent-failure-');
  const directory = path.join(area, 'state');
  const codexDir = path.join(area, '.codex'), claudeDir = path.join(area, '.claude');
  const first = await install(directory, { userDir: codexDir });
  await install(directory, { userDir: claudeDir, agent: 'claude' });
  const sourceRoot = await changedSource(area);
  const before = await readFile(path.join(codexDir, 'hooks.json'), 'utf8');
  for (const target of ['intent', 'state']) {
    await failedRename(t, (_, to) => target === 'intent' ? path.dirname(to) === path.join(directory, 'installation-changes') : to === path.join(directory, 'state.json'), async () => {
      await assert.rejects(install(directory, { userDir: codexDir, sourceRoot }), { code: target === 'intent' ? 'EACCES' : 'STATE_WRITE_FAILED' });
    });
    assert.equal(await fs.realpath(path.join(directory, 'current')), await fs.realpath(first.releaseRoot));
    const state = await readState(directory);
    assert.equal(state.install.releaseRoot, first.releaseRoot);
    assert.equal(state.install.status, 'installed');
    assert.equal(state.installs.claude.releaseRoot, first.releaseRoot);
    assert.equal(await readFile(path.join(codexDir, 'hooks.json'), 'utf8'), before);
    assert.equal((await doctor(directory, undefined, { agent: 'claude' })).integrity, 'verified');
  }
});

test('V14 prepared 配置写失败后首次安装和升级可幂等恢复，第三种内容保留并冲突', async t => {
  for (const upgrade of [false, true]) {
    const area = await temporary('install-prepared-retry-');
    const directory = path.join(area, 'state'), userDir = path.join(area, '.codex');
    const configFile = path.join(userDir, 'hooks.json');
    await mkdir(userDir);
    const initial = '{"userAdded":"保留","hooks":{"Stop":[{"hooks":[{"type":"command","command":"other-hook"}]}]}}';
    await writeFile(configFile, initial);
    const first = upgrade ? await install(directory, { userDir }) : null;
    if (upgrade) await writeFile(configFile, JSON.stringify(JSON.parse(await readFile(configFile, 'utf8'))));
    const before = await readFile(configFile, 'utf8');
    const sourceRoot = upgrade ? await changedSource(area) : root;
    await failedRename(t, (_, to) => to === configFile, async () => {
      await assert.rejects(install(directory, { userDir, sourceRoot }), { code: 'EACCES' });
    });
    const prepared = (await readState(directory)).install;
    assert.equal(prepared.status, 'prepared');
    assert.equal(await readFile(configFile, 'utf8'), before);
    if (first) assert.equal(await fs.realpath(path.join(directory, 'current')), await fs.realpath(first.releaseRoot));
    else assert.equal(await fs.lstat(path.join(directory, 'current')).catch(() => null), null);
    // 第三种用户内容不凭 hook 结构猜测或覆盖；install/uninstall 都保留现场。
    const userEdit = '{"userAdded":"事务后用户修改"}';
    await writeFile(configFile, userEdit);
    await assert.rejects(install(directory, { userDir, sourceRoot }), { code: 'CONFLICT' });
    await assert.rejects(uninstall(directory), { code: 'CONFLICT' });
    assert.equal(await readFile(configFile, 'utf8'), userEdit);
    assert.equal((await readState(directory)).install.changeId, prepared.changeId);
    await writeFile(configFile, before);
    const result = await install(directory, { userDir, sourceRoot });
    assert.equal(result.status, 'installed');
    assert.equal(result.changeId, prepared.changeId);
    assert.equal(await fs.realpath(path.join(directory, 'current')), await fs.realpath(prepared.releaseRoot));
    assert.equal((await doctor(directory)).registration, 'registered');
    const installed = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(installed.userAdded, '保留');
    assert.equal(installed.hooks.Stop[0].hooks[0].command, 'other-hook');
    assert.equal((await install(directory, { userDir, sourceRoot })).status, 'already-installed');
    if (first) assert.ok(await fs.lstat(first.releaseRoot));
  }
});

test('V14 after 配置与 current 已切换但确认状态写失败时安全确认或撤销', async t => {
  for (const action of ['install', 'uninstall']) {
    const area = await temporary('install-confirm-retry-');
    const directory = path.join(area, 'state'), userDir = path.join(area, '.codex');
    await install(directory, { userDir });
    const sourceRoot = await changedSource(area);
    let writes = 0;
    await failedRename(t, (_, to) => to === path.join(directory, 'state.json') && ++writes === 2, async () => {
      await assert.rejects(install(directory, { userDir, sourceRoot }), { code: 'STATE_WRITE_FAILED' });
    });
    const prepared = (await readState(directory)).install;
    assert.equal(prepared.status, 'prepared');
    assert.equal(await fs.realpath(path.join(directory, 'current')), await fs.realpath(prepared.releaseRoot));
    const after = await readFile(path.join(userDir, 'hooks.json'), 'utf8');
    const result = action === 'install' ? await install(directory, { userDir, sourceRoot }) : await uninstall(directory);
    assert.equal(result.status, action === 'install' ? 'installed' : 'uninstalled');
    if (action === 'install') {
      assert.equal(result.changeId, prepared.changeId);
      assert.equal(await readFile(path.join(userDir, 'hooks.json'), 'utf8'), after);
    } else assert.equal(JSON.parse(await readFile(path.join(userDir, 'hooks.json'), 'utf8')).hooks.Stop, undefined);
    assert.ok(await fs.lstat(prepared.releaseRoot));
  }
});

test('V14 卸载移除 hooks 后最终状态保存失败时按撤销指纹收敛，第三种内容保留', async t => {
  const area = await temporary('install-uninstall-retry-');
  const directory = path.join(area, 'state'), userDir = path.join(area, '.codex');
  await install(directory, { userDir });
  const configFile = path.join(userDir, 'hooks.json');
  let writes = 0;
  await failedRename(t, (_, to) => to === path.join(directory, 'state.json') && ++writes === 2, async () => {
    await assert.rejects(uninstall(directory), { code: 'STATE_WRITE_FAILED' });
  });
  const removed = await readFile(configFile, 'utf8');
  assert.equal(JSON.parse(removed).hooks?.Stop, undefined);
  let state = await readState(directory);
  assert.equal(state.install.status, 'installed');
  assert.ok(state.install.uninstallIntent);
  // 第三种用户内容不凭撤销意图覆盖；保留现场待核对。
  const edited = '{"userAdded":"卸载后手改"}';
  await writeFile(configFile, edited);
  await assert.rejects(uninstall(directory), { code: 'CONFLICT' });
  assert.equal(await readFile(configFile, 'utf8'), edited);
  // 配置仍为撤销意图写出的内容时，重试直接完成落盘。
  await writeFile(configFile, removed);
  assert.equal((await uninstall(directory)).status, 'uninstalled');
  state = await readState(directory);
  assert.equal(state.install.status, 'uninstalled');
  assert.equal(state.install.uninstallIntent, undefined);
  assert.equal(await readFile(configFile, 'utf8'), removed);
});

test('V14 current 切换失败与旧链接移走后中断均可按 after 指纹恢复', async t => {
  const area = await temporary('install-current-recovery-');
  const directory = path.join(area, 'state'), userDir = path.join(area, '.codex');
  const first = await install(directory, { userDir });
  const sourceRoot = await changedSource(area);
  const link = path.join(directory, 'current');
  await failedRename(t, (from, to) => to === link && path.basename(from).startsWith('.current-link-'), async () => {
    await assert.rejects(install(directory, { userDir, sourceRoot }), { code: 'EACCES' });
  });
  const prepared = (await readState(directory)).install;
  assert.equal(prepared.status, 'prepared');
  assert.equal(await fs.realpath(link), await fs.realpath(first.releaseRoot));
  // 模拟进程在把旧链接移走之后退出：aside 和发布副本都保留，不猜测清理。
  const aside = path.join(directory, '.current-old-interrupted');
  await fs.rename(link, aside);
  const result = await install(directory, { userDir, sourceRoot });
  assert.equal(result.status, 'installed');
  assert.equal(result.changeId, prepared.changeId);
  assert.equal(await fs.realpath(link), await fs.realpath(prepared.releaseRoot));
  assert.equal(await fs.realpath(aside), await fs.realpath(first.releaseRoot));
  assert.equal((await doctor(directory)).integrity, 'verified');
});

test('V14 双宿主 prepared 恢复保留原 current，其他宿主不得接管在途共享入口', async t => {
  const area = await temporary('install-shared-prepared-');
  const directory = path.join(area, 'state');
  const codexDir = path.join(area, '.codex'), claudeDir = path.join(area, '.claude');
  const first = await install(directory, { userDir: codexDir });
  await install(directory, { userDir: claudeDir, agent: 'claude' });
  const sourceRoot = await changedSource(area);
  const configFile = path.join(codexDir, 'hooks.json');
  await writeFile(configFile, JSON.stringify(JSON.parse(await readFile(configFile, 'utf8'))));
  await failedRename(t, (_, to) => to === configFile, async () => {
    await assert.rejects(install(directory, { userDir: codexDir, sourceRoot }), { code: 'EACCES' });
  });
  await assert.rejects(install(directory, { userDir: claudeDir, agent: 'claude', sourceRoot }), { code: 'RECOVERY' });
  assert.equal(await fs.realpath(path.join(directory, 'current')), await fs.realpath(first.releaseRoot));
  // 用户替换入口也不能被恢复覆盖；恢复原入口后才能继续原事务。
  const link = path.join(directory, 'current');
  await fs.unlink(link);
  await mkdir(link);
  await writeFile(path.join(link, 'user.txt'), '用户入口内容');
  await assert.rejects(install(directory, { userDir: codexDir, sourceRoot }), { code: 'CONFLICT' });
  assert.equal(await readFile(path.join(link, 'user.txt'), 'utf8'), '用户入口内容');
  await fs.rename(link, path.join(area, 'preserved-current'));
  await fs.symlink(first.releaseRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  const recovered = await install(directory, { userDir: codexDir, sourceRoot });
  assert.equal(recovered.status, 'installed');
  assert.equal((await readState(directory)).installs.claude.releaseRoot, first.releaseRoot);
  assert.equal((await install(directory, { userDir: claudeDir, agent: 'claude', sourceRoot })).status, 'installed');
  assert.equal((await doctor(directory)).integrity, 'verified');
  assert.equal((await doctor(directory, undefined, { agent: 'claude' })).integrity, 'verified');
});

test('V14 发布复制失败保留现场与用户配置，后续安装可直接重试', async t => {
  const area = await temporary('install-copy-failure-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  await mkdir(userDir);
  const configFile = path.join(userDir, 'hooks.json');
  const originalConfig = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"preserved-hook"}]}]}}';
  await writeFile(configFile, originalConfig);
  const originalCopy = fs.copyFile;
  let copiedFile, copiedContent, calls = 0;
  const injected = t.mock.method(fs, 'copyFile', async (...args) => {
    if (++calls === 2) throw Object.assign(new Error('模拟复制中途磁盘写入失败'), { code: 'ENOSPC' });
    await originalCopy(...args);
    copiedFile = args[1];
    copiedContent = await readFile(copiedFile);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(install(directory, { userDir }), { code: 'ENOSPC' });
  } finally {
    injected.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(configFile, 'utf8'), originalConfig);
  assert.equal((await readState(directory)).install, null);
  const retried = await install(directory, { userDir });
  assert.equal(retried.status, 'installed');
  assert.equal((await doctor(directory)).integrity, 'verified');
  assert.deepEqual(await readFile(copiedFile), copiedContent);
  const installedConfig = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(installedConfig.hooks.Stop[0].hooks[0].command, 'preserved-hook');
});

test('V14 Claude 安装写入 settings.json 的 hooks 段，保留其他插件与顶层配置', async () => {
  const area = await temporary('install-claude-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, 'user', '.claude');
  await mkdir(userDir, { recursive: true });
  const existing = {
    env: { PRESERVED: 'yes' },
    model: 'opus',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'D:/other/hook.exe', args: ['claude'], timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'other-stop-hook' }] }],
    },
  };
  await writeFile(path.join(userDir, 'settings.json'), JSON.stringify(existing));
  const installed = await install(directory, { userDir, agent: 'claude' });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.agent, 'claude');
  const config = JSON.parse(await readFile(path.join(userDir, 'settings.json'), 'utf8'));
  assert.deepEqual(config.env, existing.env);
  assert.equal(config.model, 'opus');
  const own = config.hooks.PostToolUse[0].hooks[0];
  assert.equal(own.command, process.execPath.replaceAll('\\', '/'));
  assert.ok(own.args[0].endsWith('bin/workflow.mjs'));
  assert.deepEqual(own.args.slice(1, 5), ['hook', '--agent', 'claude', '--state-dir']);
  assert.equal(config.hooks.SessionStart[0].hooks[0].command, 'D:/other/hook.exe');
  assert.deepEqual(config.hooks.Stop.map(group => group.hooks[0].command), ['other-stop-hook', own.command]);
  const info = await doctor(directory, undefined, { agent: 'claude' });
  assert.equal(info.agent, 'claude');
  assert.equal(info.registration, 'registered');
  assert.equal(info.integrity, 'verified');
  assert.equal((await uninstall(directory, { agent: 'claude' })).status, 'uninstalled');
  const restored = JSON.parse(await readFile(path.join(userDir, 'settings.json'), 'utf8'));
  assert.equal(restored.hooks.SessionStart.length, 1);
  assert.equal(restored.hooks.SessionStart[0].hooks[0].command, 'D:/other/hook.exe');
  assert.equal(restored.hooks.Stop.length, 1);
  assert.equal(restored.hooks.PostToolUse, undefined);
  assert.deepEqual(restored.env, existing.env);
});

test('V14 current 断链/错链只做最小修复，完好重复安装不改配置', async () => {
  const area = await temporary('install-repair-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  const configFile = path.join(userDir, 'hooks.json');
  const first = await install(directory, { userDir });
  const once = await readFile(configFile, 'utf8');
  const mtime = (await fs.stat(configFile)).mtimeMs;
  const link = path.join(directory, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  // 完好重复安装：幂等，配置内容和 mtime 都不变。
  assert.equal((await install(directory, { userDir })).status, 'already-installed');
  assert.equal(await readFile(configFile, 'utf8'), once);
  assert.equal((await fs.stat(configFile)).mtimeMs, mtime);
  // 自有入口被删除：最小修复重建 current，不重写配置。
  await fs.unlink(link);
  const recreated = await install(directory, { userDir });
  assert.equal(recreated.status, 'repaired');
  assert.equal(await fs.realpath(link), await fs.realpath(first.releaseRoot));
  assert.equal(await readFile(configFile, 'utf8'), once);
  assert.equal((await fs.stat(configFile)).mtimeMs, mtime);
  assert.equal((await doctor(directory)).integrity, 'verified');
  // 自有断链：目标在 releases/ 下但已不存在，仍按自有入口修复。
  const gone = path.join(directory, 'releases', 'gone-snapshot');
  await fs.mkdir(gone, { recursive: true });
  await fs.unlink(link);
  await fs.symlink(gone, link, linkType);
  await fs.rm(gone, { recursive: true, force: true });
  const dangling = await install(directory, { userDir });
  assert.equal(dangling.status, 'repaired');
  assert.equal(await fs.realpath(link), await fs.realpath(first.releaseRoot));
  assert.equal(await readFile(configFile, 'utf8'), once);
  // 自有错链：指向 releases/ 下另一个目录，按登记发布根改回。
  const other = path.join(directory, 'releases', 'other-snapshot');
  await fs.mkdir(other, { recursive: true });
  await fs.unlink(link);
  await fs.symlink(other, link, linkType);
  const wrong = await install(directory, { userDir });
  assert.equal(wrong.status, 'repaired');
  assert.equal(await fs.realpath(link), await fs.realpath(first.releaseRoot));
  assert.equal(await readFile(configFile, 'utf8'), once);
  assert.equal((await fs.stat(configFile)).mtimeMs, mtime);
});

test('V14 用户替换的 current 目录或外部链接保留并报告冲突', async () => {
  const area = await temporary('install-unknown-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  const configFile = path.join(userDir, 'hooks.json');
  await install(directory, { userDir });
  const once = await readFile(configFile, 'utf8');
  const mtime = (await fs.stat(configFile)).mtimeMs;
  const link = path.join(directory, 'current');
  // 用户自己的普通目录：不接管，保留内容和文件。
  await fs.unlink(link);
  await fs.mkdir(link);
  await writeFile(path.join(link, 'user-note.txt'), '用户资料');
  const directoryConflict = await install(directory, { userDir });
  assert.equal(directoryConflict.status, 'conflict');
  assert.equal(directoryConflict.path, link);
  assert.equal(directoryConflict.kind, 'directory');
  assert.ok(directoryConflict.conflict);
  assert.equal(await readFile(path.join(link, 'user-note.txt'), 'utf8'), '用户资料');
  assert.equal(await readFile(configFile, 'utf8'), once);
  assert.equal((await fs.stat(configFile)).mtimeMs, mtime);
  // 指向安装目录外部的链接：不自动改指或删除。
  await fs.rm(link, { recursive: true, force: true });
  const external = path.join(area, 'user-target');
  await fs.mkdir(external);
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linkConflict = await install(directory, { userDir });
  assert.equal(linkConflict.status, 'conflict');
  assert.equal(linkConflict.path, link);
  assert.equal(linkConflict.kind, 'link');
  assert.equal(await fs.realpath(link), await fs.realpath(external));
  assert.equal(await readFile(configFile, 'utf8'), once);
  // 首次安装遇到用户已有的 current：同样保留并报冲突，不写宿主配置。
  const fresh = path.join(area, 'fresh-state');
  await fs.mkdir(path.join(fresh, 'current'), { recursive: true });
  await writeFile(path.join(fresh, 'current', 'user-note.txt'), '用户目录');
  const freshUserDir = path.join(area, '.codex-fresh');
  const freshConflict = await install(fresh, { userDir: freshUserDir });
  assert.equal(freshConflict.status, 'conflict');
  assert.equal(await readFile(path.join(fresh, 'current', 'user-note.txt'), 'utf8'), '用户目录');
  await assert.rejects(readFile(path.join(freshUserDir, 'hooks.json')), { code: 'ENOENT' });
});

test('V14 Codex 与 Claude 安装记录互不覆盖，可分别撤销', async () => {
  const area = await temporary('install-both-');
  const directory = path.join(area, 'state');
  const codexDir = path.join(area, '.codex');
  const claudeDir = path.join(area, '.claude');
  assert.equal((await install(directory, { userDir: codexDir })).status, 'installed');
  assert.equal((await install(directory, { userDir: claudeDir, agent: 'claude' })).status, 'installed');
  const state = await readState(directory);
  assert.equal(state.install.agent, 'codex');
  assert.equal(state.installs.codex.status, 'installed');
  assert.equal(state.installs.claude.status, 'installed');
  assert.equal((await uninstall(directory, { agent: 'claude' })).status, 'uninstalled');
  assert.equal((await doctor(directory)).registration, 'registered');
  assert.equal((await doctor(directory, undefined, { agent: 'claude' })).registration, 'not-installed');
  assert.equal((await uninstall(directory)).status, 'uninstalled');
  assert.equal((await readState(directory)).installs.claude.status, 'uninstalled');
});

test('V14 双宿主跨版本重复安装不改指另一个宿主的有效入口', async () => {
  const area = await temporary('install-cross-host-');
  const directory = path.join(area, 'state');
  const codexDir = path.join(area, '.codex');
  const claudeDir = path.join(area, '.claude');
  const sourceA = path.join(area, 'source-a');
  const sourceB = path.join(area, 'source-b');
  const copy = target => fs.cp(root, target, { recursive: true, filter: item => !item.includes('.git') && !item.includes('node_modules') });
  await copy(sourceA);
  await copy(sourceB);
  await fs.appendFile(path.join(sourceB, 'README.md'), '\n新版本标记\n');
  const codexOld = await install(directory, { userDir: codexDir, sourceRoot: sourceA });
  const claudeOld = await install(directory, { userDir: claudeDir, agent: 'claude', sourceRoot: sourceA });
  assert.equal(codexOld.releaseRoot, claudeOld.releaseRoot);
  // Codex 升级到新快照，共用入口 current 改指新版本；Claude 仍登记旧版本。
  const codexNew = await install(directory, { userDir: codexDir, sourceRoot: sourceB });
  assert.equal(codexNew.status, 'installed');
  const link = path.join(directory, 'current');
  assert.equal(await fs.realpath(link), await fs.realpath(codexNew.releaseRoot));
  const claudeConfig = path.join(claudeDir, 'settings.json');
  const once = await readFile(claudeConfig, 'utf8');
  const mtime = (await fs.stat(claudeConfig)).mtimeMs;
  // 用旧版本源码重复安装 Claude：入口属于另一个已安装宿主的有效快照，不自动改指。
  const claudeAgain = await install(directory, { userDir: claudeDir, agent: 'claude', sourceRoot: sourceA });
  assert.equal(claudeAgain.status, 'conflict', JSON.stringify(claudeAgain));
  assert.equal(claudeAgain.path, link);
  assert.equal(claudeAgain.registeredBy.agent, 'codex');
  assert.equal(claudeAgain.registeredBy.version, codexNew.version);
  assert.ok(claudeAgain.conflict.includes('统一升级'), claudeAgain.conflict);
  assert.equal(await fs.realpath(link), await fs.realpath(codexNew.releaseRoot));
  assert.equal((await doctor(directory)).integrity, 'verified');
  assert.equal(await readFile(claudeConfig, 'utf8'), once);
  assert.equal((await fs.stat(claudeConfig)).mtimeMs, mtime);
  assert.equal((await readState(directory)).installs.claude.status, 'installed');
});

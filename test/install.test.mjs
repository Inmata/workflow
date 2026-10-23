import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { doctor, install, uninstall } from '../src/install.mjs';
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
test('V14 未确认安装事务不可被后续安装覆盖', async () => {
  const area = await temporary('install-prepared-');
  const directory = path.join(area, 'state');
  const userDir = path.join(area, '.codex');
  await install(directory, { userDir });
  await mutate(directory, async state => { state.install.status = 'prepared'; });
  const before = await readFile(path.join(userDir, 'hooks.json'), 'utf8');
  await assert.rejects(install(directory, { userDir }), { code: 'RECOVERY' });
  assert.equal(await readFile(path.join(userDir, 'hooks.json'), 'utf8'), before);
  assert.equal((await readState(directory)).install.status, 'prepared');
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

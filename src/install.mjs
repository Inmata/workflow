import path from 'node:path';
import os from 'node:os';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { atomicWrite, digest, fail, hostObservations, id, mutate, readState, readText, samePath, writeJSON } from './store.mjs';
import { PRODUCT_ROOT } from './context.mjs';
import { CLAUDE_EVENTS, EVENTS, HOSTS as HOST_NAMES } from './hooks.mjs';

export const RELEASE_PATHS = [
  'bin', 'src', 'hooks', '.codex-plugin', 'docs/workflow.md', 'docs/alignment.md', 'docs/roles',
  'docs/references', 'docs/adapters', 'docs/usage.md', 'docs/design/protocol.md', 'docs/learning.md', 'docs/background-review.md', 'docs/acceptance.md',
  'examples', 'package.json', 'plugin.json', 'README.md',
];
async function inventory(root, relative = '', selected = RELEASE_PATHS) {
  const files = [];
  const entries = relative ? (await readdir(path.join(root, relative))).sort() : selected;
  for (const name of entries) {
    const item = path.join(relative, name);
    const info = await lstat(path.join(root, item));
    if (info.isSymbolicLink()) fail('LINK', '发布目录含链接，请先核对来源');
    if (info.isDirectory()) files.push(...await inventory(root, item));
    else files.push({ path: item.replaceAll('\\', '/'), hash: digest(await readFile(path.join(root, item))) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function verifyRelease(record) {
  if (!record?.releaseRoot || !Array.isArray(record.files)) return false;
  try {
    const names = [...new Set(record.files.map(file => file.path.split('/')[0]))];
    const actual = await inventory(record.releaseRoot, '', names);
    return JSON.stringify(actual) === JSON.stringify(record.files);
  } catch { return false; }
}
const psQuote = text => `'${text.replaceAll("'", "''")}'`;
const shQuote = text => `'${text.replaceAll("'", `'"'"'`)}'`;
export function hookCommand(releaseRoot, directory) {
  const quote = process.platform === 'win32' ? psQuote : shQuote;
  const start = process.platform === 'win32' ? '& ' : '';
  return `${start}${quote(process.execPath.replaceAll('\\', '/'))} ${quote(path.join(releaseRoot, 'bin', 'workflow.mjs').replaceAll('\\', '/'))} hook --agent codex --state-dir ${quote(directory.replaceAll('\\', '/'))}`;
}
const slash = value => value.replaceAll('\\', '/');
// 宿主 hook 指向固定入口 current，升级只替换链接目标；配置字符串和宿主信任都不必重做。
export function currentRoot(directory) {
  return path.join(directory, 'current');
}
async function removeEntry(file) {
  const info = await lstat(file).catch(() => null);
  if (!info) return;
  if (info.isSymbolicLink()) await unlink(file);
  else await rm(file, { recursive: true, force: true });
}
async function pointCurrent(directory, releaseRoot) {
  const link = currentRoot(directory);
  const next = path.join(directory, `.current-${id('link')}`);
  await removeEntry(next);
  await symlink(releaseRoot, next, 'junction');
  const aside = path.join(directory, `.current-old-${id('link')}`);
  const existing = await lstat(link).catch(() => null);
  if (existing) await rename(link, aside);
  try {
    await rename(next, link);
  } catch (error) {
    if (existing) await rename(aside, link).catch(() => {});
    throw error;
  }
  if (existing) await removeEntry(aside);
  return link;
}
async function currentTarget(directory) {
  try { return await realpath(currentRoot(directory)); } catch { return null; }
}
// 快照内容与 fixed 入口指向必须同时正确，才算完整。
export async function releaseIntegrity(directory, record) {
  if (!await verifyRelease(record)) return 'unavailable';
  if (record.currentRoot) {
    const target = await currentTarget(directory);
    if (!target || !samePath(target, record.releaseRoot)) return 'unavailable';
  }
  return 'verified';
}
// 每个宿主的配置位置、事件集合和 handler 形状不同；安装记录按宿主分开维护，互不覆盖。
export const HOSTS = {
  codex: {
    events: EVENTS,
    configName: 'hooks.json',
    defaultUserDir: () => path.join(os.homedir(), '.codex'),
    handler: (releaseRoot, directory, event) => {
      const handler = { type: 'command', command: hookCommand(releaseRoot, directory), timeout: ['Interrupt', 'SessionEnd'].includes(event) ? 3 : 10 };
      if (['SessionStart', 'UserPromptSubmit'].includes(event)) handler.additionalContextLimit = 8000;
      return handler;
    },
  },
  claude: {
    events: CLAUDE_EVENTS,
    configName: 'settings.json',
    defaultUserDir: () => path.join(os.homedir(), '.claude'),
    // Claude Code 的 command 是 shell 字符串；用 command + args 数组避免路径引号歧义。
    handler: (releaseRoot, directory) => ({
      type: 'command',
      command: slash(process.execPath),
      args: [slash(path.join(releaseRoot, 'bin', 'workflow.mjs')), 'hook', '--agent', 'claude', '--state-dir', slash(directory)],
      timeout: 10,
    }),
  },
};
export const AGENTS = HOST_NAMES;
const hostFor = agent => {
  const host = HOSTS[agent];
  if (!host) fail('AGENT', `未知宿主 ${agent}；支持 ${AGENTS.join('/')}`);
  return host;
};
// codex 保留 state.install 作为旧版兼容权威记录，installs.codex 只是同步镜像；claude 只写 installs.claude。
export function installRecord(state, agent) {
  state.installs ||= {};
  if (state.install && !state.installs.codex) state.installs.codex = state.install;
  return agent === 'codex' ? state.install || state.installs.codex || null : state.installs[agent] || null;
}
async function readConfig(file) {
  const text = await readText(file);
  if (text === null) return { text, config: {} };
  let config;
  try { config = JSON.parse(text); } catch { fail('CONFIG', `${path.basename(file)} 不是有效 JSON，保留原文件`); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.hooks && (typeof config.hooks !== 'object' || Array.isArray(config.hooks)))) fail('CONFIG', '未知 hooks 配置结构');
  for (const groups of Object.values(config.hooks || {})) {
    if (!Array.isArray(groups) || groups.some(group => !group || !Array.isArray(group.hooks))) fail('CONFIG', '未知 hooks 分组结构，保留原文件');
  }
  return { text, config };
}
// 自有 handler 必须 command 与 args 同时一致，避免只凭相同的 Node 路径误删其他插件的定义。
const sameTarget = (handler, record) => handler.command === record.command && JSON.stringify(handler.args ?? null) === JSON.stringify(record.args ?? null);
// slots 记下每个事件里自有分组的原位置；Codex 的信任键按分组序号编号，重装须放回原处，否则自己和其他插件的信任都会失效。
function removeOwned(config, record) {
  const result = structuredClone(config);
  const conflicts = [];
  const slots = {};
  if (!record) return { config: result, conflicts, slots };
  result.hooks ||= {};
  for (const event of record.events || EVENTS) {
    let found = false;
    const expected = record.handlers[event];
    const kept = [];
    for (const group of result.hooks?.[event] || []) {
      const hooks = group.hooks.filter(handler => {
        if (!sameTarget(handler, record)) return true;
        found = true;
        if (JSON.stringify(handler) !== JSON.stringify(expected)) { conflicts.push(event); return true; }
        slots[event] ??= kept.length;
        return false;
      });
      if (hooks.length) kept.push({ ...group, hooks });
    }
    result.hooks[event] = kept;
    if (!found) conflicts.push(event);
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  return { config: result, conflicts, slots };
}
export async function install(directory, { userDir, sourceRoot = PRODUCT_ROOT, agent = 'codex' } = {}) {
  const host = hostFor(agent);
  userDir = path.resolve(userDir || host.defaultUserDir());
  return mutate(directory, async (state, save) => {
    const previous = installRecord(state, agent);
    if (previous && !['installed', 'uninstalled'].includes(previous.status)) fail('RECOVERY', '安装事务尚未确认，先核对注册差异；不覆盖追溯记录');
    const configFile = path.join(userDir, host.configName);
    const current = await readConfig(configFile);
    const files = await inventory(sourceRoot);
    const packageInfo = JSON.parse(await readText(path.join(sourceRoot, 'package.json')));
    const releaseHash = digest(JSON.stringify(files));
    const active = previous?.status === 'installed' ? previous : null;
    if (active && !await verifyRelease(active)) fail('INTEGRITY', '已安装副本被修改，先核对差异；不覆盖');
    if (active && active.configFile !== configFile) fail('CONFIG', '已有另一用户目录安装，先明确撤销旧注册');
    const stripped = removeOwned(current.config, active);
    if (stripped.conflicts.length) fail('CONFLICT', `自有 hook 被手改/移除，保留配置：${stripped.conflicts.join(',')}`);
    if (active?.releaseHash === releaseHash && active?.currentRoot && samePath(active.currentRoot, currentRoot(directory))) return { status: 'already-installed', agent, version: active.version, releaseRoot: active.releaseRoot, currentRoot: active.currentRoot, requiresTrust: 'unknown' };
    const activeTasks = Object.values(state.tasks).filter(task => task.lifecycle === 'active').map(task => task.taskId);
    const activeTransactions = Object.values(state.transactions).filter(tx => tx.status === 'prepared').map(tx => tx.transactionId);
    if (activeTasks.length || activeTransactions.length) return { status: 'deferred', reason: '仍有活动任务或未辨认的事务；保留当前发布副本和配置', activeTasks, activeTransactions };
    const releaseRoot = path.join(directory, 'releases', `${packageInfo.version}-${releaseHash.slice(0, 16)}`);
    try {
      await lstat(releaseRoot);
      if (!await verifyRelease({ releaseRoot, files })) fail('INTEGRITY', '目标发布副本已有不同内容，不覆盖');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A failed or interrupted copy remains inspectable without occupying the final release path.
      const stagingRoot = path.join(directory, 'release-staging', id('release'));
      await mkdir(stagingRoot, { recursive: true });
      for (const file of files) {
        await mkdir(path.dirname(path.join(stagingRoot, file.path)), { recursive: true });
        await copyFile(path.join(sourceRoot, file.path), path.join(stagingRoot, file.path));
      }
      if (!await verifyRelease({ releaseRoot: stagingRoot, files })) fail('INTEGRITY', '暂存发布副本与来源摘要不符；保留现场，不注册');
      await mkdir(path.dirname(releaseRoot), { recursive: true });
      await rename(stagingRoot, releaseRoot);
    }
    // 配置只认固定入口；releaseRoot 仅作完整性校验和回滚快照。
    const link = await pointCurrent(directory, releaseRoot);
    const next = stripped.config;
    next.hooks ||= {};
    const handlers = {};
    for (const event of host.events) {
      const handler = host.handler(link, directory, event);
      handlers[event] = handler;
      next.hooks[event] ||= [];
      const slot = stripped.slots[event];
      if (slot === undefined) next.hooks[event].push({ hooks: [handler] });
      else next.hooks[event].splice(slot, 0, { hooks: [handler] });
    }
    const after = JSON.stringify(next, null, 2) + '\n';
    const changeId = id('install');
    const target = handlers[host.events[0]];
    const record = { status: 'prepared', agent, events: host.events, changeId, version: packageInfo.version, releaseHash, releaseRoot, currentRoot: link, files, configFile, command: target.command, args: target.args ?? null, handlers, beforeHash: current.text === null ? null : digest(current.text), afterHash: digest(after), registeredAt: new Date().toISOString(), previousOwned: active ? { command: active.command, args: active.args ?? null, handlers: active.handlers } : null };
    // Only owned definitions and fingerprints are backed up, never unrelated configuration or credentials.
    await writeJSON(path.join(directory, 'installation-changes', `${changeId}.json`), record);
    state.installs[agent] = record;
    if (agent === 'codex') state.install = record;
    await save();
    if (await readText(configFile) !== current.text) fail('CONFLICT', '安装准备期间 hooks 配置已变化；保留用户配置');
    await atomicWrite(configFile, after);
    record.status = 'installed';
    await save();
    return { status: 'installed', agent, version: record.version, releaseRoot, currentRoot: link, configFile, changeId, requiresTrust: '请用实际宿主支持的 /hooks 审核当前定义；新会话验证，不自动修改信任记录' };
  });
}
export async function uninstall(directory, { agent = 'codex' } = {}) {
  const host = hostFor(agent);
  return mutate(directory, async state => {
    const record = installRecord(state, agent);
    if (!record || record.status === 'uninstalled') return { status: 'not-installed' };
    if (record.status !== 'installed') fail('RECOVERY', '安装事务尚未确认，需要先核对注册差异');
    const current = await readConfig(record.configFile);
    const stripped = removeOwned(current.config, { ...record, events: record.events || host.events });
    if (stripped.conflicts.length) return { status: 'conflict', conflicts: stripped.conflicts, reason: '自有定义被用户修改；保留整个配置待核对' };
    if (await readText(record.configFile) !== current.text) fail('CONFLICT', '撤销期间用户修改了配置');
    await atomicWrite(record.configFile, JSON.stringify(stripped.config, null, 2) + '\n');
    record.status = 'uninstalled';
    record.uninstalledAt = new Date().toISOString();
    if (agent === 'codex') state.install = record;
    return { status: 'uninstalled', releaseRetained: record.releaseRoot, reason: '发布副本和追溯记录保留，可通过系统回收站清理' };
  });
}
// 只读核对 Codex 的 Default 模式提问开关；不写用户配置。只认 [features] 段内的布尔赋值，其余写法报告 unknown。
export async function codexQuestionFeature(userDir = HOSTS.codex.defaultUserDir()) {
  const text = await readText(path.join(userDir, 'config.toml')).catch(() => undefined);
  const note = '未开启时也可通过 Codeg MCP ask_user_question 或文本编号问题提问；是否开启由用户决定。';
  if (text === null) return { setting: 'default_mode_request_user_input', status: 'config-missing', note };
  if (text === undefined) return { setting: 'default_mode_request_user_input', status: 'unknown', note };
  let section = '', value;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1].trim(); continue; }
    const match = /^default_mode_request_user_input\s*=\s*(\S+)$/.exec(line);
    if (match && section === 'features') value = match[1];
  }
  const status = value === 'true' ? 'enabled' : value === 'false' || value === undefined ? 'disabled' : 'unknown';
  return { setting: 'default_mode_request_user_input', status, ...(status === 'enabled' ? {} : { note }) };
}
export async function doctor(directory, root, { agent = 'codex', userDir } = {}) {
  const host = hostFor(agent);
  const state = await readState(directory);
  const record = installRecord(state, agent);
  let registered = false, configuration = 'not-installed';
  if (record && record.status === 'installed') {
    try {
      const current = await readConfig(record.configFile);
      registered = (record.events || host.events).every(event => current.config.hooks?.[event]?.some(group => group.hooks.some(handler => sameTarget(handler, record) && JSON.stringify(handler) === JSON.stringify(record.handlers[event]))));
      configuration = registered ? 'registered' : 'missing-or-modified';
    } catch { configuration = 'unreadable-or-unknown'; }
  }
  const actual = Object.entries(hostObservations(state, agent)).filter(([, observation]) => observation.source === 'callback').map(([event, observation]) => ({ event, at: observation.at }));
  const project = root ? await (await import('./projects.mjs')).resolveProject(state, root) : null;
  return {
    schemaVersion: 1, agent, registration: configuration, discovery: 'unknown', trust: 'unknown',
    execution: actual.length ? { status: 'callback-observed-host-unverified', events: actual } : 'unknown',
    integrity: record ? await releaseIntegrity(directory, record) : 'not-installed',
    version: record?.version || null,
    ...(agent === 'codex' ? { questionInDefaultMode: await codexQuestionFeature(userDir || (record?.configFile ? path.dirname(record.configFile) : undefined)) } : {}),
    activeTasks: Object.values(state.tasks).filter(task => task.lifecycle === 'active').map(task => task.taskId),
    project: project ? { projectId: project.project.projectId, enabled: true, coexistenceMode: project.project.coexistenceMode } : null,
    pending: Object.values(state.pending).filter(item => item.status === 'open' && (!root || (project && item.projectId === project.project.projectId))).map(item => ({ pendingId: item.pendingId, kind: item.kind, reason: item.reason })),
    next: registered ? '使用当前 ACP 宿主核对 hooks/list 与 /hooks 信任，在新会话观察本插件回调；不要用全局 CLI 版本代替 ACP 版本' : '先核对安装/注册差异；测试始终使用临时 user-dir/state-dir',
  };
}

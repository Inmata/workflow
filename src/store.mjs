import { mkdir, open, readFile, rename, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const STATE_VERSION = 2;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const id = prefix => `${prefix}-${randomUUID()}`;
export class WorkflowError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new WorkflowError(code, message); };
export function stateDirectory(explicit) {
  return path.resolve(explicit || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'workflow'));
}
export async function readText(file, missing = null) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
}
export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.workflow-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}
export const writeJSON = (file, value) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
export function emptyState() {
  return { schemaVersion: STATE_VERSION, revision: 0, projects: {}, tasks: {}, sessions: {}, transactions: {}, pending: {}, install: null, installs: {} };
}
// 回调观测按宿主分开，避免一个宿主的执行证据被另一个宿主的 doctor 当成自己的。
export function hostObservations(state, agent = 'codex') {
  const all = state.hostObservations || {};
  const nested = all[agent];
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && !Object.hasOwn(nested, 'at')) return nested;
  if (agent === 'codex') {
    const legacy = Object.fromEntries(Object.entries(all).filter(([, value]) => value && typeof value === 'object' && typeof value.at === 'string'));
    if (Object.keys(legacy).length) return legacy;
  }
  return {};
}
export function observeHost(state, agent, event, value) {
  state.hostObservations ||= {};
  const legacy = Object.fromEntries(Object.entries(state.hostObservations).filter(([, item]) => item && typeof item === 'object' && typeof item.at === 'string'));
  // 旧状态只记录扁平结构，来源只能是当时的 Codex 宿主；迁移后再按宿主分层。
  if (Object.keys(legacy).length) state.hostObservations = { codex: legacy };
  state.hostObservations[agent] ||= {};
  state.hostObservations[agent][event] = value;
  return state.hostObservations[agent];
}
export function validateState(state) {
  if (![1, STATE_VERSION].includes(state?.schemaVersion)) fail('SCHEMA', '未知状态版本；保留原文件并停止维护');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) fail('STATE', '状态修订号损坏');
  for (const key of ['projects', 'tasks', 'sessions', 'transactions', 'pending']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) fail('STATE', `状态 ${key} 损坏`);
  }
  // installs 是本版新增的多宿主安装记录；旧状态文件没有该键时按空记录迁移。
  if (state.installs !== undefined && (!state.installs || typeof state.installs !== 'object' || Array.isArray(state.installs))) fail('STATE', '状态 installs 损坏');
  return state;
}
export function parseState(raw) {
  if (raw === null) return emptyState();
  let value;
  try { value = JSON.parse(raw); } catch { fail('STATE', '状态 JSON 损坏；保留原文件并停止维护'); }
  validateState(value);
  if (value.schemaVersion === 1) {
    value.schemaVersion = STATE_VERSION;
    for (const task of Object.values(value.tasks)) {
      if (task.lifecycle === 'active' && !Object.values(value.sessions).some(s => s.projectId === task.projectId && s.taskId === task.taskId && !s.interrupted && s.ticket)) task.lifecycle = 'suspended';
    }
  }
  return value;
}
export async function readState(directory) {
  return parseState(await readText(path.join(directory, 'state.json')));
}
export async function withLock(directory, name, operation) {
  const locks = path.join(directory, 'locks');
  await mkdir(locks, { recursive: true });
  const file = path.join(locks, `${digest(name)}.lock`);
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await open(file, 'wx'); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(file, 'utf8')); } catch { fail('LOCKED', '锁状态不可辨认，保留原文件'); }
      let dead = false;
      if (Number.isSafeInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; }
      }
      if (!dead || attempt > 0) fail('LOCKED', '锁正在占用；保留待办，不按超时抢锁');
      const retired = path.join(directory, 'retired-locks');
      await mkdir(retired, { recursive: true });
      // Serialize stale-lock recovery; two contenders must never move a fresh owner's lock.
      const recoveryFile = `${file}.recovery`;
      let recovery;
      try { recovery = await open(recoveryFile, 'wx'); }
      catch { fail('LOCKED', '另一进程正在辨认旧锁；保留待办'); }
      try {
        const current = JSON.parse(await readFile(file, 'utf8'));
        let stillDead = false;
        try { process.kill(current.pid, 0); } catch (probe) { stillDead = probe.code === 'ESRCH'; }
        if (!stillDead || current.pid !== previous.pid) fail('LOCKED', '锁持有者已变化，停止回收');
        await rename(file, path.join(retired, `${randomUUID()}.dead.lock`));
      } finally {
        await recovery.close();
        await rename(recoveryFile, path.join(retired, `${randomUUID()}.recovery.lock`));
      }
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, name, createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    await handle.close();
    const retired = path.join(directory, 'retired-locks');
    await mkdir(retired, { recursive: true });
    await rename(file, path.join(retired, `${randomUUID()}.lock`));
  }
}
export async function mutate(directory, operation) {
  return withLock(directory, 'state', async () => {
    const file = path.join(directory, 'state.json');
    const original = await readText(file);
    const state = parseState(original);
    const migrateV1 = Boolean(original && JSON.parse(original).schemaVersion === 1);
    let lastSaved = null;
    const save = async () => {
      if (migrateV1) {
        const backup = path.join(directory, 'migrations', `v1-${digest(original)}.json`);
        if (await readText(backup) === null) await atomicWrite(backup, original);
      }
      state.revision += 1;
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      try { await atomicWrite(file, serialized); }
      catch (error) { error.originalCode = error.code; error.code = 'STATE_WRITE_FAILED'; throw error; }
      lastSaved = serialized;
    };
    const result = await operation(state, save);
    // 已显式 save 过且后续未再改状态（如 Stop 先持久化预算再返回）时，不再重复落盘。
    if (lastSaved === null || `${JSON.stringify(state, null, 2)}\n` !== lastSaved) await save();
    return result;
  });
}
export async function canonical(directory) { return path.normalize(await realpath(path.resolve(directory))); }
export function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
export function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function directoryIdentity(directory) {
  const info = await stat(directory);
  return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

import { mkdir, open, readFile, readdir, rename, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const STATE_VERSION = 2;
// 锁等待是短预算重试，不是按年龄抢锁：预算由调用方按宿主超时收紧。
export const LOCK_WAIT_BUDGET_MS = 1200;
const LOCK_POLL_MIN_MS = 15;
const LOCK_POLL_MAX_MS = 60;
// 锁/恢复标记刚创建时内容可能还没写完，这段时间内不判损坏。创建后立即写入，宽限只需覆盖写入。
const LOCK_WRITE_GRACE_MS = 400;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
// 锁是否仍由活进程持有：只有操作系统明确报告 ESRCH 才算死；EPERM 等一律按仍存活处理。
function liveness(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : true; }
}
async function hold(deadline, state) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  await sleep(Math.min(state.poll, remaining));
  state.poll = Math.min(state.poll * 2, LOCK_POLL_MAX_MS);
  return Date.now() < deadline;
}
const lockDiagnostic = (file, action) => `锁内容不可辨认（${file}）：保留原文件不回收。先确认没有进程正在使用本状态目录，再把它移到 retired-locks/${path.basename(file)} 后重试${action ? `；${action}` : ''}`;
// 回收死持有者的锁。guard 串行化回收并记录可核验的回收者；回收前重新读取目标锁的持有者，
// 目标已换人时停止，避免移走新锁。guard 自身由崩溃进程遗留时，凭其记录的 pid 判定后移到 retired-locks。
async function recoverDeadLock(directory, file, previous, deadline) {
  const retired = path.join(directory, 'retired-locks');
  await mkdir(retired, { recursive: true });
  const guardFile = `${file}.recovery`;
  const guardPoll = { poll: LOCK_POLL_MIN_MS };
  let guard;
  for (;;) {
    try { guard = await open(guardFile, 'wx'); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(guardFile).catch(() => null);
      if (!info) continue;
      const raw = await readText(guardFile, null);
      let holder = null;
      try { holder = raw ? JSON.parse(raw) : null; } catch { holder = null; }
      if (!holder || typeof holder !== 'object' || !Number.isSafeInteger(holder.pid)) {
        // 空或损坏的 guard 不猜成死锁：宽限期内可能是写入中的新 guard。
        if (Date.now() - info.mtimeMs < LOCK_WRITE_GRACE_MS && await hold(deadline, guardPoll)) continue;
        fail('LOCKED', lockDiagnostic(guardFile, '恢复用的 guard 需要辨认后才能回收旧锁'));
      }
      if (liveness(holder.pid) !== false) {
        if (!await hold(deadline, guardPoll)) fail('LOCKED', `另一进程正在辨认旧锁（pid=${holder.pid}，guard=${guardFile}）；保留待办，不并发回收`);
        continue;
      }
      await rename(guardFile, path.join(retired, `${randomUUID()}.stale-recovery.lock`));
    }
  }
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, name: path.basename(file), targetPid: previous.pid, targetToken: previous.token ?? null, createdAt: new Date().toISOString() }));
    const currentRaw = await readText(file, null);
    let current = null;
    try { current = currentRaw ? JSON.parse(currentRaw) : null; } catch { current = null; }
    if (!current || current.pid !== previous.pid || (current.token ?? null) !== (previous.token ?? null)) fail('LOCKED', '锁持有者已变化，停止回收');
    if (liveness(current.pid) !== false) fail('LOCKED', '锁持有者仍在运行，停止回收');
    await rename(file, path.join(retired, `${randomUUID()}.dead.lock`));
  } finally {
    await guard.close().catch(() => {});
    await rename(guardFile, path.join(retired, `${randomUUID()}.recovery.lock`)).catch(() => {});
  }
}
export async function withLock(directory, name, operation, options = {}) {
  const locks = path.join(directory, 'locks');
  await mkdir(locks, { recursive: true });
  const file = path.join(locks, `${digest(name)}.lock`);
  const budget = Number.isFinite(options.budgetMs) ? Math.max(0, options.budgetMs) : LOCK_WAIT_BUDGET_MS;
  const deadline = Date.now() + budget;
  const token = randomUUID();
  const poll = { poll: LOCK_POLL_MIN_MS };
  let handle;
  for (;;) {
    try { handle = await open(file, 'wx'); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const raw = await readText(file, null);
      let previous = null;
      try { previous = raw ? JSON.parse(raw) : null; } catch { previous = null; }
      if (!previous || typeof previous !== 'object') {
        // 刚创建、正文尚未写入的锁给一段宽限；超过宽限仍不可辨认时保留现场并给出可执行诊断。
        if (Date.now() - info.mtimeMs < LOCK_WRITE_GRACE_MS && await hold(deadline, poll)) continue;
        fail('LOCKED', lockDiagnostic(file));
      }
      if (liveness(previous.pid) !== false) {
        if (!await hold(deadline, poll)) fail('LOCKED', `锁正在被 pid=${previous.pid ?? '未知'} 持有（自 ${previous.createdAt || '未知'}）；保留待办，不按超时抢锁`);
        continue;
      }
      await recoverDeadLock(directory, file, previous, deadline);
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, name, createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    const retired = path.join(directory, 'retired-locks');
    await mkdir(retired, { recursive: true });
    // 只移走自己仍持有的锁；token 已变时保留现场，避免把别人的新锁归档。
    const raw = await readText(file, null);
    let current = null;
    try { current = raw ? JSON.parse(raw) : null; } catch { current = null; }
    if (current?.token === token) await rename(file, path.join(retired, `${randomUUID()}.lock`)).catch(() => {});
  }
}
export async function mutate(directory, operation, options = {}) {
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
  }, options);
}
// 生命周期结束事件的独立落盘目录。事件按时间命名，读取时按名称即先进先出；
// 只承接已识别的结束事件，不把 signal 或其它消息写成待办。
export const LIFECYCLE_DIRECTORY = 'lifecycle-events';
export async function recordLifecycleEvent(directory, record) {
  const folder = path.join(directory, LIFECYCLE_DIRECTORY);
  await mkdir(folder, { recursive: true });
  const name = `${String(Date.now()).padStart(14, '0')}-${randomUUID()}.json`;
  await atomicWrite(path.join(folder, name), `${JSON.stringify(record, null, 2)}\n`);
  return name;
}
export async function lifecycleEvents(directory) {
  const folder = path.join(directory, LIFECYCLE_DIRECTORY);
  let names;
  try { names = await readdir(folder); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
  const events = [];
  for (const name of names.filter(item => item.endsWith('.json')).sort()) {
    const raw = await readText(path.join(folder, name), null);
    let record = null;
    try { record = raw ? JSON.parse(raw) : null; } catch { record = null; }
    events.push({ name, record });
  }
  return events;
}
// 已消费或确定不适用的事件移到 consumed/ 保留诊断，不从磁盘直接删除。
export async function retireLifecycleEvent(directory, name) {
  const folder = path.join(directory, LIFECYCLE_DIRECTORY);
  const consumed = path.join(folder, 'consumed');
  await mkdir(consumed, { recursive: true });
  await rename(path.join(folder, name), path.join(consumed, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
// 缺可信关联的事件不丢弃、也不反复重试：移到 deferred/ 并附原因，等人工核对。
// 同一事件（event+session+turn）重复落盘时只保留一份，其余归入 consumed/。
export async function deferLifecycleEvent(directory, name, reason) {
  const folder = path.join(directory, LIFECYCLE_DIRECTORY);
  const deferred = path.join(folder, 'deferred');
  const consumed = path.join(folder, 'consumed');
  await mkdir(deferred, { recursive: true });
  await mkdir(consumed, { recursive: true });
  const raw = await readText(path.join(folder, name), null);
  let record = null;
  try { record = raw ? JSON.parse(raw) : null; } catch { record = null; }
  const scope = record ? [record.event, record.sessionId, record.turnId].join('\0') : name;
  for (const other of (await readdir(deferred)).filter(item => item.endsWith('.json'))) {
    const text = await readText(path.join(deferred, other), null);
    let item = null;
    try { item = text ? JSON.parse(text) : null; } catch { item = null; }
    if (item && [item.event, item.sessionId, item.turnId].join('\0') === scope) {
      await rename(path.join(folder, name), path.join(consumed, `${randomUUID()}.duplicate.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return { name: other, reason: 'duplicate' };
    }
  }
  const target = path.join(deferred, name);
  await rename(path.join(folder, name), target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await atomicWrite(`${target}.reason.txt`, `${reason}\n`);
  return { name, reason };
}
// 诊断出口：列出仍未消费、需要人工辨认的结束事件。
export async function pendingLifecycleEvents(directory) {
  const folder = path.join(directory, LIFECYCLE_DIRECTORY);
  const names = await readdir(folder).catch(() => []);
  const deferred = await readdir(path.join(folder, 'deferred')).catch(() => []);
  return { queued: names.filter(name => name.endsWith('.json')), deferred: deferred.filter(name => name.endsWith('.json')) };
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

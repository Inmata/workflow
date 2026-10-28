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
  // 退避加少量抖动：同时进入的竞争者不会长期同步碰撞。
  await sleep(Math.min(state.poll, remaining) + Math.floor(Math.random() * 10));
  state.poll = Math.min(state.poll * 2, LOCK_POLL_MAX_MS);
  return Date.now() < deadline;
}
const lockDiagnostic = (file, action) => `锁内容不可辨认（${file}）：保留原文件不回收。先确认没有进程正在使用本状态目录，再把它移到 retired-locks/${path.basename(file)} 后重试${action ? `；${action}` : ''}`;
// 仅测试使用的交错点钩子：挂在全局符号上，不作为 store 的导出句柄；未设置时是空操作。
// beforeArchive 在确认某张死票据后、按唯一名归档前调用，用于确定性复现"读取后延迟归档"的交错。
const LOCK_TEST_HOOKS = Symbol.for('workflow.lock-test-hooks');
async function runLockHook(name, context) {
  const hook = globalThis[LOCK_TEST_HOOKS]?.[name];
  if (typeof hook === 'function') await hook(context);
}
// 锁目录协议：每个等待者/持有者用唯一票据文件表示，票据名本身携带 pid 与 token。
// - 等待票据 `<prefix>.lock.<pid>.<token>.wait` 不阻塞任何人；成为持有者时把同一票据原子改名为 `.hold`。
// - 归档死者只按它自己的唯一票据名移动；后来者新建的活跃票据必然是不同的唯一名，
//   因此结构上不存在"读到死锁 -> 按固定路径摘走 -> 误移新持有者"的窗口。
// - 改名为持有票据后再扫描一次：两个同时改名的竞争者至少有一个能看到对方，看到即退回等待，
//   保证同一时刻只有一个 `.hold`（互相都看到时双方都退让，下一轮带抖动重试）。
// - 旧版固定路径锁 `<prefix>.lock` 和 guard `<prefix>.lock.recovery` 只读不移动：
//   活进程按持有者等待（兼容旧版本），死进程忽略并留一份诊断，绝不按固定路径摘走。
// - 旧实现崩溃留下的 `.recheck-*` 待复核文件名字唯一，可安全归档到 retired-locks。
const TICKET_PATTERN = /^(\d+)\.([0-9a-f-]{36})\.(wait|hold)$/i;
const lockPlan = prefix => ({
  ticketPrefix: `${prefix}.lock.`,
  legacyLock: `${prefix}.lock`,
  legacyGuard: `${prefix}.lock.recovery`,
  legacyQuarantine: [`.${prefix}.lock.recheck-`, `.${prefix}.lock.recovery.recheck-`],
});
function classifyLockName(name, plan) {
  if (name === plan.legacyGuard) return { kind: 'legacy-guard' };
  if (name === plan.legacyLock) return { kind: 'legacy-lock' };
  if (plan.legacyQuarantine.some(item => name.startsWith(item))) return { kind: 'legacy-quarantine' };
  if (!name.startsWith(plan.ticketPrefix)) return null;
  const rest = name.slice(plan.ticketPrefix.length);
  if (rest === 'recovery') return { kind: 'legacy-guard' };
  const match = TICKET_PATTERN.exec(rest);
  if (!match) return null;
  return { kind: 'ticket', pid: Number(match[1]), token: match[2], state: match[3].toLowerCase() };
}
async function readLockHolder(file) {
  const raw = await readText(file, null);
  if (raw === null) return { missing: true, holder: null };
  let holder = null;
  try { holder = raw ? JSON.parse(raw) : null; } catch { holder = null; }
  return { missing: false, holder: holder && typeof holder === 'object' && !Array.isArray(holder) ? holder : null };
}
// 只读扫描锁目录：辨认活跃持有者、死票据、旧格式残留和待复核文件，不做任何移动。
async function inspectLocks(locks, plan, ownNames) {
  const found = { liveHolds: [], liveLegacy: [], unreadable: [], dead: [], deadLegacy: [], quarantines: [] };
  let names;
  try { names = await readdir(locks); } catch (error) { if (error.code === 'ENOENT') return found; throw error; }
  for (const name of names) {
    if (ownNames.has(name)) continue;
    const kind = classifyLockName(name, plan);
    if (!kind) continue;
    const file = path.join(locks, name);
    if (kind.kind === 'legacy-quarantine') { found.quarantines.push({ name, file }); continue; }
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    const { missing, holder } = await readLockHolder(file);
    if (missing) continue;
    if (kind.kind === 'ticket') {
      // 身份以票据文件名里的 pid、token 为准：正文只作旁证。若让正文 pid 决定判活，
      // 一个正文损坏（但仍是合法 JSON）的活票据会被当成死票据归档，后来者误入临界区。
      const pid = kind.pid;
      const token = kind.token;
      if (liveness(pid) === false) { found.dead.push({ name, file, pid, token, state: kind.state }); continue; }
      const consistent = holder && holder.pid === pid && holder.token === token;
      if (!consistent) {
        // 正文缺失或与文件名不一致：宽限期内可能正在写入；之后按损坏票据保留文件并给 LOCKED 诊断，不回收。
        if (Date.now() - info.mtimeMs < LOCK_WRITE_GRACE_MS) {
          if (kind.state === 'hold') found.liveHolds.push({ name, file, pid, token });
          continue;
        }
        if (kind.state === 'hold') found.unreadable.push({ name, file, kind: 'ticket' });
        continue;
      }
      if (kind.state === 'hold') found.liveHolds.push({ name, file, pid, token, createdAt: holder.createdAt });
      continue;
    }
    // 旧格式固定路径：只辨认，不移动。活进程继续按持有者等待，死进程只留诊断。
    if (!holder || !Number.isSafeInteger(holder.pid)) {
      if (Date.now() - info.mtimeMs < LOCK_WRITE_GRACE_MS) { found.liveLegacy.push({ name, file, kind: kind.kind, pid: null }); continue; }
      found.unreadable.push({ name, file, kind: kind.kind });
      continue;
    }
    if (liveness(holder.pid) !== false) found.liveLegacy.push({ name, file, kind: kind.kind, pid: holder.pid, createdAt: holder.createdAt });
    else found.deadLegacy.push({ name, file, kind: kind.kind, pid: holder.pid });
  }
  return found;
}
// 归档只按源文件自己的唯一名字移动；ENOENT 说明别人已先归档。
// 目标目录先建好：否则 rename 会因目标目录缺失抛 ENOENT，被误当成"别人已归档"而吞掉死票据。
async function moveToRetired(from, retired, label) {
  await mkdir(retired, { recursive: true });
  await rename(from, path.join(retired, `${randomUUID()}.${label}`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
// 旧格式残留只读：留一份有界诊断（每个路径一份），原文件保持不变。
async function noteLegacyArtifact(retired, name, message) {
  const note = path.join(retired, `${digest(name)}.legacy-note.txt`);
  if (await readText(note, null) !== null) return;
  await atomicWrite(note, `${message}\n`).catch(() => {});
}
// 死票据与旧待复核文件都按各自唯一名字归档；旧格式固定路径永不移动。
async function settleLockArtifacts(retired, found) {
  for (const item of found.dead) {
    await runLockHook('beforeArchive', { file: item.file, name: item.name, pid: item.pid, token: item.token, state: item.state, kind: 'ticket' });
    await moveToRetired(item.file, retired, item.state === 'hold' ? 'dead-holder.lock' : 'dead-waiter.lock');
  }
  for (const item of found.deadLegacy) {
    await noteLegacyArtifact(retired, item.name, item.kind === 'legacy-guard'
      ? `旧格式恢复 guard 的持有进程 pid=${item.pid} 已退出；新锁协议不使用该路径，保留原文件供核对：${item.file}`
      : `旧格式锁的持有进程 pid=${item.pid} 已退出；新锁协议不使用该路径，保留原文件供核对：${item.file}`);
  }
  for (const item of found.quarantines) await moveToRetired(item.file, retired, 'legacy-quarantine.lock');
}
function lockBlockMessage(found) {
  const legacy = found.liveLegacy[0];
  if (legacy) return `${legacy.kind === 'legacy-guard' ? '旧格式恢复 guard' : '旧格式锁'}正在被 pid=${legacy.pid ?? '未知'} 持有（${legacy.file}）；保留待办，不按超时抢锁`;
  const holder = found.liveHolds[0];
  return `锁正在被 pid=${holder.pid} 持有（自 ${holder.createdAt || '未知'}）；保留待办，不按超时抢锁`;
}
const lockUnreadableMessage = item => lockDiagnostic(item.file, item.kind === 'legacy-guard' ? '恢复用的 guard 需要辨认后才能回收旧锁' : undefined);
async function createLockTicket(file, record) {
  const handle = await open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(record), 'utf8'); }
  finally { await handle.close().catch(() => {}); }
}

export async function withLock(directory, name, operation, options = {}) {
  const locks = path.join(directory, 'locks');
  await mkdir(locks, { recursive: true });
  const retired = path.join(directory, 'retired-locks');
  await mkdir(retired, { recursive: true });
  const plan = lockPlan(digest(name));
  const budget = Number.isFinite(options.budgetMs) ? Math.max(0, options.budgetMs) : LOCK_WAIT_BUDGET_MS;
  const deadline = Date.now() + budget;
  const poll = { poll: LOCK_POLL_MIN_MS };
  const token = randomUUID();
  const base = `${plan.ticketPrefix}${process.pid}.${token}`;
  const waitFile = path.join(locks, `${base}.wait`);
  const holdFile = path.join(locks, `${base}.hold`);
  const ownNames = new Set([path.basename(waitFile), path.basename(holdFile)]);
  const record = { pid: process.pid, token, name, createdAt: new Date().toISOString() };
  let current = waitFile;
  let holding = false;
  let blocked = null;
  try {
    await createLockTicket(waitFile, record);
    for (;;) {
      const found = await inspectLocks(locks, plan, ownNames);
      await settleLockArtifacts(retired, found);
      if (found.unreadable.length) fail('LOCKED', lockUnreadableMessage(found.unreadable[0]));
      if (found.liveHolds.length || found.liveLegacy.length) {
        blocked = lockBlockMessage(found);
        if (!await hold(deadline, poll)) fail('LOCKED', blocked);
        continue;
      }
      // 只对自己的唯一票据改名，从未按固定路径摘走任何锁。
      try { await rename(waitFile, holdFile); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // 自己的等待票据被外部清理：重新创建后继续，不猜持有。
        await createLockTicket(waitFile, record);
        if (!await hold(deadline, poll)) fail('LOCKED', blocked || '锁等待预算耗尽：等待票据被清理后未能重新取得');
        continue;
      }
      current = holdFile;
      holding = true;
      // 改名后复核：同时改名的竞争者至少有一个会看到对方；看到任何其他持有票据就退回等待。
      const after = await inspectLocks(locks, plan, ownNames);
      await settleLockArtifacts(retired, after);
      if (after.unreadable.length) {
        await rename(holdFile, waitFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
        current = waitFile; holding = false;
        fail('LOCKED', lockUnreadableMessage(after.unreadable[0]));
      }
      if (after.liveHolds.length || after.liveLegacy.length) {
        await rename(holdFile, waitFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
        current = waitFile; holding = false;
        blocked = lockBlockMessage(after);
        if (!await hold(deadline, poll)) fail('LOCKED', blocked);
        continue;
      }
      return await operation();
    }
  } finally {
    await mkdir(retired, { recursive: true });
    await moveToRetired(current, retired, holding ? 'released.lock' : 'abandoned.lock');
    // 极端情况下（改名失败后重建）两张票据同时存在：都按自己的唯一名归档。
    await moveToRetired(current === waitFile ? holdFile : waitFile, retired, 'abandoned.lock');
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
// deferred/ 里的记录也要能重新进入消费：会话稍后登记、或收到其他入口事件时按有界重试恢复关联。
export async function deferredLifecycleEvents(directory) {
  const folder = path.join(directory, LIFECYCLE_DIRECTORY, 'deferred');
  let names;
  // 目录不存在才按"没有 deferred 记录"处理；被同名文件占住是损坏，交给调用方诊断，不能当作清空。
  try { names = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const events = [];
  for (const name of names.filter(item => item.endsWith('.json')).sort()) {
    const raw = await readText(path.join(folder, name), null);
    let record = null;
    try { record = raw ? JSON.parse(raw) : null; } catch { record = null; }
    events.push({ name, record });
  }
  return events;
}
const lifecycleSource = (directory, from) => path.join(directory, LIFECYCLE_DIRECTORY, ...(from === 'deferred' ? ['deferred'] : []));
// 已消费或确定不适用的事件移到 consumed/ 保留诊断，不从磁盘直接删除。
export async function retireLifecycleEvent(directory, name, from = 'queue') {
  const consumed = path.join(directory, LIFECYCLE_DIRECTORY, 'consumed');
  await mkdir(consumed, { recursive: true });
  await rename(path.join(lifecycleSource(directory, from), name), path.join(consumed, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
// 缺可信关联的事件不丢弃，移到 deferred/ 并附原因；后续入口按有界重试重新尝试。
// 同一事件（event+project+session+turn+宿主事件 ID）重复落盘时只保留一份，其余归入 consumed/。
// 去重键带项目与宿主事件 ID，避免把不同项目/不同宿主事件合并成一条；消费回执复用同一作用域。
export const lifecycleScope = record => [record.event, record.projectId ?? '', record.sessionId ?? '', record.turnId ?? '', record.hostEventId ?? ''].join('\0');
export async function deferLifecycleEvent(directory, name, reason, from = 'queue') {
  const folder = path.join(directory, LIFECYCLE_DIRECTORY);
  const deferred = path.join(folder, 'deferred');
  const consumed = path.join(folder, 'consumed');
  await mkdir(deferred, { recursive: true });
  await mkdir(consumed, { recursive: true });
  const source = path.join(lifecycleSource(directory, from), name);
  const raw = await readText(source, null);
  let record = null;
  try { record = raw ? JSON.parse(raw) : null; } catch { record = null; }
  const scope = record ? lifecycleScope(record) : name;
  for (const other of (await readdir(deferred)).filter(item => item.endsWith('.json'))) {
    const text = await readText(path.join(deferred, other), null);
    let item = null;
    try { item = text ? JSON.parse(text) : null; } catch { item = null; }
    if (item && lifecycleScope(item) === scope) {
      await rename(source, path.join(consumed, `${randomUUID()}.duplicate.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return { name: other, reason: 'duplicate', moved: true, note: 'duplicate' };
    }
  }
  const target = path.join(deferred, name);
  await rename(source, target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  // 到这里移动已经发生或源已被并发移走。原因文件只是副本：写入失败不能报成"事件仍在原处"，
  // 交给调用方如实报告位置，并由状态里的待写诊断在下一次入口重试。
  if (await readText(target, null) === null) return { name, reason, moved: false, note: 'missing' };
  try {
    await atomicWrite(`${target}.reason.txt`, `${reason}\n`);
    return { name, reason, moved: true, note: 'written' };
  } catch (error) {
    return { name, reason, moved: true, note: 'failed', code: error.code || 'IO', message: error.message };
  }
}
// 诊断写入是可恢复动作：先读现有内容，只有不一致时才重写；事件已被移走时不再写孤儿原因文件。
// 原因路径不可读（例如被同名目录占住）按"尚未写好"处理，交给写入失败上报与下一次重试，不阻断消费。
export async function readDeferredLifecycleNote(directory, name) {
  try { return await readText(path.join(directory, LIFECYCLE_DIRECTORY, 'deferred', `${name}.reason.txt`), null); }
  catch { return null; }
}
export async function noteDeferredLifecycleEvent(directory, name, reason) {
  const target = path.join(directory, LIFECYCLE_DIRECTORY, 'deferred', name);
  if (await readText(target, null) === null) return { name, status: 'missing' };
  const content = `${reason}\n`;
  const current = await readText(`${target}.reason.txt`, null);
  if (current === content) return { name, status: 'unchanged' };
  await atomicWrite(`${target}.reason.txt`, content);
  return { name, status: 'written' };
}
// 状态提交成功后才执行文件归档：状态写入失败或进程在保存后、归档前退出时，事件仍留在扫描范围，
// 下一次入口靠已持久化的回执幂等跳过。单个归档失败不回滚状态；失败项带回调用方，便于如实提示。
// 失败区分"移动失败"（事件仍在原位置）与"原因文件写入失败"（事件已移入 deferred/，只缺副本）。
export async function archiveLifecycleEvents(directory, actions) {
  const written = [], failed = [];
  for (const action of actions || []) {
    try {
      if (action.to === 'consumed') await retireLifecycleEvent(directory, action.name, action.from);
      else if (action.to === 'deferred') {
        const result = await deferLifecycleEvent(directory, action.name, action.reason, action.from);
        if (result.note === 'failed') {
          failed.push({ name: action.name, to: action.to, from: action.from, stage: 'note', location: 'deferred', code: result.code || 'IO', message: result.message });
          continue;
        }
      }
      else if (action.to === 'deferred-note') await noteDeferredLifecycleEvent(directory, action.name, action.reason);
      written.push(action.name);
    } catch (error) {
      // 移动失败：事件仍在原位置；已保存的 receipt 会让下次消费变成幂等跳过。
      failed.push({ name: action.name, to: action.to, from: action.from, stage: 'move', location: action.from || 'queue', code: error.code || 'IO', message: error.message });
    }
  }
  return { written, failed };
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

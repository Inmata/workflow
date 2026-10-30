import path from 'node:path';
import { readdir, lstat } from 'node:fs/promises';
import { digest, fail, mutate, readState, readText, SCHEMA_VERSION, writeJSON } from './store.mjs';
import { currentIdentity, identifier, sessionKey, textField, taskKey } from './protocol.mjs';
import { document, safeDirectory, safeDocument, SENSITIVE, writeDocuments } from './documents.mjs';
import { projectFor, learningConfig } from './learning-config.mjs';

export const projectData = (directory, project) => path.join(directory, 'projects', project.projectId);
function storageId(value) {
  identifier(value, 'id');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail('INPUT', '材料或事件 ID 需为安全文件名，最多 128 字符');
  return value;
}
export const entryPath = key => '.workflow/knowledge/' + identifier(key, 'knowledgeId') + '.md';
export async function readItems(directory, project, folder) {
  const base = path.join(projectData(directory, project), folder);
  const names = await readdir(base).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const result = [];
  for (const name of names.sort()) if (name.endsWith('.json')) result.push(JSON.parse(await readText(path.join(base, name))));
  return result;
}
export async function putItem(directory, project, folder, item) {
  storageId(item.id);
  await writeJSON(path.join(projectData(directory, project), folder, item.id + '.json'), item);
}
export function normalizeObservation(input) {
  const result = {};
  for (const key of ['id', 'incidentId']) result[key] = identifier(input[key], key);
  storageId(result.id);
  for (const key of ['summary', 'conditions']) result[key] = textField(input[key], key);
  if (!['correction', 'failure', 'success', 'method', 'preference', 'legacy'].includes(input.kind)) fail('INPUT', '未知材料 kind');
  result.kind = input.kind;
  if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.some(e => typeof e !== 'string' || !e.trim() || e.length > 4000)) fail('EVIDENCE', '材料需要可定位证据');
  result.evidence = input.evidence;
  result.paths = input.paths || [];
  if (!Array.isArray(result.paths) || result.paths.some(p => typeof p !== 'string' || p.includes('..') || path.isAbsolute(p))) fail('PATH', 'paths 需为相对路径');
  result.knowledgeId = input.knowledgeId ? identifier(input.knowledgeId, 'knowledgeId') : null;
  result.explicit = input.explicit === true;
  result.verified = input.verified === true;
  if (SENSITIVE.test(JSON.stringify(result))) fail('SENSITIVE', '材料疑似包含凭据');
  return result;
}
// 人工采集与自动候选共用：明确纠正或已验证失败指向旧知识时，先让该知识停止默认召回。
export function isCounterEvidence(material) {
  return Boolean(material.knowledgeId) && ((material.kind === 'correction' && material.explicit) || (material.kind === 'failure' && material.verified));
}
export async function markCounterEvidence(project, material, save, at = material.createdAt || new Date().toISOString()) {
  if (!isCounterEvidence(material)) return false;
  project.learning ||= {};
  project.learning.disputes ||= {};
  project.learning.disputes[material.knowledgeId] = { observationId: material.id, reason: material.summary, at };
  await save();
  return true;
}
// 新材料的同知识或同条件等待项回到 pending，供下次复盘重新评估。
export async function wakeWaiting(directory, project, material) {
  let woken = 0;
  for (const waiting of await readItems(directory, project, 'inbox')) {
    if (waiting.id === material.id) continue;
    if (waiting.status === 'waiting' && ((material.knowledgeId && waiting.knowledgeId === material.knowledgeId) || waiting.conditions === material.conditions)) {
      waiting.status = 'pending'; waiting.wokenBy = material.id;
      await putItem(directory, project, 'inbox', waiting);
      woken++;
    }
  }
  return woken;
}
// 材料引用的旧知识必须真实存在；否则反例、唤醒和复盘目标都可能指向不存在的条目。
export async function requireKnowledge(project, knowledgeId) {
  const entries = await readEntries(project);
  if (!entries.some(entry => entry.id === knowledgeId)) fail('KNOWLEDGE', '知识不存在');
  return entries;
}
export async function capture(directory, input) {
  const material = normalizeObservation(input.observation || input);
  return mutate(directory, async (state, save) => {
    const { project, session, task } = currentIdentity(state, input);
    // 采集只写本机材料，不授予项目正文写入权限。禁止学习的任务不记录材料。
    if (task.permissions.learning === false) fail('PERMISSION', '本任务禁止经验采集');
    const file = path.join(projectData(directory, project), 'inbox', material.id + '.json');
    const hash = digest(JSON.stringify(material));
    const old = await readText(file);
    if (old) {
      if (JSON.parse(old).hash !== hash) fail('CONFLICT', '同一材料 ID 正文不同');
      return { id: material.id, saved: true, replayed: true };
    }
    if (material.knowledgeId) await requireKnowledge(project, material.knowledgeId);
    const now = new Date().toISOString();
    const item = { ...material, hash, projectId: project.projectId, taskId: task.taskId, sessionId: session.sessionId, turnId: session.turnId, createdAt: now, status: 'pending' };
    await markCounterEvidence(project, item, save, now);
    await putItem(directory, project, 'inbox', item);
    await wakeWaiting(directory, project, item);
    return { id: item.id, saved: true, status: 'pending' };
  });
}
const CAPTURE_IDENTITY_FIELDS = ['schemaVersion', 'projectId', 'sessionId', 'turnId', 'taskId', 'ticket', 'interruptEpoch', 'expectedRevision', 'signalId', 'action'];
const splitList = value => value.split(',').map(item => item.trim()).filter(Boolean);
// 便捷 capture：身份从本机状态补齐（与 signal 相同），一条短材料不必先写 JSON 文件。
// 与 --input 同时给出时只放补充材料字段；身份字段和同字段冲突都返回 INPUT，不静默覆盖。
export function buildCapture(state, resolved, options, extra = {}) {
  const sessionId = identifier(options.session, '--session');
  const turnId = identifier(options.turn, '--turn');
  const projectId = resolved.project.projectId;
  const session = state.sessions[sessionKey(projectId, sessionId)];
  if (!session) fail('IDENTITY', '当前项目没有这个会话；--session 取 context identity.sessionId');
  if (session.turnId !== turnId || session.interrupted) fail('STALE', `回合已失效（当前 turnId=${session.interrupted ? '已中断' : session.turnId}）；按当前 identity 重发`);
  const misplaced = Object.keys(extra).filter(key => CAPTURE_IDENTITY_FIELDS.includes(key));
  if (misplaced.length) fail('INPUT', `--input 不要带身份字段（${misplaced.join('、')}），由命令行参数和本机状态补齐`);
  const supplement = extra.observation && typeof extra.observation === 'object' && !Array.isArray(extra.observation) ? extra.observation : extra;
  // 展开时 supplement 的字段会覆盖自动补齐的身份；嵌套 observation 也要检查，不能只在顶层挡。
  if (supplement !== extra) {
    const nested = Object.keys(supplement).filter(key => CAPTURE_IDENTITY_FIELDS.includes(key));
    if (nested.length) fail('INPUT', `--input 的 observation 不要带身份字段（${nested.join('、')}），由命令行参数和本机状态补齐`);
  }
  const taskId = identifier(options.task || session.taskId, '--task');
  const cli = {};
  for (const [flag, key] of Object.entries({ id: 'id', kind: 'kind', summary: 'summary', conditions: 'conditions', knowledge: 'knowledgeId' })) {
    if (options[flag] !== undefined) cli[key] = options[flag];
  }
  if (options.evidence !== undefined) cli.evidence = Array.isArray(options.evidence) ? options.evidence : [options.evidence];
  if (options.paths !== undefined) cli.paths = splitList(options.paths);
  if (options.incident !== undefined) cli.incidentId = options.incident;
  if (options.explicit) cli.explicit = true;
  if (options.verified) cli.verified = true;
  const merged = { ...supplement };
  for (const key of Object.keys(cli)) {
    if (merged[key] !== undefined && JSON.stringify(merged[key]) !== JSON.stringify(cli[key])) fail('INPUT', `便捷参数与 --input 的 ${key} 不一致；同一个值只在一处给出`);
    merged[key] = cli[key];
  }
  // 必填项先在 CLI 点名，免得多跑一轮才由 capture 报 INPUT；完整材料仍可走 --input。
  // incidentId 不按 taskId 缺省：成熟度按独立事件计数，同任务多事件或跨任务同一事件都会因此失真。
  const missing = ['id', 'kind', 'summary', 'conditions', 'evidence', 'incidentId'].filter(key => merged[key] === undefined || (Array.isArray(merged[key]) && !merged[key].length));
  if (missing.length) {
    const flags = missing.map(key => `--${key === 'incidentId' ? 'incident' : key}`).join('、');
    const hint = missing.includes('incidentId') ? '；--incident 是事件 ID，同一事件跨会话/任务用同一个事件 ID' : '';
    fail('INPUT', `便捷 capture 缺少 ${flags}${hint}；完整材料可改用 --input <JSON文件>`);
  }
  return { schemaVersion: SCHEMA_VERSION, projectId, sessionId, turnId, taskId, ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision: session.revision, ...merged };
}
export async function migrateCandidates(directory, root) {
  return mutate(directory, async state => {
    const project = await projectFor(directory, root, state);
    let imported = 0;
    for (const task of Object.values(state.tasks).filter(t => t.projectId === project.projectId)) for (const c of Object.values(task.candidates || {})) {
      const key = 'legacy-' + digest(task.taskId + ':' + c.id).slice(0, 24);
      const file = path.join(projectData(directory, project), 'inbox', key + '.json');
      if (await readText(file) !== null) continue;
      await putItem(directory, project, 'inbox', { id: key, incidentId: task.taskId, kind: 'legacy', summary: c.finding, conditions: c.conditions, recommendation: c.recommendation, evidence: c.evidence, paths: [], knowledgeId: null, explicit: false, verified: false, createdAt: task.createdAt || new Date().toISOString(), projectId: project.projectId, taskId: task.taskId, status: 'pending', legacyStatus: c.status });
      imported++;
    }
    return { imported, note: '旧 applied 只代表已写入，不代表经验已验证' };
  });
}
const MARKER = '<!-- workflow-knowledge\n';
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');
// 与 review.mjs 的构造约束保持一致；枚举值由内部写入路径产生，未知值视为损坏而不是静默降权。
const ENTRY_ENUMS = {
  type: ['method', 'fact', 'preference'],
  importance: ['normal', 'important', 'critical'],
  maturity: ['unverified', 'verified', 'stable'],
};
// 检索阶段直接消费这些字段；类型损坏会在 join/replace/some 等调用处抛 TypeError 并中断整次召回。
function validateEntry(entry) {
  if (!isPlainObject(entry)) fail('KNOWLEDGE', '知识元数据不是对象');
  for (const key of ['title', 'summary', 'conditions']) if (typeof entry[key] !== 'string') fail('KNOWLEDGE', `知识字段类型无效 ${key}`);
  if (entry.tags !== undefined && !isStringArray(entry.tags)) fail('KNOWLEDGE', '知识字段类型无效 tags');
  if (entry.scope !== undefined) {
    if (!isPlainObject(entry.scope)) fail('KNOWLEDGE', '知识字段类型无效 scope');
    if (entry.scope.paths !== undefined && !isStringArray(entry.scope.paths)) fail('KNOWLEDGE', '知识字段类型无效 scope.paths');
    if (entry.scope.version !== undefined && entry.scope.version !== null && typeof entry.scope.version !== 'string') fail('KNOWLEDGE', '知识字段类型无效 scope.version');
  }
  for (const [key, allowed] of Object.entries(ENTRY_ENUMS)) if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !allowed.includes(entry[key]))) fail('KNOWLEDGE', `知识字段类型无效 ${key}`);
  // 维护路径会遍历/追加这些集合；提前拦截，避免严格读取阶段出现 TypeError。
  for (const key of ['evidence', 'history']) if (entry[key] !== undefined && !Array.isArray(entry[key])) fail('KNOWLEDGE', `知识字段类型无效 ${key}`);
  if (entry.generation !== undefined && !(Number.isInteger(entry.generation) && entry.generation >= 1)) fail('KNOWLEDGE', '知识字段类型无效 generation');
  for (const key of ['supersedes', 'supersededBy']) if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== 'string') fail('KNOWLEDGE', `知识字段类型无效 ${key}`);
  return entry;
}
export function renderEntry(entry) {
  return MARKER + JSON.stringify(entry, null, 2) + '\n-->\n\n# ' + entry.title + '\n\n' + entry.summary + '\n\n适用条件：' + entry.conditions + '\n';
}
export function parseEntry(content) {
  if (!content.startsWith(MARKER)) fail('KNOWLEDGE', '知识文件缺少元数据；保留文件待核对');
  const end = content.indexOf('\n-->', MARKER.length);
  if (end < 0) fail('KNOWLEDGE', '元数据不完整');
  let entry;
  try { entry = JSON.parse(content.slice(MARKER.length, end)); } catch { fail('KNOWLEDGE', '知识元数据损坏'); }
  validateEntry(entry);
  try { identifier(entry.id, 'knowledgeId'); } catch { fail('KNOWLEDGE', '知识 ID 无效'); }
  if (entry.schemaVersion !== 1 || !['active', 'disputed', 'superseded', 'retired'].includes(entry.status)) fail('KNOWLEDGE', '未知知识版本或状态');
  // 人工改正文需要同步结构字段，避免检索到与可见正文不同的结论。
  if (renderEntry(entry) !== content) fail('KNOWLEDGE', '知识正文与元数据不同；请通过 revise 更新并保留原因');
  return entry;
}
const KNOWLEDGE_FOLDER = '.workflow/knowledge/';
// 仅测试使用的读取故障注入点：与 store 的锁交错钩子一致，挂在全局符号上，未设置时是空操作。
const KNOWLEDGE_TEST_HOOKS = Symbol.for('workflow.knowledge-test-hooks');
async function runKnowledgeHook(name, context) {
  const hook = globalThis[KNOWLEDGE_TEST_HOOKS]?.[name];
  if (typeof hook === 'function') await hook(context);
}
// 自动入口只带命中、重要遗漏摘要与总数；排除清单按条数和字符双预算截断，完整诊断留给显式查询。
const EXCLUDED_SHOWN = 10;
const EXCLUDED_SHOWN_CHARS = 1200;
const SKIPPED_SHOWN = 5;
const IMPORTANT_SHOWN = 5;

function entryFromDocument(doc, relative) {
  const value = parseEntry(doc.content);
  if (entryPath(value.id) !== relative) fail('KNOWLEDGE', '知识 ID 与文件名不一致');
  return { ...value, fingerprint: doc.fingerprint, path: relative };
}
async function entryFrom(project, relative) {
  return entryFromDocument(await document(await safeDocument(project.knowledgeRoot, relative)), relative);
}
// 维护/写入路径保持严格：跳过损坏条目只用于召回，不能据此获得可写授权。
export async function readEntries(project) {
  const folder = path.join(project.knowledgeRoot, '.workflow', 'knowledge');
  const names = await readdir(folder).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const entries = [], skipped = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const relative = KNOWLEDGE_FOLDER + name;
    try { entries.push(await entryFrom(project, relative)); }
    catch (error) { skipped.push({ path: relative, code: error.code || 'IO', message: error.message }); }
  }
  if (skipped.length) fail(skipped[0].code, `${skipped[0].path}: ${skipped[0].message}`);
  return entries;
}
// 召回路径逐条解析：坏条目跳过并留下诊断，其余有效条目继续参与检索。
async function indexedEntries(directory, project) {
  const folder = path.join(project.knowledgeRoot, '.workflow', 'knowledge');
  let names;
  try { names = await readdir(folder); }
  catch (error) { if (error.code === 'ENOENT') return { entries: [], skipped: [], missing: true }; throw error; }
  const files = [], scanSkipped = [], readable = [];
  // 目录链（含 .workflow 与 knowledge）每次召回只校验一次；不再为每个文件重复 lstat/realpath 整条路径。
  try {
    if (!await safeDirectory(project.knowledgeRoot, '.workflow/knowledge')) fail('ENOENT', '知识目录在扫描期间消失');
  } catch (error) {
    return { entries: [], skipped: [{ path: KNOWLEDGE_FOLDER, code: error.code || 'IO', message: error.message }], missing: false };
  }
  for (const name of names.filter(n => n.endsWith('.md')).sort()) {
    const relative = KNOWLEDGE_FOLDER + name;
    const file = path.join(folder, name);
    try {
      const info = await lstat(file);
      // 目录链已确认；文件本身仍逐条核对，避免用链接替换条目绕过读取边界。
      if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1)) fail('LINK', '知识文件是链接或硬链接');
      files.push([name, info.size, info.mtimeMs]);
      readable.push({ relative, file });
    } catch (error) { scanSkipped.push({ path: relative, code: error.code || 'IO', message: error.message }); }
  }
  const signature = digest(JSON.stringify(files));
  const cacheFile = path.join(projectData(directory, project), 'knowledge-index.json');
  try {
    const cached = JSON.parse(await readText(cacheFile));
    if (cached?.schemaVersion === 3 && cached.signature === signature && Array.isArray(cached.entries) && Array.isArray(cached.skipped)) {
      // 当前目录扫描发现的坏路径优先；缓存补充上次解析失败但 stat 仍正常的条目。
      const merged = new Map([...cached.skipped, ...scanSkipped].map(item => [item.path, item]));
      return { entries: cached.entries, skipped: [...merged.values()], missing: false };
    }
  } catch {}
  const entries = [], readSkipped = [], parseSkipped = [];
  for (const { relative, file } of readable) {
    let doc;
    try {
      await runKnowledgeHook('beforeRead', { relative });
      doc = await document(file);
      // 读取期间文件消失属于阶段性故障，不能当作确定性的内容损坏缓存。
      if (!doc.exists) fail('ENOENT', '读取期间知识文件消失');
    } catch (error) {
      readSkipped.push({ path: relative, code: error.code || 'IO', message: error.message });
      continue;
    }
    try { entries.push(entryFromDocument(doc, relative)); }
    catch (error) { parseSkipped.push({ path: relative, code: error.code || 'IO', message: error.message }); }
  }
  // 只有全部文件都成功读出内容时才固化索引：读取/权限/占用故障会随签名外的环境变化恢复，
  // 缓存它会让 size/mtimeMs 不变的同一文件永久跳过；目录扫描故障也只在本次实时重算。
  if (!scanSkipped.length && !readSkipped.length) {
    // 索引缓存写入失败不影响本次召回；签名包含坏文件，修复后自然重新解析。
    await writeJSON(cacheFile, { schemaVersion: 3, signature, entries, skipped: parseSkipped }).catch(() => {});
  }
  return { entries, skipped: [...scanSkipped, ...readSkipped, ...parseSkipped], missing: false };
}
export function maturityFor(evidence, type, status) {
  if (status !== 'active') return 'unverified';
  if (type === 'preference') return evidence.some(e => ['preference', 'correction'].includes(e.kind) && e.explicit) ? 'verified' : 'unverified';
  const lastCounter = evidence.findLastIndex(e => (e.kind === 'correction' && e.explicit) || (e.kind === 'failure' && e.verified));
  if (lastCounter >= 0 && !evidence.slice(lastCounter + 1).some(e => e.kind === 'success' && e.verified)) return 'unverified';
  const success = evidence.some(e => e.kind === 'success' && e.verified);
  if (!success) return 'unverified';
  const supporting = evidence.filter(e => e.kind === 'success' && e.verified);
  const incidents = new Set(supporting.map(e => e.incidentId));
  const dates = new Set(supporting.map(e => e.createdAt.slice(0, 10)));
  return incidents.size >= 3 && dates.size >= 2 ? 'stable' : 'verified';
}
const tokens = text => [...new Set((text.toLowerCase().match(/[a-z0-9_-]{2,}|[\u3400-\u9fff]{2,}/g) || []).flatMap(w => /[\u3400-\u9fff]/.test(w) ? Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)) : [w]))];
export async function selectKnowledge(directory, root, query = {}, options = {}) {
  // 调用方已按本回合状态解析出项目时可传入，省掉一次 Git 身份解析；CLI 仍按 root 解析。
  const project = options.project || await projectFor(directory, root);
  const { values: config } = await learningConfig(directory, project);
  let index;
  try { index = await indexedEntries(directory, project); }
  catch (error) {
    return { selected: [], excluded: [], excludedTotal: 0, excludedOmitted: 0, criticalOmitted: [], criticalOmittedTotal: 0, skipped: [], skippedTotal: 0, total: 0, version: null, chars: 0, unavailable: { kind: 'io', code: error.code || 'IO' } };
  }
  const entries = index.entries;
  const skipped = [...index.skipped];
  const terms = tokens(query.text || '');
  const paths = query.paths || [];
  const full = query.full === true;
  const selected = [], allExcluded = [];
  // 缓存来自上一版本或人工编辑时仍可能残留异常结构；单条失败只跳过该条，不拖垮整次召回。
  const ranked = [];
  for (const e of entries) {
    try {
      const scoped = !e.scope?.paths?.length || paths.some(p => e.scope.paths.some(s => p === s || p.startsWith(s.replace(/\/$/, '') + '/')));
      const version = !e.scope?.version || e.scope.version === query.version;
      const words = tokens(e.title + ' ' + e.summary + ' ' + e.conditions + ' ' + (e.tags || []).join(' '));
      const matches = terms.filter(t => words.includes(t)).length;
      const relevant = matches > 0 || (e.scope?.paths?.length && scoped);
      const reason = project.learning?.quarantine?.[e.path] ? '写入批次尚未完成' : project.learning?.disputes?.[e.id] ? '即时反例待处理' : e.status !== 'active' ? '状态 ' + e.status : !scoped || !version ? '适用范围不匹配' : !relevant ? '与本任务不相关' : null;
      ranked.push({ e, reason, score: matches * 100 + (e.scope?.paths?.length ? 50 : 0) + ({ normal: 0, important: 10, critical: 20 }[e.importance] || 0) + ({ unverified: 0, verified: 1, stable: 2 }[e.maturity] || 0) });
    } catch (error) {
      skipped.push({ path: typeof e?.path === 'string' ? e.path : '', code: 'KNOWLEDGE', message: '索引条目结构无效：' + error.message });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  let used = 0;
  for (const { e, reason, score } of ranked) {
    const summary = { id: e.id, title: e.title, summary: e.summary, conditions: e.conditions, maturity: e.maturity, importance: e.importance, path: e.path };
    const size = JSON.stringify(summary).length;
    const why = reason || (selected.length >= config.retrievalLimit || used + size > config.retrievalChars ? '召回预算不足' : null);
    if (why) allExcluded.push({ id: e.id, reason: why, critical: e.importance === 'critical' && !reason });
    else { selected.push(summary); used += size; }
  }
  // 排除原因按条数和字符预算输出；显式查询（full）返回完整诊断，截断时由总数说明数量。
  const excluded = [];
  let excludedChars = 0;
  for (const item of allExcluded) {
    if (!full) {
      if (excluded.length >= EXCLUDED_SHOWN) break;
      const size = JSON.stringify(item).length;
      if (excludedChars + size > EXCLUDED_SHOWN_CHARS) break;
      excludedChars += size;
    }
    excluded.push(item);
  }
  const critical = allExcluded.filter(item => item.critical);
  const version = digest(JSON.stringify([ranked.map(({ e }) => [e.id, e.fingerprint]), skipped.map(item => [item.path, item.code]), project.learning?.disputes || {}, project.learning?.quarantine || {}, config.retrievalLimit, config.retrievalChars]));
  const missing = index.missing;
  // 目录缺失本身是正常空库；已启用学习时缺失才提示，且与读取故障用不同 kind 区分。
  const unavailable = missing && project.learning?.enabled ? { kind: 'missing', code: 'ENOENT' } : null;
  return {
    selected, excluded, excludedTotal: allExcluded.length, excludedOmitted: allExcluded.length - excluded.length,
    criticalOmitted: full ? critical : critical.slice(0, IMPORTANT_SHOWN), criticalOmittedTotal: critical.length,
    skipped: full ? skipped : skipped.slice(0, SKIPPED_SHOWN), skippedTotal: skipped.length,
    total: ranked.length, missing, unavailable, version, chars: used,
  };
}
export async function feedback(directory, input) {
  if (!['shown', 'adopted', 'success', 'failure', 'correction'].includes(input.outcome)) fail('INPUT', '未知反馈');
  const key = identifier(input.knowledgeId, 'knowledgeId');
  const state = await readState(directory);
  const { project } = currentIdentity(state, input);
  if (!(await readEntries(project)).some(e => e.id === key)) fail('KNOWLEDGE', '知识不存在');
  if (['success', 'failure', 'correction'].includes(input.outcome)) return capture(directory, { ...input, observation: { ...input.observation, knowledgeId: key, kind: input.outcome } });
  return mutate(directory, async current => {
    const identity = currentIdentity(current, input);
    const event = { id: identifier(input.id, 'feedback.id'), knowledgeId: key, outcome: input.outcome, taskId: identity.task.taskId, sessionId: identity.session.sessionId, at: new Date().toISOString() };
    await putItem(directory, identity.project, 'feedback', event);
    return { recorded: true, affectsMaturity: false };
  });
}
export function maintenanceAllowed(state, project) {
  if (!project.learning?.enabled || project.learning.permission !== '.workflow/knowledge/') fail('PERMISSION', '项目尚未启用知识维护');
  if (Object.values(state.tasks).some(t => t.projectId === project.projectId && t.lifecycle === 'active')) fail('BUSY', '业务任务仍在运行，后台维护延后');
  if (Object.values(state.sessions).some(s => s.projectId === project.projectId && !s.interrupted && ['plan', 'read-only'].includes(s.permissionMode))) fail('PERMISSION', '只读或计划会话期间延后维护');
}
export async function reviseKnowledge(directory, root, input) {
  return mutate(directory, async (state, save) => {
    const project = await projectFor(directory, root, state);
    maintenanceAllowed(state, project);
    const existing = (await readEntries(project)).find(e => e.id === input.id);
    if (!existing || existing.fingerprint !== input.baseline) fail('CONFLICT', '知识缺失或指纹变化');
    const { fingerprint, path: relative, ...entry } = existing;
    textField(input.reason, 'reason');
    if (input.importance && !['normal', 'important', 'critical'].includes(input.importance)) fail('INPUT', '重要性无效');
    if (input.status && !['active', 'disputed', 'retired'].includes(input.status)) fail('INPUT', '状态无效');
    entry.importance = input.importance || entry.importance;
    // 人工提高重要性不自动提高成熟度，也不会清除反例。
    entry.status = input.status || entry.status;
    entry.history.push({ at: new Date().toISOString(), reason: input.reason, action: 'user-revise', before: { importance: existing.importance, status: existing.status } });
    const tx = await writeDocuments(directory, state, save, project, [{ path: relative, baseline: fingerprint, content: renderEntry(entry), reason: input.reason, responsibility: '用户修订', evidence: ['user:' + input.reason] }], { taskId: 'learning-revise', sessionId: 'maintenance' });
    return { status: tx.status, transactionId: tx.transactionId };
  });
}

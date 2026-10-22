import path from 'node:path';
import { readdir, lstat } from 'node:fs/promises';
import { digest, fail, mutate, readState, readText, writeJSON } from './store.mjs';
import { currentIdentity, identifier, textField, taskKey } from './protocol.mjs';
import { document, safeDocument, SENSITIVE, writeDocuments } from './documents.mjs';
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
    const now = new Date().toISOString();
    const item = { ...material, hash, projectId: project.projectId, taskId: task.taskId, sessionId: session.sessionId, turnId: session.turnId, createdAt: now, status: 'pending' };
    // 明确反例先使旧经验停止默认召回，复盘完成后才决定修订。
    if (material.knowledgeId && ((material.kind === 'correction' && material.explicit) || (material.kind === 'failure' && material.verified))) {
      project.learning ||= {};
      project.learning.disputes ||= {};
      project.learning.disputes[material.knowledgeId] = { observationId: item.id, reason: material.summary, at: now };
      await save();
    }
    await putItem(directory, project, 'inbox', item);
    for (const waiting of await readItems(directory, project, 'inbox')) {
      if (waiting.status === 'waiting' && ((item.knowledgeId && waiting.knowledgeId === item.knowledgeId) || waiting.conditions === item.conditions)) {
        waiting.status = 'pending'; waiting.wokenBy = item.id;
        await putItem(directory, project, 'inbox', waiting);
      }
    }
    return { id: item.id, saved: true, status: 'pending' };
  });
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
export function renderEntry(entry) {
  return MARKER + JSON.stringify(entry, null, 2) + '\n-->\n\n# ' + entry.title + '\n\n' + entry.summary + '\n\n适用条件：' + entry.conditions + '\n';
}
export function parseEntry(content) {
  if (!content.startsWith(MARKER)) fail('KNOWLEDGE', '知识文件缺少元数据；保留文件待核对');
  const end = content.indexOf('\n-->', MARKER.length);
  if (end < 0) fail('KNOWLEDGE', '元数据不完整');
  let entry;
  try { entry = JSON.parse(content.slice(MARKER.length, end)); } catch { fail('KNOWLEDGE', '知识元数据损坏'); }
  identifier(entry.id, 'knowledgeId');
  if (entry.schemaVersion !== 1 || !['active', 'disputed', 'superseded', 'retired'].includes(entry.status)) fail('KNOWLEDGE', '未知知识版本或状态');
  // 人工改正文需要同步结构字段，避免检索到与可见正文不同的结论。
  if (renderEntry(entry) !== content) fail('KNOWLEDGE', '知识正文与元数据不同；请通过 revise 更新并保留原因');
  return entry;
}
export async function readEntries(project) {
  const folder = path.join(project.knowledgeRoot, '.workflow', 'knowledge');
  const names = await readdir(folder).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const entries = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const relative = '.workflow/knowledge/' + name;
    const doc = await document(await safeDocument(project.knowledgeRoot, relative));
    const value = parseEntry(doc.content);
    if (entryPath(value.id) !== relative) fail('KNOWLEDGE', '知识 ID 与文件名不一致');
    entries.push({ ...value, fingerprint: doc.fingerprint, path: relative });
  }
  return entries;
}
async function indexedEntries(directory, project) {
  const names = await readdir(path.join(project.knowledgeRoot, '.workflow', 'knowledge')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const files = [];
  for (const name of names.filter(n => n.endsWith('.md')).sort()) {
    const file = await safeDocument(project.knowledgeRoot, '.workflow/knowledge/' + name);
    const info = await lstat(file);
    files.push([name, info.size, info.mtimeMs]);
  }
  const signature = digest(JSON.stringify(files));
  const cacheFile = path.join(projectData(directory, project), 'knowledge-index.json');
  try {
    const cached = JSON.parse(await readText(cacheFile));
    if (cached?.signature === signature && Array.isArray(cached.entries)) return cached.entries;
  } catch {}
  const entries = await readEntries(project);
  await writeJSON(cacheFile, { schemaVersion: 1, signature, entries });
  return entries;
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
export async function selectKnowledge(directory, root, query = {}) {
  const project = await projectFor(directory, root);
  const { values: config } = await learningConfig(directory, project);
  const entries = await indexedEntries(directory, project);
  const terms = tokens(query.text || '');
  const paths = query.paths || [];
  const selected = [], excluded = [];
  const ranked = entries.map(e => {
    const scoped = !e.scope?.paths?.length || paths.some(p => e.scope.paths.some(s => p === s || p.startsWith(s.replace(/\/$/, '') + '/')));
    const version = !e.scope?.version || e.scope.version === query.version;
    const words = tokens(e.title + ' ' + e.summary + ' ' + e.conditions + ' ' + (e.tags || []).join(' '));
    const matches = terms.filter(t => words.includes(t)).length;
    const relevant = matches > 0 || (e.scope?.paths?.length && scoped);
    const reason = project.learning?.quarantine?.[e.path] ? '写入批次尚未完成' : project.learning?.disputes?.[e.id] ? '即时反例待处理' : e.status !== 'active' ? '状态 ' + e.status : !scoped || !version ? '适用范围不匹配' : !relevant ? '与本任务不相关' : null;
    return { e, reason, score: matches * 100 + (e.scope?.paths?.length ? 50 : 0) + ({ normal: 0, important: 10, critical: 20 }[e.importance] || 0) + ({ unverified: 0, verified: 1, stable: 2 }[e.maturity] || 0) };
  }).sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  let used = 0;
  for (const { e, reason, score } of ranked) {
    const summary = { id: e.id, title: e.title, summary: e.summary, conditions: e.conditions, maturity: e.maturity, importance: e.importance, path: e.path };
    const size = JSON.stringify(summary).length;
    const why = reason || (selected.length >= config.retrievalLimit || used + size > config.retrievalChars ? '召回预算不足' : null);
    if (why) excluded.push({ id: e.id, reason: why, critical: e.importance === 'critical' && !reason });
    else { selected.push(summary); used += size; }
  }
  const version = digest(JSON.stringify([entries.map(e => [e.id, e.fingerprint]), project.learning?.disputes || {}, project.learning?.quarantine || {}, config.retrievalLimit, config.retrievalChars]));
  return { selected, excluded, criticalOmitted: excluded.filter(e => e.critical), version, chars: used };
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
    const event = { id: identifier(input.id, 'feedback.id'), knowledgeId: key, outcome: input.outcome, taskId: identity.task.taskId, at: new Date().toISOString() };
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

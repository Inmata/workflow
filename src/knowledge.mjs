import path from 'node:path';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { atomicWrite, canonical, digest, fail, id, mutate, readState, withLock, within } from './store.mjs';
import { currentIdentity, identifier, pendingFor, taskKey, textField } from './protocol.mjs';
import { resolveProject } from './projects.mjs';

const EXTENSIONS = new Set(['.md', '.txt', '.rst', '.adoc']);
const SENSITIVE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|(?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{16,}/i;
export async function safeDocument(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('PATH', '资料路径必须是项目内规范相对路径');
  if (!EXTENSIONS.has(path.extname(relative).toLowerCase()) || relative.split('/').some(part => /^(?:\.(?:git|aws|codex|agents|ssh)|credentials?|secrets?|backups)$/i.test(part))) fail('PATH', '只能维护非敏感项目文本资料');
  const resolvedRoot = await canonical(root);
  const target = path.resolve(root, relative);
  if (!within(resolvedRoot, target)) fail('PATH', '路径超出知识写入根');
  let cursor = resolvedRoot;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1)) fail('LINK', '路径含链接或硬链接，须先核对真实目标');
      if (!within(resolvedRoot, await realpath(cursor))) fail('PATH', '真实路径超出项目');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
async function document(file) {
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code === 'ENOENT') return { exists: false, content: '', fingerprint: null }; throw error; }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('FORMAT', '资料不是有效 UTF-8 文本'); }
  if (content.includes('\0') || SENSITIVE.test(content)) fail('SENSITIVE', '资料含二进制或疑似凭据内容，停止读取与快照');
  return { exists: true, content, fingerprint: digest(bytes) };
}
export async function inspectKnowledge(directory, root, relative) {
  const state = await readState(directory);
  const resolved = await resolveProject(state, root);
  if (!resolved) fail('PROJECT', '当前目录没有有效项目绑定');
  const file = await safeDocument(resolved.project.knowledgeRoot, relative);
  return { projectId: resolved.project.projectId, path: relative, ...await document(file) };
}
function evidence(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) fail('EVIDENCE', '需要可定位的非敏感证据引用');
}
function prepareCandidates(task, candidates = []) {
  if (!Array.isArray(candidates)) fail('CANDIDATE', '候选必须是数组');
  for (const candidate of candidates) {
    identifier(candidate.id, 'candidate.id');
    for (const field of ['id', 'taskId', 'workPackage', 'conditions', 'finding', 'recommendation']) textField(candidate[field], `candidate.${field}`);
    evidence(candidate.evidence);
    if (candidate.taskId !== task.taskId) fail('CANDIDATE', '候选不属于当前任务');
    const hash = digest(JSON.stringify(candidate));
    if (task.candidates[candidate.id] && task.candidates[candidate.id].hash !== hash) fail('CANDIDATE', '已有候选 ID 正文不同，需要明确修订来源');
    task.candidates[candidate.id] ||= { ...candidate, hash, status: 'pending', transactionIds: [] };
  }
}
export async function applyKnowledge(directory, input, options = {}) {
  return mutate(directory, async (state, save) => {
    const { project, session, task } = currentIdentity(state, input);
    if (project.ownerSessionId !== input.sessionId) fail('OWNER', '知识负责人未明确或不是当前会话；保留候选');
    if (task.permissions.mode !== 'write' || session.permissionMode === 'plan') fail('PERMISSION', '计划或只读任务不能写知识');
    if (!Array.isArray(input.changes) || !input.changes.length) fail('INPUT', '缺少具体资料变更');
    prepareCandidates(task, input.candidates);
    const seen = new Set();
    // Validate every request before any project document is written.
    for (const change of input.changes) {
      if (seen.has(change.path)) fail('INPUT', '同一事务不能重复目标路径');
      seen.add(change.path);
      await safeDocument(project.knowledgeRoot, change.path);
      if (!task.permissions.allowedPaths.includes(change.path)) fail('PERMISSION', '资料不在当前任务已声明范围');
      textField(change.responsibility, 'responsibility');
      textField(change.reason, 'reason');
      if (typeof change.content !== 'string' || !change.content.trim() || change.content.includes('\0') || SENSITIVE.test(change.content)) fail('SENSITIVE', '拒绝空正文、二进制或疑似凭据');
      if (change.baseline !== null && !/^[a-f0-9]{64}$/.test(change.baseline)) fail('INPUT', '缺少有效编辑前指纹');
      evidence(change.evidence);
      if (!Array.isArray(change.candidateIds) || change.candidateIds.some(candidateId => !task.candidates[candidateId])) fail('CANDIDATE', '变更引用了未知候选');
    }
    const transactionId = id('tx');
    const tx = { transactionId, projectId: project.projectId, taskId: task.taskId, sessionId: session.sessionId, status: 'prepared', createdAt: new Date().toISOString(), files: [] };
    state.transactions[transactionId] = tx;
    const txDirectory = path.join(directory, 'transactions', transactionId);
    // This journal must be durable before any target write.
    await save();
    try { await mkdir(txDirectory, { recursive: true }); }
    catch (error) {
      tx.status = 'pending';
      const pending = pendingFor(state, project.projectId, task.taskId, '快照目录不可写，未修改项目正文', 'knowledge-pending', { transactionId });
      session.revision += 1;
      await save();
      return { transactionId, status: 'pending', files: [], revision: session.revision, pendingId: pending.pendingId, error: error.code || 'IO' };
    }
    for (const change of input.changes) {
      const result = { path: change.path, before: change.baseline, after: digest(change.content), candidateIds: change.candidateIds, reason: change.reason, responsibility: change.responsibility, evidence: change.evidence, status: 'pending' };
      tx.files.push(result);
      try {
        await withLock(directory, `document:${project.knowledgeRoot}:${change.path}`, async () => {
          const file = await safeDocument(project.knowledgeRoot, change.path);
          const before = await document(file);
          const previous = Object.values(state.transactions).filter(t => t.transactionId !== transactionId && t.projectId === project.projectId && t.taskId === task.taskId).flatMap(t => t.files.map(f => ({ ...f, transactionId: t.transactionId }))).find(f => f.path === change.path && f.status === 'applied' && f.after === result.after);
          if (previous && before.fingerprint === result.after && change.candidateIds.length && change.candidateIds.every(candidateId => previous.candidateIds.includes(candidateId))) {
            Object.assign(result, { status: 'applied', reusedFrom: previous.transactionId, before: before.fingerprint });
            return;
          }
          if (change.candidateIds.some(candidateId => task.candidates[candidateId].status === 'applied')) fail('CANDIDATE', '候选已处置，拒绝重复合并');
          if (before.fingerprint !== change.baseline) fail('CONFLICT', '用户或其他会话已编辑资料；保留原文');
          const prefix = digest(change.path);
          result.snapshot = path.join(txDirectory, `${prefix}.before.txt`);
          result.proposed = path.join(txDirectory, `${prefix}.after.txt`);
          await atomicWrite(result.snapshot, before.content);
          await atomicWrite(result.proposed, change.content);
          result.existed = before.exists;
          result.status = 'prepared';
          await save();
          if (options.checkpoint) await options.checkpoint('prepared', tx, result);
          // Recheck paths and bytes immediately before replacing the target.
          await mkdir(path.dirname(file), { recursive: true });
          await safeDocument(project.knowledgeRoot, change.path);
          if ((await document(file)).fingerprint !== change.baseline) fail('CONFLICT', '准备后资料发生变化，停止替换');
          await atomicWrite(file, change.content);
          if (options.checkpoint) await options.checkpoint('written', tx, result);
          result.status = 'applied';
          await save();
        });
      } catch (error) {
        if (error.code === 'SIMULATED_CRASH' || error.code === 'STATE_WRITE_FAILED') throw error;
        result.status = error.code === 'CONFLICT' || error.code === 'CANDIDATE' ? 'conflict' : 'pending';
        result.error = error.code || 'IO';
        result.reason = error.message;
        await save();
      }
    }
    tx.status = tx.files.every(file => file.status === 'applied') ? 'applied' : tx.files.some(file => file.status === 'applied') ? 'partial' : 'pending';
    for (const candidate of Object.values(task.candidates)) {
      const files = tx.files.filter(file => file.candidateIds.includes(candidate.id));
      if (files.length && files.every(file => file.status === 'applied')) {
        candidate.status = 'applied';
        if (!candidate.transactionIds.includes(transactionId)) candidate.transactionIds.push(transactionId);
      }
    }
    session.revision += 1;
    let pending;
    if (tx.status !== 'applied') pending = pendingFor(state, project.projectId, task.taskId, '知识事务部分未完成，请核对逐文件结果', 'knowledge-pending', { transactionId });
    await save();
    return { transactionId, status: tx.status, files: tx.files, revision: session.revision, pendingId: pending?.pendingId };
  });
}
export async function recoverTransaction(directory, transactionId, root) {
  return mutate(directory, async state => {
    const resolved = await resolveProject(state, root);
    const tx = state.transactions[transactionId];
    if (!resolved || tx?.projectId !== resolved.project.projectId) fail('IDENTITY', '事务不属于当前绑定项目');
    for (const file of tx.files) {
      const target = await safeDocument(resolved.project.knowledgeRoot, file.path);
      const current = await document(target);
      if (current.fingerprint === file.after) file.status = 'applied';
      else if (current.fingerprint === file.before) file.status = 'pending';
      else file.status = 'conflict';
    }
    tx.status = tx.files.length && tx.files.every(file => file.status === 'applied') ? 'applied' : tx.files.some(file => file.status === 'applied') ? 'partial' : 'pending';
    const task = state.tasks[taskKey(tx.projectId, tx.taskId)];
    if (task) for (const candidate of Object.values(task.candidates)) {
      const files = tx.files.filter(file => file.candidateIds.includes(candidate.id));
      if (files.length && files.every(file => file.status === 'applied')) { candidate.status = 'applied'; if (!candidate.transactionIds.includes(transactionId)) candidate.transactionIds.push(transactionId); }
    }
    if (tx.status !== 'applied') pendingFor(state, tx.projectId, tx.taskId, '崩溃结果已辨认；只允许重新核对后续写未完成部分', 'knowledge-pending', { transactionId });
    return { transactionId, status: tx.status, files: tx.files, automaticWrites: 0 };
  });
}
export async function createPending(directory, input) {
  return mutate(directory, async state => {
    const { task, session } = currentIdentity(state, input);
    textField(input.reason, 'reason');
    const pending = pendingFor(state, input.projectId, task.taskId, input.reason, 'knowledge-pending', { evidence: input.evidence || [], candidateIds: input.candidateIds || [] });
    session.revision += 1;
    return { pendingId: pending.pendingId, revision: session.revision };
  });
}

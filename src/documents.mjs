import path from 'node:path';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { atomicWrite, canonical, digest, fail, id, withLock, within } from './store.mjs';

export const SENSITIVE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|(?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{16,}/i;
export async function safePath(root, relative, extensions = ['.md', '.txt', '.rst', '.adoc']) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '.' || p === '..')) fail('PATH', '需要项目内规范相对路径');
  if (!extensions.includes(path.extname(relative).toLowerCase()) || relative.split('/').some(p => /^(?:\.(?:git|aws|codex|agents|ssh)|credentials?|secrets?|backups)$/i.test(p))) fail('PATH', '只能维护非敏感项目资料');
  const base = await canonical(root);
  let cursor = base;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1)) fail('LINK', '路径含链接或硬链接');
      if (!within(base, await realpath(cursor))) fail('PATH', '真实路径超出项目');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return cursor;
}
export const safeDocument = (root, relative) => safePath(root, relative);
const SENSITIVE_DIRECTORIES = /^(?:\.(?:git|aws|codex|agents|ssh)|credentials?|secrets?|backups)$/i;
// 批量读取同一目录时只校验一次目录链；单文件仍由调用方逐条 lstat 并拒绝链接。
// 返回目录绝对路径；目录不存在返回 null，链接、硬链接或越界直接拒绝。
export async function safeDirectory(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':')) fail('PATH', '需要项目内规范相对路径');
  const base = await canonical(root);
  let cursor = base;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || SENSITIVE_DIRECTORIES.test(part)) fail('PATH', '只能维护非敏感项目资料');
    cursor = path.join(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('LINK', '路径含链接或不是目录');
    if (!within(base, await realpath(cursor))) fail('PATH', '真实路径超出项目');
  }
  return cursor;
}
export async function document(file) {
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code === 'ENOENT') return { exists: false, content: '', fingerprint: null }; throw error; }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('FORMAT', '资料不是 UTF-8'); }
  if (content.includes('\0') || SENSITIVE.test(content)) fail('SENSITIVE', '拒绝二进制或疑似凭据内容');
  return { exists: true, content, fingerprint: digest(bytes) };
}
export function validateChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) fail('INPUT', '缺少具体变更');
  const seen = new Set();
  for (const c of changes) {
    if (seen.has(c.path)) fail('INPUT', '同一事务重复路径');
    seen.add(c.path);
    if (typeof c.content !== 'string' || !c.content.trim() || c.content.includes('\0') || SENSITIVE.test(c.content)) fail('SENSITIVE', '拒绝空正文、二进制或疑似凭据');
    if (c.baseline !== null && !/^[a-f0-9]{64}$/.test(c.baseline)) fail('INPUT', '需要编辑前指纹');
    if (!c.reason || !c.responsibility || !Array.isArray(c.evidence) || !c.evidence.length || c.evidence.some(e => typeof e !== 'string' || !e.trim())) fail('EVIDENCE', '变更需要理由、责任与证据');
  }
}
// 调用者持有 state 锁并先验证权限。所有项目文档写入共用快照与恢复协议。
export async function writeDocuments(directory, state, save, project, changes, authority, options = {}) {
  validateChanges(changes);
  for (const c of changes) await safeDocument(project.knowledgeRoot, c.path);
  const transactionId = id('tx');
  const tx = { transactionId, projectId: project.projectId, ...authority, status: 'prepared', createdAt: new Date().toISOString(), files: changes.map(c => ({ path: c.path, before: c.baseline, after: digest(c.content), candidateIds: c.candidateIds || [], reason: c.reason, responsibility: c.responsibility, evidence: c.evidence, status: 'pending' })) };
  state.transactions[transactionId] = tx;
  await save();
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i], result = tx.files[i];
    try {
      await withLock(directory, 'document:' + project.knowledgeRoot + ':' + c.path, async () => {
        const file = await safeDocument(project.knowledgeRoot, c.path);
        const before = await document(file);
        if (before.fingerprint === result.after) {
          result.status = 'applied'; result.reused = true;
          result.reusedFrom = Object.values(state.transactions).find(t => t !== tx && t.projectId === project.projectId && t.files.some(f => f.path === c.path && f.after === result.after && f.status === 'applied'))?.transactionId;
          return;
        }
        if (before.fingerprint !== c.baseline) fail('CONFLICT', '资料已变化，保留用户版本');
        const prefix = path.join(directory, 'transactions', transactionId, digest(c.path));
        result.snapshot = prefix + '.before.txt'; result.proposed = prefix + '.after.txt'; result.existed = before.exists;
        await atomicWrite(result.snapshot, before.content);
        await atomicWrite(result.proposed, c.content);
        result.status = 'prepared';
        await save();
        if (options.checkpoint) await options.checkpoint('prepared', tx, result);
        await mkdir(path.dirname(file), { recursive: true });
        await safeDocument(project.knowledgeRoot, c.path);
        if ((await document(file)).fingerprint !== c.baseline) fail('CONFLICT', '准备后资料变化');
        await atomicWrite(file, c.content);
        if (options.checkpoint) await options.checkpoint('written', tx, result);
        result.status = 'applied';
        await save();
      });
    } catch (error) {
      if (error.code === 'STATE_WRITE_FAILED' || options.crash || error.code === 'SIMULATED_CRASH') throw error;
      result.status = error.code === 'CONFLICT' ? 'conflict' : 'pending'; result.error = error.code || 'IO';
    }
  }
  tx.status = tx.files.every(f => f.status === 'applied') ? 'applied' : tx.files.some(f => f.status === 'applied') ? 'partial' : 'pending';
  return tx;
}

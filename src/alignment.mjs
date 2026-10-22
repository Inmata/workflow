import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { canonical, digest, fail, mutate, readState, readText, samePath } from './store.mjs';
import { authorizeWrite } from './knowledge.mjs';
import { document, safeDocument, writeDocuments } from './documents.mjs';

// 对齐索引只收集路径、大小和 mtime，正文由 Lead 读取和归纳。
// 索引本身是确定性数据，不调用模型，也不写项目文件（apply 除外）。
export const ALIGNMENT_SCHEMA = 1;
export const DEFAULT_DOC = 'docs/WORKFLOW-ALIGNMENT.md';
const FALLBACK_DOC = 'WORKFLOW-ALIGNMENT.md';
const BEGIN = '<!-- workflow-alignment:begin -->';
const END = '<!-- workflow-alignment:end -->';
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.adoc']);
const TOOL_FILES = new Set(['package.json', 'Makefile', 'makefile', 'pyproject.toml', 'Cargo.toml', 'go.mod']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', 'build', 'work', 'releases', 'release-staging', 'backups', 'vendor', '.vs', '.idea', 'coverage', 'target', 'tmp', '.workflow']);
const DECISION_STATUS = new Set(['pending', 'accepted-project', 'accepted-workflow', 'accepted-change', 'rejected']);
const MAX_FILES = 300;
const MAX_DEPTH = 4;
const CHECK_BUDGET_MS = 150;
const CHECK_MAX_FILES = 300;
const CHECK_MAX_CHANGES = 20;

export function classify(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const base = path.basename(normalized);
  if (/^RELEASE[-.]/i.test(base)) return 'release';
  if (/(^|\/)(superpowers|archive)\//i.test(normalized)) return 'archive';
  if (/(^|\/)plans?\//i.test(normalized)) return 'plan';
  if (/^(AGENTS|CLAUDE)\.md$/i.test(base)) return 'constraint';
  if (/^(README|PRODUCT|ARCHITECTURE|CONVENTIONS|DESIGN)/i.test(base)) return 'product';
  if (/^(USAGE|CONTRIBUTING)/i.test(base)) return 'usage';
  if (/\.(ps1|sh)$/i.test(base)) return 'script';
  if (TOOL_FILES.has(base)) return 'toolchain';
  return 'other';
}

function candidate(name) {
  return DOC_EXTENSIONS.has(path.extname(name).toLowerCase()) || TOOL_FILES.has(name) || /\.(ps1|sh)$/i.test(name);
}

function projectIn(state, root) {
  return Object.values(state.projects).find(project => project.enabled && samePath(project.root, root));
}

async function walk(root, relative, depth, output) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  output.directories.push({ path: relative || '.', mtimeMs: (await lstat(path.join(root, relative || '.'))).mtimeMs });
  for (const entry of entries) {
    const item = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || depth >= MAX_DEPTH) continue;
      await walk(root, item, depth + 1, output);
      continue;
    }
    if (!entry.isFile() || !candidate(entry.name)) continue;
    if (output.files.length >= output.limit) { output.truncated = true; continue; }
    const info = await lstat(path.join(root, item));
    if (info.isSymbolicLink()) { output.skipped.push({ path: item, reason: 'symlink' }); continue; }
    if (info.nlink > 1) { output.skipped.push({ path: item, reason: 'hardlink' }); continue; }
    output.files.push({ path: item, size: info.size, mtimeMs: info.mtimeMs, kind: classify(item) });
  }
}

function documentName(project) {
  return project.alignment?.docPath || DEFAULT_DOC;
}

// 首次写入前补一次只读扫描；否则索引为空，之后的变更检测永远返回 stale:false。
async function ensureIndexed(directory, target) {
  const state = await readState(directory);
  const project = projectIn(state, target);
  if (!project) fail('PROJECT', '项目未启用；先执行 project enable');
  if (!project.alignment?.files?.length) await scanAlignment(directory, target);
}

async function resolveDocument(project, requested) {
  const relative = requested || documentName(project);
  if (relative !== documentName(project) && relative !== DEFAULT_DOC && relative !== FALLBACK_DOC) fail('PATH', '只能写入已登记的对齐文档');
  return relative;
}

export async function scanAlignment(directory, root, options = {}) {
  const target = await canonical(root);
  const maxFiles = options.maxFiles === undefined ? MAX_FILES : Number(options.maxFiles);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES) fail('INPUT', `--max-files 必须是 1 到 ${MAX_FILES} 之间的整数`);
  const state = await readState(directory);
  const project = projectIn(state, target);
  if (!project) fail('PROJECT', '项目未启用；先执行 project enable');
  const docs = await lstat(path.join(target, 'docs')).catch(() => null);
  const docPath = project.alignment?.docPath || (docs?.isDirectory() ? DEFAULT_DOC : FALLBACK_DOC);
  const output = { files: [], directories: [], skipped: [], limit: maxFiles, truncated: false };
  await walk(target, '', 0, output);
  const files = output.files.filter(file => file.path !== docPath);
  const alignment = {
    schemaVersion: ALIGNMENT_SCHEMA,
    docPath,
    docFingerprint: project.alignment?.docFingerprint ?? null,
    generatedAt: new Date().toISOString(),
    files,
    directories: output.directories,
    skipped: output.skipped,
    decisions: project.alignment?.decisions || [],
    findings: project.alignment?.findings || [],
  };
  await mutate(directory, async (current, save) => {
    const currentProject = projectIn(current, target);
    if (!currentProject) fail('PROJECT', '项目未启用；先执行 project enable');
    if (currentProject.alignment) alignment.decisions = currentProject.alignment.decisions || [];
    if (currentProject.alignment) alignment.findings = currentProject.alignment.findings || [];
    if (currentProject.alignment) alignment.docFingerprint = currentProject.alignment.docFingerprint ?? null;
    currentProject.alignment = alignment;
    await save();
  });
  return { status: 'scanned', projectId: project.projectId, docPath, files, skipped: output.skipped, truncated: output.truncated };
}

// 文档是权威：Lead 可能直接写表格而不经过 decide/suggest，待办数量以文档为准并与 state 合并。
function pendingRows(text, heading) {
  const ids = new Set();
  if (!text) return ids;
  const start = text.indexOf(heading);
  if (start < 0) return ids;
  const next = text.indexOf('\n## ', start + heading.length);
  const body = text.slice(start, next < 0 ? text.length : next);
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(cell => cell.trim());
    if (cells.length < 4) continue;
    const id = cells[1];
    if (!id || id === 'ID' || /^-+$/.test(id)) continue;
    if (cells[cells.length - 2] !== 'pending') continue;
    ids.add(id);
  }
  return ids;
}

async function inspect(project, options = {}) {
  const alignment = project.alignment;
  if (!alignment) return { path: DEFAULT_DOC, exists: false, stale: false, changed: [], missing: [], directoryChanged: [], pendingDecisions: 0, pendingFindings: 0 };
  const budget = Number(options.budgetMs) || CHECK_BUDGET_MS;
  const deadline = Date.now() + budget;
  const changed = [];
  const missing = [];
  const directoryChanged = [];
  let checked = 0;
  for (const file of alignment.files || []) {
    if (checked >= CHECK_MAX_FILES || Date.now() > deadline) break;
    checked++;
    const info = await lstat(path.join(project.root, file.path)).catch(() => null);
    if (!info) { missing.push({ path: file.path, reason: 'deleted' }); continue; }
    if (info.isSymbolicLink()) changed.push({ path: file.path, reason: 'link' });
    else if (info.size !== file.size) changed.push({ path: file.path, reason: 'size' });
    else if (Math.abs(info.mtimeMs - file.mtimeMs) > 1) changed.push({ path: file.path, reason: 'mtime' });
  }
  for (const item of alignment.directories || []) {
    const info = await lstat(path.join(project.root, item.path)).catch(() => null);
    if (!info) { directoryChanged.push(item.path); continue; }
    if (Math.abs(info.mtimeMs - item.mtimeMs) > 1) directoryChanged.push(item.path);
  }
  const doc = await readText(path.join(project.root, alignment.docPath));
  const decisions = new Set((alignment.decisions || []).filter(item => item.status === 'pending').map(item => item.id));
  for (const item of pendingRows(doc, '## 待裁决差异')) decisions.add(item);
  const findings = new Set((alignment.findings || []).filter(item => item.status === 'pending').map(item => item.id));
  for (const item of pendingRows(doc, '## 结构建议')) findings.add(item);
  return {
    path: alignment.docPath,
    exists: true,
    docExists: doc !== null,
    incomplete: checked < (alignment.files || []).length,
    stale: checked < (alignment.files || []).length || changed.length > 0 || missing.length > 0 || directoryChanged.length > 0,
    changed: changed.slice(0, CHECK_MAX_CHANGES),
    missing: missing.slice(0, CHECK_MAX_CHANGES),
    directoryChanged: directoryChanged.slice(0, CHECK_MAX_CHANGES),
    pendingDecisions: decisions.size,
    pendingFindings: findings.size,
  };
}

export async function inspectAlignment(project) {
  return inspect(project);
}

export async function alignmentStatus(directory, root, options = {}) {
  const target = await canonical(root);
  const state = await readState(directory);
  const project = projectIn(state, target);
  if (!project) fail('PROJECT', '项目未启用；先执行 project enable');
  return inspect(project, options);
}

function lineKey(line) {
  if (line.startsWith('|')) return line.split('|')[1]?.trim() || line;
  return line.split(/\s+/)[0];
}

function replaceSection(text, heading, line) {
  const start = text.indexOf(heading);
  if (start < 0) return `${text}${text.endsWith('\n') ? '' : '\n'}\n${heading}\n\n${line}\n`;
  const bodyStart = start + heading.length;
  const next = text.indexOf('\n## ', bodyStart);
  const end = next < 0 ? text.length : next;
  const body = text.slice(bodyStart, end).split('\n');
  const key = lineKey(line);
  const index = body.findIndex(item => item.trim() && lineKey(item) === key);
  if (index >= 0) body[index] = line;
  else {
    let insert = body.length;
    while (insert > 0 && body[insert - 1].trim() === '') insert--;
    body.splice(insert, 0, line);
  }
  return text.slice(0, bodyStart) + body.join('\n') + text.slice(end);
}

// 写入对齐文档会改变其父目录的 mtime；刷新记录，避免下次检查把自己判成过期。
async function refreshDirectory(alignment, target, relative) {
  const parent = path.posix.dirname(relative.replaceAll('\\', '/'));
  const info = await lstat(path.join(target, parent)).catch(() => null);
  if (!info) return;
  const entry = (alignment.directories || []).find(item => item.path === parent);
  if (entry) entry.mtimeMs = info.mtimeMs;
  else alignment.directories = [...(alignment.directories || []), { path: parent, mtimeMs: info.mtimeMs }];
}


function resolvePending(text, item) {
  return text.split('\n').map(line => {
    if (!line.startsWith('|') || lineKey(line) !== item.id) return line;
    const cells = line.split('|');
    if (cells[cells.length - 2]?.trim() === 'pending') cells[cells.length - 2] = ' ' + item.status + ' ';
    return cells.join('|');
  }).join('\n');
}
async function updateAlignment(directory, root, input, action) {
  const target = await canonical(root);
  // 权限在索引和正文写入之前核对。
  const initial = await readState(directory);
  const auth = authorizeWrite(initial, input);
  if (!samePath(auth.project.knowledgeRoot, target)) fail('IDENTITY', '对齐目标与身份不一致');
  await ensureIndexed(directory, target);
  return mutate(directory, async (state, save) => {
    const { project, session, task } = authorizeWrite(state, input);
    const relative = await resolveDocument(project, input.docPath);
    if (!task.permissions.allowedPaths.includes(relative)) fail('PERMISSION', '对齐文件不在任务范围');
    const original = await document(await safeDocument(target, relative));
    if (!Object.hasOwn(input, 'baseline') || input.baseline !== original.fingerprint) fail('CONFLICT', '需要最新对齐文档指纹');
    let output = original.content;
    const decisions = input.decisions || [], findings = input.findings || [];
    if (!Array.isArray(decisions) || !Array.isArray(findings)) fail('INPUT', '需要数组');
    if (action === 'apply') {
      if (typeof input.content !== 'string' || !input.content.trim()) fail('INPUT', '需要 content');
      const block = BEGIN + '\n' + input.content.trimEnd() + '\n' + END;
      const a = output.indexOf(BEGIN), b = output.indexOf(END);
      if ((a >= 0) !== (b >= 0) || (a >= 0 && b < a)) fail('CONFLICT', '对齐管理区不完整');
      output = a >= 0 ? output.slice(0, a) + block + output.slice(b + END.length) : output + (output && !output.endsWith('\n') ? '\n' : '') + block + '\n';
    }
    if (action === 'decide' && !decisions.length) fail('INPUT', '需要 decisions');
    if (action === 'suggest' && !findings.length) fail('INPUT', '需要 findings');
    for (const item of decisions) {
      if (!item?.id || !DECISION_STATUS.has(item.status)) fail('INPUT', '裁决状态无效');
      output = resolvePending(output, item);
      output = replaceSection(output, '## 已裁决记录', item.id + ' ' + item.status + '：' + (item.reason || '未填写理由'));
    }
    for (const item of findings) {
      if (!item?.id || !item.problem) fail('INPUT', '建议需要 id 和 problem');
      output = replaceSection(output, '## 结构建议', '| ' + [item.id, item.problem, item.location || '未定位', item.recommendation || '未给出', 'pending'].join(' | ') + ' |');
    }
    const tx = await writeDocuments(directory, state, save, project, [{ path: relative, baseline: input.baseline, content: output, reason: '项目对齐 ' + action, responsibility: 'Lead', evidence: input.evidence || ['task:' + task.taskId] }], { taskId: task.taskId, sessionId: session.sessionId });
    session.revision++;
    if (tx.status !== 'applied') return { status: tx.status, transactionId: tx.transactionId, files: tx.files };
    const alignment = project.alignment;
    alignment.docPath = relative; alignment.docFingerprint = digest(output);
    const dm = new Map((alignment.decisions || []).map(i => [i.id, i]));
    for (const i of decisions) dm.set(i.id, { id: i.id, status: i.status, decidedAt: new Date().toISOString() });
    alignment.decisions = [...dm.values()];
    const fm = new Map((alignment.findings || []).map(i => [i.id, i]));
    for (const i of findings) fm.set(i.id, { id: i.id, status: 'pending' });
    for (const i of decisions) if (fm.has(i.id)) fm.set(i.id, { id: i.id, status: i.status });
    alignment.findings = [...fm.values()];
    await refreshDirectory(alignment, target, relative);
    return { status: action === 'apply' ? 'applied' : 'recorded', transactionId: tx.transactionId, docPath: relative, revision: session.revision };
  });
}
export const applyAlignment = (directory, root, input = {}) => updateAlignment(directory, root, input, 'apply');
export const decideAlignment = (directory, root, input = {}) => updateAlignment(directory, root, input, 'decide');
export const suggestAlignment = (directory, root, input = {}) => updateAlignment(directory, root, input, 'suggest');

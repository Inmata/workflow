import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { canonical, digest, fail, mutate, readState, readText, samePath } from './store.mjs';
import { authorizeWrite, reconcileTransactions } from './knowledge.mjs';
import { pendingFor } from './protocol.mjs';
import { document, safeDocument, writeDocuments } from './documents.mjs';
import { command } from './entry.mjs';

// 对齐索引只收集路径、大小和 mtime，正文由 Lead 读取和归纳。
// 索引本身是确定性数据，不调用模型，也不写项目文件（apply 除外）。
export const ALIGNMENT_SCHEMA = 1;
export const DEFAULT_DOC = 'docs/WORKFLOW-ALIGNMENT.md';
const FALLBACK_DOC = 'WORKFLOW-ALIGNMENT.md';
const BEGIN = '<!-- workflow-alignment:begin -->';
const END = '<!-- workflow-alignment:end -->';
// Lead 生成空小节时常写的占位行；写入首条记录时移除。
const PLACEHOLDER = /^\s*[-*]\s*(暂无|无|none|n\/a)\s*[。.]?\s*$/i;
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.adoc']);
const TOOL_FILES = new Set(['package.json', 'Makefile', 'makefile', 'pyproject.toml', 'Cargo.toml', 'go.mod']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', 'build', 'work', 'releases', 'release-staging', 'backups', 'vendor', '.vs', '.idea', 'coverage', 'target', 'tmp', '.workflow']);
const DECISION_STATUS = new Set(['pending', 'accepted-project', 'accepted-workflow', 'accepted-change', 'rejected']);
// 结构建议只有采纳改动、拒绝或暂缓三种结论；accepted-project/accepted-workflow 只用于差异。
const FINDING_STATUS = new Set(['pending', 'accepted-change', 'rejected']);
const DECISION_HEADING = '## 待裁决差异';
const FINDING_HEADING = '## 结构建议';
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
    // 发现未收录资料时，已收录文件不占名额，避免排序靠前的已确认来源掩盖后面的未确认资料。
    if (output.ignore?.has(item)) continue;
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
// 已扫描过的空索引不重扫：否则删光来源后新增的资料会被自动并进基线，绕过显式确认。
async function ensureIndexed(directory, target) {
  const state = await readState(directory);
  const project = projectIn(state, target);
  if (!project) fail('PROJECT', '项目未启用；先执行 project enable');
  const alignment = project.alignment;
  if (alignment?.files?.length) return;
  // generatedAt 只由 scanAlignment 写入；旧索引缺该字段时沿用原有行为（空索引补扫）。
  if (alignment?.generatedAt !== undefined) return;
  await scanAlignment(directory, target);
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

function managedRange(text) {
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || text.indexOf(BEGIN, start + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0) fail('CONFLICT', '对齐管理区不完整或重复');
  return [start + BEGIN.length, end];
}
// 只定位管理区内的完整二级标题；标记外的同名标题和表格属于用户正文。
function sectionRange(text, heading) {
  const managed = managedRange(text);
  if (!managed) return null;
  const content = text.slice(...managed);
  const match = [...content.matchAll(/^## [^\r\n]*/gm)].find(item => item[0] === heading);
  if (!match) return null;
  const bodyStart = managed[0] + match.index + heading.length;
  const next = text.indexOf('\n## ', bodyStart);
  const end = text[managed[1] - 1] === '\n' ? managed[1] - 1 : managed[1];
  return [bodyStart, next >= 0 && next < end ? next : end];
}
const rowId = cells => { const id = cells[1]; return id && id !== 'ID' && !/^:?-+:?$/.test(id) ? id : null; };
// 表格行 ID → 状态列（倒数第二个分隔单元）。待办数量以文档为准并与 state 合并；状态不一致单独报告。
function rowStatuses(text, heading) {
  const rows = new Map();
  const range = text && sectionRange(text, heading);
  if (!range) return rows;
  for (const line of text.slice(...range).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(cell => cell.trim());
    if (cells.length < 4 || !rowId(cells)) continue;
    rows.set(rowId(cells), cells[cells.length - 2]);
  }
  return rows;
}
// 表格状态与 decide 登记的状态不一致：多半是手改了表格，或写了协议外的状态值。
function mismatches(rows, recorded, allowed) {
  const output = [];
  for (const [id, status] of rows) {
    const index = recorded.get(id)?.status || '未登记';
    if (status === index || (status === 'pending' && index === '未登记')) continue;
    output.push({ id, document: status, index, ...(allowed.has(status) ? {} : { invalid: true }) });
  }
  return output;
}
// 目录 mtime 只说明有增删或改名；重新列目录，只有出现未收录的候选资料才算过期。
// 读取失败单独返回错误码：不能当成“没有新资料”，也不能中断其余目录的检查。
async function addedEntries(root, item, known, docPath) {
  const relative = item.path === '.' ? '' : item.path;
  const depth = relative ? relative.split('/').length : 0;
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { found: false, error: null };
    return { found: false, error: error.code || 'IO' };
  }
  let failure = null;
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isFile() && candidate(entry.name) && child !== docPath && !known.files.has(child)) return { found: true, error: failure };
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH && !known.directories.has(child)) {
      const ignore = new Set(known.files);
      if (docPath) ignore.add(docPath);
      const output = { files: [], directories: [], skipped: [], limit: 2, truncated: false, ignore };
      try { await walk(root, child, depth + 1, output); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        failure ||= error.code || 'IO';
        continue;
      }
      if (output.files.length > 0) return { found: true, error: failure };
    }
  }
  return { found: false, error: failure };
}

async function inspect(project, options = {}) {
  const alignment = project.alignment;
  if (!alignment) return { path: DEFAULT_DOC, exists: false, stale: false, changed: [], missing: [], directoryChanged: [], pendingDecisions: 0, pendingFindings: 0 };
  const budget = Number(options.budgetMs) || CHECK_BUDGET_MS;
  const deadline = Date.now() + budget;
  const changed = [];
  const missing = [];
  const directoryChanged = [];
  const errors = [];
  let checked = 0;
  for (const file of alignment.files || []) {
    if (checked >= CHECK_MAX_FILES || Date.now() > deadline) break;
    checked++;
    // 只有 ENOENT 才是“已删除”；权限、占用等读取失败进入 errors，不能冒充删除。
    const info = await lstat(path.join(project.root, file.path)).catch(error => {
      if (error.code === 'ENOENT') return null;
      errors.push({ path: file.path, code: error.code || 'IO', reason: 'unreadable' });
      return undefined;
    });
    if (info === undefined) continue;
    if (!info) { missing.push({ path: file.path, reason: 'deleted' }); continue; }
    if (info.isSymbolicLink()) changed.push({ path: file.path, reason: 'link', size: info.size, mtimeMs: info.mtimeMs });
    else if (info.size !== file.size) changed.push({ path: file.path, reason: 'size', size: info.size, mtimeMs: info.mtimeMs });
    else if (Math.abs(info.mtimeMs - file.mtimeMs) > 1) changed.push({ path: file.path, reason: 'mtime', size: info.size, mtimeMs: info.mtimeMs });
  }
  const known = { files: new Set((alignment.files || []).map(file => file.path)), directories: new Set((alignment.directories || []).map(item => item.path)) };
  let checkedDirectories = 0;
  for (const item of alignment.directories || []) {
    if (Date.now() > deadline) break;
    checkedDirectories++;
    const info = await lstat(path.join(project.root, item.path)).catch(error => {
      if (error.code === 'ENOENT') return null;
      errors.push({ path: item.path, code: error.code || 'IO', reason: 'unreadable-directory' });
      return undefined;
    });
    if (info === undefined) continue;
    // 目录整体消失时，其中文件已计入 missing；这里只记录出现新资料的目录。
    if (!info || Math.abs(info.mtimeMs - item.mtimeMs) <= 1) continue;
    const added = await addedEntries(project.root, item, known, alignment.docPath);
    if (added.error) errors.push({ path: item.path, code: added.error, reason: 'unreadable-directory' });
    if (added.found) directoryChanged.push(item.path);
  }
  const doc = await readText(path.join(project.root, alignment.docPath));
  const decisionRows = rowStatuses(doc, DECISION_HEADING), findingRows = rowStatuses(doc, FINDING_HEADING);
  const recordedDecisions = new Map((alignment.decisions || []).map(item => [item.id, item]));
  const recordedFindings = new Map((alignment.findings || []).map(item => [item.id, item]));
  const decisions = new Set((alignment.decisions || []).filter(item => item.status === 'pending').map(item => item.id));
  for (const [id, status] of decisionRows) if (status === 'pending') decisions.add(id);
  const findings = new Set((alignment.findings || []).filter(item => item.status === 'pending').map(item => item.id));
  for (const [id, status] of findingRows) if (status === 'pending') findings.add(id);
  const mismatch = [...mismatches(decisionRows, recordedDecisions, DECISION_STATUS), ...mismatches(findingRows, recordedFindings, FINDING_STATUS)];
  const incomplete = checked < (alignment.files || []).length || checkedDirectories < (alignment.directories || []).length || errors.length > 0;
  return {
    path: alignment.docPath,
    exists: true,
    docExists: doc !== null,
    // 读取失败与检查上限一样，都表示没有完成完整核对；可读部分仍按上面的结果报告。
    incomplete,
    stale: incomplete || changed.length > 0 || missing.length > 0 || directoryChanged.length > 0,
    changed: changed.slice(0, CHECK_MAX_CHANGES),
    missing: missing.slice(0, CHECK_MAX_CHANGES),
    directoryChanged: directoryChanged.slice(0, CHECK_MAX_CHANGES),
    errors: errors.slice(0, CHECK_MAX_CHANGES),
    pendingDecisions: decisions.size,
    pendingFindings: findings.size,
    mismatch: mismatch.slice(0, CHECK_MAX_CHANGES),
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
  const range = sectionRange(text, heading);
  if (!range) {
    const end = managedRange(text)[1];
    const prefix = text.slice(0, end);
    return `${prefix}${prefix.endsWith('\n') ? '' : '\n'}\n${heading}\n\n${line}\n${text.slice(end)}`;
  }
  const [bodyStart, end] = range;
  let body = text.slice(bodyStart, end).split('\n');
  const key = lineKey(line);
  const index = body.findIndex(item => item.trim() && lineKey(item) === key);
  if (index >= 0) body[index] = line;
  else {
    body = body.filter(item => !PLACEHOLDER.test(item));
    let insert = body.length;
    while (insert > 0 && body[insert - 1].trim() === '') insert--;
    // 空小节：body[0] 是标题行剩余部分，记录放在标题后空一行。
    if (insert === 0) { while (body.length < 2) body.push(''); insert = 2; }
    body.splice(insert, 0, line);
  }
  return text.slice(0, bodyStart) + body.join('\n') + text.slice(end);
}

// 写入对齐文档会改变其父目录的 mtime；目录里仍有未收录资料时不能刷新，否则会掩盖新增来源。
// 返回该目录是否已可安全登记：false 表示其中（含未登记子目录）仍有未收录资料。
async function refreshDirectoryAt(alignment, target, parent) {
  const info = await lstat(path.join(target, parent)).catch(() => null);
  if (!info || !info.isDirectory()) return false;
  const known = {
    files: new Set((alignment.files || []).map(file => file.path)),
    directories: new Set((alignment.directories || []).map(item => item.path)),
  };
  const added = await addedEntries(target, { path: parent }, known, alignment.docPath);
  // 读取失败时不能刷新目录基线，否则会把看不到的新资料永久算作已确认。
  if (added.error || added.found) return false;
  const entry = (alignment.directories || []).find(item => item.path === parent);
  if (entry) entry.mtimeMs = info.mtimeMs;
  else alignment.directories = [...(alignment.directories || []), { path: parent, mtimeMs: info.mtimeMs }];
  return true;
}
// 新目录和它的祖先都只在没有未收录资料时登记；遇到未收录资料立即停止，
// 让上级目录 mtime 保持陈旧，下次检查仍能通过父目录搜索发现它。
async function refreshDirectoryChain(alignment, target, directory) {
  let current = directory;
  for (;;) {
    if (!await refreshDirectoryAt(alignment, target, current)) return;
    if (current === '.') return;
    current = path.posix.dirname(current);
  }
}
async function refreshDirectory(alignment, target, relative) {
  await refreshDirectoryAt(alignment, target, path.posix.dirname(relative.replaceAll('\\', '/')));
}

// 来源确认只接受项目内、scan 会收录的普通资料；路径本身不能逃出项目。
function sourceInputs(input) {
  if (!Object.hasOwn(input, 'sources')) return null;
  if (!Array.isArray(input.sources)) fail('INPUT', 'sources 需要数组');
  const seen = new Set();
  return input.sources.map(item => {
    const raw = typeof item === 'string' ? { path: item } : item;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INPUT', 'sources 的每项需要路径或对象');
    const relative = raw.path;
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':')) fail('PATH', '来源需要项目内规范相对路径');
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) fail('PATH', '来源需要项目内规范相对路径');
    if (parts.slice(0, -1).some(part => SKIP_DIRS.has(part))) fail('PATH', '来源目录不在对齐扫描范围');
    if (!candidate(parts[parts.length - 1])) fail('INPUT', '来源不是对齐扫描收录的资料类型');
    if (seen.has(relative)) fail('INPUT', `来源重复：${relative}`);
    seen.add(relative);
    const hasSize = raw.size !== undefined, hasMtime = raw.mtimeMs !== undefined;
    if (hasSize !== hasMtime) fail('INPUT', '来源快照需要同时提供 size 与 mtimeMs');
    if (hasSize && (!Number.isSafeInteger(raw.size) || raw.size < 0)) fail('INPUT', '来源 size 不是有效整数');
    if (hasMtime && (typeof raw.mtimeMs !== 'number' || !Number.isFinite(raw.mtimeMs) || raw.mtimeMs < 0)) fail('INPUT', '来源 mtimeMs 不是有效数值');
    if (raw.deleted !== undefined && typeof raw.deleted !== 'boolean') fail('INPUT', 'deleted 需要布尔值');
    if (raw.deleted && hasSize) fail('INPUT', '删除来源不能同时提供快照');
    return { path: relative, ...(hasSize ? { size: raw.size, mtimeMs: raw.mtimeMs } : {}), ...(raw.deleted ? { deleted: true } : {}) };
  });
}

// 带快照时在提交前复核：读取后又被改动、消失或变成链接的来源保留原基线。
async function confirmSource(target, source) {
  const info = await lstat(path.join(target, source.path)).catch(() => null);
  if (source.deleted) return info ? { reason: 'exists' } : { deleted: true };
  if (!info) return { reason: 'deleted' };
  if (info.isSymbolicLink()) return { reason: 'link' };
  if (!info.isFile()) return { reason: 'not-file' };
  if (info.nlink > 1) return { reason: 'hardlink' };
  if (source.size !== undefined) {
    if (info.size !== source.size) return { reason: 'size' };
    if (Math.abs(info.mtimeMs - source.mtimeMs) > 1) return { reason: 'mtime' };
  }
  return { size: info.size, mtimeMs: info.mtimeMs };
}

// 只刷新本次实际确认的来源；新增和删除都要求显式列出，未列出的变化保持 stale。
async function confirmSources(alignment, target, sources) {
  const files = new Map((alignment.files || []).map(file => [file.path, file]));
  const confirmed = [], unconfirmed = [], affected = new Set();
  for (const source of sources) {
    const result = await confirmSource(target, source);
    if (result.reason) { unconfirmed.push({ path: source.path, reason: result.reason }); continue; }
    // inspect 每次最多检查 CHECK_MAX_FILES 项；新增来源越过上限会让索引永远 incomplete，
    // 且越界项不再被检查，因此不登记，交由全量 scan 或缩小来源范围处理。
    if (!result.deleted && !files.has(source.path) && files.size >= CHECK_MAX_FILES) {
      unconfirmed.push({ path: source.path, reason: 'limit' });
      continue;
    }
    if (result.deleted) files.delete(source.path);
    else {
      const previous = files.get(source.path);
      files.set(source.path, { path: source.path, size: result.size, mtimeMs: result.mtimeMs, kind: previous?.kind || classify(source.path) });
    }
    confirmed.push(source.path);
    affected.add(path.posix.dirname(source.path));
  }
  alignment.files = [...files.values()];
  // 新目录和祖先只在其中所有候选资料都已收录时才登记当前 mtime；
  // 否则不登记，父目录的搜索下次仍能发现未确认来源。
  for (const directory of affected) await refreshDirectoryChain(alignment, target, directory);
  return { confirmed, unconfirmed };
}


// 只改差异与建议两个小节里该 ID 的状态列；手改过或写错的状态也一并纠正为登记值。
function resolvePending(text, item) {
  for (const heading of [DECISION_HEADING, FINDING_HEADING]) {
    const range = sectionRange(text, heading);
    if (!range) continue;
    const body = text.slice(...range).split('\n').map(line => {
      if (!line.startsWith('|') || lineKey(line) !== item.id) return line;
      const cells = line.split('|');
      if (cells.length < 4) return line;
      cells[cells.length - 2] = ' ' + item.status + ' ';
      return cells.join('|');
    }).join('\n');
    text = text.slice(0, range[0]) + body + text.slice(range[1]);
  }
  return text;
}
// apply 写进表格但从未登记的行：pending 自动登记，等同于 suggest；已写成裁决状态的必须经 decide 留痕。
function unregisteredRows(output, alignment, inputDecisions) {
  const recorded = new Set([...(alignment?.decisions || []), ...(alignment?.findings || []), ...inputDecisions].map(item => item?.id));
  const rows = { decisions: [], findings: [], decided: [] };
  for (const [heading, kind] of [[DECISION_HEADING, 'decisions'], [FINDING_HEADING, 'findings']]) {
    for (const [id, status] of rowStatuses(output, heading)) {
      if (recorded.has(id)) continue;
      if (status === 'pending') rows[kind].push(id);
      else rows.decided.push({ id, status });
    }
  }
  return rows;
}
async function updateAlignment(directory, root, input, action) {
  const target = await canonical(root);
  const sources = sourceInputs(input);
  // 权限在索引和正文写入之前核对。
  const initial = await readState(directory);
  const auth = authorizeWrite(initial, input);
  if (!samePath(auth.project.knowledgeRoot, target)) fail('IDENTITY', '对齐目标与身份不一致');
  await ensureIndexed(directory, target);
  return mutate(directory, async (state, save) => {
    const { project, session, task } = authorizeWrite(state, input);
    const relative = await resolveDocument(project, input.docPath);
    if (!task.permissions.allowedPaths.includes(relative)) fail('PERMISSION', '对齐文件不在任务范围');
    if (sources?.some(source => source.path === relative)) fail('INPUT', '对齐文档自身不进入来源索引');
    const original = await document(await safeDocument(target, relative));
    if (!Object.hasOwn(input, 'baseline') || input.baseline !== original.fingerprint) fail('CONFLICT', '需要最新对齐文档指纹');
    let output = original.content;
    const decisions = input.decisions || [], findings = input.findings || [];
    if (!Array.isArray(decisions) || !Array.isArray(findings)) fail('INPUT', '需要数组');
    if (action === 'apply') {
      if (typeof input.content !== 'string' || !input.content.trim()) fail('INPUT', '需要 content');
      const block = BEGIN + '\n' + input.content.trimEnd() + '\n' + END;
      const range = managedRange(output);
      output = range ? output.slice(0, range[0] - BEGIN.length) + block + output.slice(range[1] + END.length) : output + (output && !output.endsWith('\n') ? '\n' : '') + block + '\n';
    } else if (!managedRange(output)) {
      output += (output && !output.endsWith('\n') ? '\n' : '') + BEGIN + '\n' + END + '\n';
    }
    const added = action === 'apply' ? unregisteredRows(output, project.alignment, decisions) : { decisions: [], findings: [], decided: [] };
    if (added.decided.length) {
      const list = added.decided.map(item => `${item.id}（表格写的是 ${item.status}）`).join('、');
      const example = JSON.stringify({ decisions: added.decided.map(item => ({ id: item.id, status: 'pending' })) });
      fail('INPUT', `表格里有未登记却已写了裁决状态的行：${list}。裁决必须经 decide 留痕：把这些行的状态改回 pending 后重发 apply（会自动登记为待裁决），用户裁决后再执行 ${command(['project', 'align', 'decide', '--root', target, '--input', '<JSON文件>'])}，JSON 形如 ${example}，status 填用户的裁决。`);
    }
    if (action === 'decide' && !decisions.length) fail('INPUT', '需要 decisions');
    if (action === 'suggest' && !findings.length) fail('INPUT', '需要 findings');
    const findingIds = new Set([...(project.alignment?.findings || []).map(i => i.id), ...rowStatuses(output, FINDING_HEADING).keys()]);
    for (const item of decisions) {
      if (!item?.id) fail('INPUT', '裁决需要 id');
      const finding = findingIds.has(item.id);
      const allowed = finding ? FINDING_STATUS : DECISION_STATUS;
      if (!allowed.has(item.status)) fail('INPUT', `${item.id} 的裁决状态 ${JSON.stringify(item.status)} 无效：${finding ? '结构建议' : '差异'}只能用 ${[...allowed].join('、')}`);
      output = resolvePending(output, item);
      output = replaceSection(output, '## 已裁决记录', item.id + ' ' + item.status + '：' + (item.reason || '未填写理由'));
    }
    for (const item of findings) {
      if (!item?.id || !item.problem) fail('INPUT', '建议需要 id 和 problem');
      output = replaceSection(output, '## 结构建议', '| ' + [item.id, item.problem, item.location || '未定位', item.recommendation || '未给出', 'pending'].join(' | ') + ' |');
    }
    const tx = await writeDocuments(directory, state, save, project, [{ path: relative, baseline: input.baseline, content: output, reason: '项目对齐 ' + action, responsibility: 'Lead', evidence: input.evidence || ['task:' + task.taskId] }], { taskId: task.taskId, sessionId: session.sessionId });
    // 与知识写入共用对账：成功重写后关闭同一事务的待办；未应用的事务必须留下可恢复入口。
    reconcileTransactions(state, project.projectId, task.taskId);
    session.revision++;
    session.revisionReason = '项目对齐 ' + action;
    if (tx.status !== 'applied') {
      const pending = pendingFor(state, project.projectId, task.taskId, `项目对齐写入尚未完整应用（${tx.status}）；先用 knowledge recover --transaction ${tx.transactionId} 辨认结果，再按提示重试 apply`, 'knowledge-pending', { transactionId: tx.transactionId });
      return { status: tx.status, transactionId: tx.transactionId, files: tx.files, pendingId: pending.pendingId };
    }
    const alignment = project.alignment;
    alignment.docPath = relative; alignment.docFingerprint = digest(output);
    const dm = new Map((alignment.decisions || []).map(i => [i.id, i]));
    for (const i of decisions) dm.set(i.id, { id: i.id, status: i.status, decidedAt: new Date().toISOString() });
    for (const id of added.decisions) dm.set(id, { id, status: 'pending' });
    alignment.decisions = [...dm.values()];
    const fm = new Map((alignment.findings || []).map(i => [i.id, i]));
    for (const i of findings) fm.set(i.id, { id: i.id, status: 'pending' });
    for (const id of added.findings) fm.set(id, { id, status: 'pending' });
    for (const i of decisions) if (fm.has(i.id)) fm.set(i.id, { id: i.id, status: i.status });
    alignment.findings = [...fm.values()];
    const confirmed = sources ? await confirmSources(alignment, target, sources) : null;
    await refreshDirectory(alignment, target, relative);
    const registered = [...added.decisions, ...added.findings];
    return { status: action === 'apply' ? 'applied' : 'recorded', transactionId: tx.transactionId, docPath: relative, revision: session.revision, ...(registered.length ? { registered } : {}), ...(confirmed || {}) };
  });
}
export const applyAlignment = (directory, root, input = {}) => updateAlignment(directory, root, input, 'apply');
export const decideAlignment = (directory, root, input = {}) => updateAlignment(directory, root, input, 'decide');
export const suggestAlignment = (directory, root, input = {}) => updateAlignment(directory, root, input, 'suggest');

import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// spec 漂移检查：`.spec/<id>/spec.md` 的 frontmatter `code:` 列出被管辖文件，改了文件而 spec 没跟着更新即漂移。
// 格式与放行规则沿用 SpexCode（Spec-OK trailer），检测自己实现；每次从 git 历史现算，不保存哈希。
const GIT_TIMEOUT = 10000;
const MAX_DEPTH = 8;
// 预检报告被复用的前提：目标提交与（HEAD 时）工作区检查对象仍然一致。
// 复核只重解析一次 ref 并比对文件系统快照，不重跑 status/log/rev-list；超时或读取失败按过期处理。
const VERIFY_BUDGET_MS = 1000;
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
class CheckError extends Error {
  constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail; }
}
// 不经 shell、参数逐个传入；路径按字面匹配，文件名里的 * ? 不会被当成通配。
// deadline 为整次检查的总预算（可选）：每次调用只拿剩余时间，预算耗尽就不再发起新的 Git 调用，
// 避免多个 10 秒超时累计吞掉宿主回执。单次调用仍受 GIT_TIMEOUT 限制。
function git(root, args, { input, allowFail = false, deadline = null } = {}) {
  let timeout = GIT_TIMEOUT;
  if (deadline !== null) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CheckError('git', 'spec 检查超出时间预算，未继续调用 Git');
    timeout = Math.min(GIT_TIMEOUT, remaining);
  }
  const result = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, input });
  if (result.error?.code === 'ETIMEDOUT') throw new CheckError('git', `Git 检查超时（本次上限 ${timeout}ms），未完成 spec 检查`);
  // 只去掉末尾换行：porcelain 首行的前导空格是状态位，不能 trim。
  if (result.status === 0) return result.stdout.replace(/[\r\n]+$/, '');
  if (allowFail && result.status !== null && !result.error) return null;
  // 附上 git 的第一行报错，例如沙箱用户不是仓库所有者时的 dubious ownership。
  const detail = (result.stderr || result.error?.message || '').split(/\r?\n/).find(line => line.trim())?.trim();
  throw new CheckError('git', detail);
}
function unquote(value) {
  let text = value.trim();
  if (/^(['"]).*\1$/.test(text)) return text.slice(1, -1).trim();
  text = text.replace(/\s+#.*$/, '').trim();
  return text;
}
// 只解析需要的 `code:` 列表（块列表或 [a, b] 行内列表）；其他 SpexCode 字段忽略。
export function codeList(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return [];
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return [];
  const code = [];
  let inCode = false;
  for (const line of lines.slice(1, end)) {
    const key = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (key) {
      inCode = key[1] === 'code';
      const rest = key[2].trim();
      if (inCode && rest.startsWith('[')) { code.push(...rest.replace(/^\[|\]\s*$/g, '').split(',').map(unquote)); inCode = false; }
      else if (inCode && rest && !rest.startsWith('#')) { code.push(unquote(rest)); inCode = false; }
      continue;
    }
    const item = inCode ? /^\s*-\s+(.*)$/.exec(line) : null;
    if (item) code.push(unquote(item[1]));
  }
  return [...new Set(code.map(p => p.replaceAll('\\', '/').replace(/^(\.\/)+/, '')).filter(Boolean))];
}
const validPath = p => !path.posix.isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..');
// 递归收集 .spec 下的 spec.md；id 即所在目录名。不跟随链接。
export function collectSpecs(root) {
  const base = path.join(root, '.spec');
  try { if (!lstatSync(base).isDirectory()) return null; } catch { return null; }
  const specs = [];
  const walk = (directory, relative, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const full = path.join(directory, entry.name);
      const child = `${relative}/${entry.name}`;
      const file = path.join(full, 'spec.md');
      let isFile = false;
      try { isFile = lstatSync(file).isFile(); } catch { /* 没有 spec.md 的中间目录 */ }
      if (isFile) specs.push({ id: entry.name, spec: `${child}/spec.md`, code: codeList(readFileSync(file, 'utf8')) });
      walk(full, child, depth + 1);
    }
  };
  walk(base, '.spec', 0);
  return specs;
}
// 历史版本没有 `.spec` 时返回 null（按该提交判无 spec，不混入当前磁盘定义）；
// 列出或读取失败直接抛 CheckError，不静默回退到工作区。
function commitSpecs(root, commit, deadline) {
  if (git(root, ['cat-file', '-t', `${commit}:./.spec`], { allowFail: true, deadline }) !== 'tree') return null;
  const specs = [];
  for (const record of git(root, ['ls-tree', '-r', '-z', commit, '--', '.spec'], { deadline }).split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    // 与磁盘收集一致：只看普通 spec.md，不跟随链接，嵌套深度上限相同。
    if (type !== 'blob' || mode === '120000' || !/^\.spec\/.+\/spec\.md$/.test(file)) continue;
    const parts = file.split('/');
    if (parts.length - 3 > MAX_DEPTH) continue;
    specs.push({ id: parts[parts.length - 2], spec: file, code: codeList(git(root, ['show', `${commit}:./${file}`], { deadline })) });
  }
  return specs.sort((a, b) => a.spec.localeCompare(b.spec));
}
// 没有 Git 边界的目录没有可读历史；工作树的 .git 可以是目录或文件。
function insideGitWorkTree(root) {
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    try { lstatSync(path.join(cursor, '.git')); return true; } catch { /* 继续向上找仓库边界 */ }
    if (path.dirname(cursor) === cursor) return false;
  }
}
// 受管文件快照：小文件按内容摘要，大文件退回大小与 mtime，避免预检读入超大文件。
function fileSnapshot(root, relative) {
  try {
    const full = path.join(root, relative);
    const stats = statSync(full);
    if (stats.isFile() && stats.size <= SNAPSHOT_MAX_BYTES) return { digest: createHash('sha256').update(readFileSync(full)).digest('hex') };
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch { return null; }
}
// 只记录会影响检查结果的语义：spec 位置、id 与 code 清单；正文措辞不影响漂移判断。
function specSnapshot(specs) {
  return JSON.stringify(specs.map(spec => ({ id: spec.id, spec: spec.spec, code: [...spec.code].sort() })));
}
function workspaceSnapshot(root, specs) {
  const seen = new Set();
  const files = [];
  for (const spec of specs) {
    for (const relative of [spec.spec, ...spec.code]) {
      if (seen.has(relative)) continue;
      seen.add(relative);
      files.push([relative, fileSnapshot(root, relative)]);
    }
  }
  return files;
}
// 工作树的索引在 .git 目录或 `.git` 文件指向的 gitdir 里；查不到时不伪造状态，交由调用方按过期处理。
function gitIndexPath(root) {
  if (process.env.GIT_INDEX_FILE) return path.resolve(root, process.env.GIT_INDEX_FILE);
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    const marker = path.join(cursor, '.git');
    let stats = null;
    try { stats = lstatSync(marker); } catch { /* 继续向上找工作树边界 */ }
    if (stats) {
      if (stats.isDirectory()) return path.join(marker, 'index');
      if (!stats.isFile()) return null;
      try {
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(marker, 'utf8'));
        return match ? path.join(path.resolve(cursor, match[1]), 'index') : null;
      } catch { return null; }
    }
    if (path.dirname(cursor) === cursor) return null;
  }
}
function indexSnapshot(root) {
  const file = gitIndexPath(root);
  if (!file) return null;
  try { const stats = statSync(file); return { size: stats.size, mtimeMs: stats.mtimeMs }; } catch { return null; }
}
const sameSnapshot = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// 预检报告只记录了“当时查的是什么”；复用前必须复核目标提交与工作区仍指向同一对象。
// 显式 ref 复核固定后的 OID（分支、标签等可移动 ref 也由此发现）；HEAD 另复核受管文件与索引快照。
export function verifySpecBinding(root, binding, ref = null) {
  if (!root || !binding) return false;
  const label = ref || 'HEAD';
  if (binding.label !== label) return false;
  if (binding.noSpec) {
    // 快速跳过也要复核：非 Git 且没有 .spec 的跳过只在该条件仍成立时有效，其余只要求仍没有 .spec。
    return binding.nonGitNoSpec ? !insideGitWorkTree(root) && !collectSpecs(root) : !collectSpecs(root);
  }
  let commit;
  try {
    commit = git(root, ['rev-parse', '--verify', '--quiet', `${label}^{commit}`], { deadline: Date.now() + VERIFY_BUDGET_MS });
  } catch { return false; }
  if (commit !== binding.commit) return false;
  // 显式提交的检查对象不可变；ref 标签已在上面复核到同一 OID。
  if (label !== 'HEAD') return true;
  const specs = collectSpecs(root);
  if (!specs || specSnapshot(specs) !== binding.specs) return false;
  for (const [relative, snapshot] of binding.files) if (!sameSnapshot(fileSnapshot(root, relative), snapshot)) return false;
  return sameSnapshot(indexSnapshot(root), binding.index);
}
// 检查版本缺省为 HEAD；只有检查 HEAD 时才看当前 worktree 的文件与未提交改动。
// 显式 ref 先固定成提交 OID，spec 清单、正文、code 路径和存在性都取自该提交。
// 显式 ref 默认没有可跳过的“无 spec”分支：先解析 ref，非 Git 目录或 ref 无效一律按读取失败报错。
// skipNonGitNoSpec 供任务门禁使用：检查根不在 Git 工作树内且本地没有 .spec 时没有版本可查，
// 按无 spec 跳过；Git 内的无效 ref、或非 Git 但存在 .spec 仍按读取失败报错。CLI 不开启。
// budgetMs 限制整次检查的总时长（Hook 用它保证在宿主回执窗口内返回）；缺省保持每次调用独立 10 秒上限。
export function checkSpecs(root, options = {}) {
  return runSpecCheck(root, options).report;
}
// 生产 Hook 的预检入口：额外返回 binding，协议复核通过后才允许复用报告。
// binding 只描述“检查对象”（目标提交 OID；HEAD 时还有受管文件与索引快照），不是持久缓存。
export function precheckSpecs(root, options = {}) {
  return runSpecCheck(root, { ...options, bind: true });
}
function runSpecCheck(root, { ref, skipNonGitNoSpec = false, budgetMs, bind = false } = {}) {
  const deadline = Number.isFinite(budgetMs) ? Date.now() + Math.max(0, budgetMs) : null;
  const label = ref || 'HEAD';
  const head = label === 'HEAD';
  // HEAD 且工作区没有 .spec 时不必拉起 git，保持原有快速跳过。
  let specs = head ? collectSpecs(root) : null;
  // 工作区快照必须早于 status/log：检查读到的对象与报告对应；之后任何改动都会在复核时体现为过期。
  const workspace = bind && head && specs ? workspaceSnapshot(root, specs) : null;
  // 索引快照必须与 status 读到的是同一份：status 用 --no-optional-locks 只读，不自行刷新索引；
  // status 前后索引若有变化，报告依据的 dirty 结果已不对应，按过期处理而不是配上新索引。
  const indexBefore = bind && head && specs ? indexSnapshot(root) : null;
  if (head && !specs) return { report: { ok: true, ref: label, skipped: 'no-spec', findings: [] }, binding: bind ? { label, noSpec: true } : null };
  if (!head && skipNonGitNoSpec && !insideGitWorkTree(root) && !collectSpecs(root)) {
    return { report: { ok: true, ref: label, skipped: 'no-spec', findings: [] }, binding: bind ? { label, noSpec: true, nonGitNoSpec: true } : null };
  }
  const findings = [];
  let displayRef = label;
  let commit = null;
  let indexChanged = false;
  try {
    if (git(root, ['rev-parse', '--is-shallow-repository'], { deadline }) === 'true') throw new CheckError('shallow');
    commit = git(root, ['rev-parse', '--verify', '--quiet', `${label}^{commit}`], { deadline });
    if (!head) {
      displayRef = commit;
      specs = commitSpecs(root, commit, deadline);
      if (!specs) return { report: { ok: true, ref: displayRef, skipped: 'no-spec', findings: [] }, binding: bind ? { label, commit } : null };
    }
    const byId = new Map();
    for (const spec of specs) byId.set(spec.id, [...(byId.get(spec.id) || []), spec]);
    for (const [specId, group] of byId) if (group.length > 1) findings.push({ id: specId, spec: group.map(s => s.spec), code: null, kind: 'duplicate-id', commits: [] });
    const commits = new Map();
    const log = git(root, ['log', '--format=%H%x1f%P%x1f%T%x1f%(trailers:key=Spec-OK,valueonly,separator=%x2C)%x1e', commit], { deadline });
    for (const record of log.split('\x1e')) {
      const [hash, parents, tree, trailers = ''] = record.replace(/^\s+/, '').split('\x1f');
      if (!hash) continue;
      commits.set(hash, { parents: parents ? parents.split(' ') : [], tree, ok: new Set(trailers.split(',').map(s => s.trim()).filter(Boolean)) });
    }
    const dirty = new Set();
    if (head) {
      const parts = git(root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '-z'], { deadline }).split('\0');
      for (let index = 0; index < parts.length; index++) {
        const entry = parts[index];
        if (entry.length < 4) continue;
        dirty.add(entry.slice(3));
        if (entry[0] === 'R' || entry[0] === 'C') dirty.add(parts[++index]);
      }
      // 其他会话在 status 执行期间改写索引：这次的 dirty 集合与检查开始时的索引不再对应。
      if (bind && !sameSnapshot(indexSnapshot(root), indexBefore)) indexChanged = true;
    }
    for (const spec of specs) {
      if (byId.get(spec.id).length > 1) continue;
      // 放行按 id 匹配：空提交（单父且树不变）覆盖其全部祖先；内容提交只豁免自己。
      const acks = [...commits].filter(([, c]) => c.ok.has(spec.id) && c.parents.length === 1 && commits.get(c.parents[0])?.tree === c.tree).map(([hash]) => hash);
      const versions = git(root, ['rev-list', commit, '--', spec.spec], { deadline }).split('\n').filter(Boolean);
      for (const code of spec.code) {
        const exists = validPath(code) && (head ? existsSync(path.join(root, code)) : git(root, ['cat-file', '-e', `${commit}:./${code}`], { allowFail: true, deadline }) !== null);
        if (!exists) { findings.push({ id: spec.id, spec: spec.spec, code, kind: 'missing', commits: [] }); continue; }
        // 排除项走 stdin：避开命令行长度上限，也不会把 ^<commit> 误放到 -- 之后当成路径。
        const input = [commit, ...versions.map(h => `^${h}`), ...acks.map(h => `^${h}`)].join('\n') + '\n';
        const unseen = git(root, ['rev-list', '--stdin', '--', code], { input, deadline }).split('\n').filter(Boolean).filter(h => !commits.get(h)?.ok.has(spec.id));
        if (unseen.length) findings.push({ id: spec.id, spec: spec.spec, code, kind: 'drift', commits: unseen });
        if (head && dirty.has(code) && !dirty.has(spec.spec)) findings.push({ id: spec.id, spec: spec.spec, code, kind: 'uncommitted-drift', commits: [] });
      }
    }
  } catch (error) {
    if (error instanceof CheckError) return { report: { ok: false, ref: displayRef, error: error.reason, ...(error.detail ? { detail: error.detail } : {}), findings }, binding: null };
    throw error;
  }
  const report = { ok: findings.length === 0, ref: displayRef, findings };
  if (!bind || !report.ok) return { report, binding: null };
  // 只有可能放行的报告需要复核绑定；已经带发现的报告只会挡下门禁。
  // 索引快照取在 status 之前，并且 status 使用 --no-optional-locks 不自行刷新索引；
  // 检查期间索引被改写（indexChanged）时不给绑定，门禁按不可豁免的 stale 处理。
  const binding = head
    ? indexChanged ? null : { label, commit, specs: specSnapshot(specs), files: workspace, index: indexBefore }
    : { label, commit };
  return { report, binding };
}
// 给门禁和 Stop 用的一行摘要。
export function describeFindings(findings) {
  return findings.map(f => f.kind === 'duplicate-id' ? `${f.id} 重名（${f.spec.join('、')}）`
    : `${f.id}：${f.code} ${f.kind}${f.commits.length ? `（${f.commits.length} 个提交：${f.commits.slice(0, 3).map(h => h.slice(0, 7)).join('、')}${f.commits.length > 3 ? '…' : ''}）` : ''}`).join('；');
}

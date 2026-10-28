import path from 'node:path';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// spec 漂移检查：`.spec/<id>/spec.md` 的 frontmatter `code:` 列出被管辖文件，改了文件而 spec 没跟着更新即漂移。
// 格式与放行规则沿用 SpexCode（Spec-OK trailer），检测自己实现；每次从 git 历史现算，不保存哈希。
const GIT_TIMEOUT = 10000;
const MAX_DEPTH = 8;
class CheckError extends Error {
  constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail; }
}
// 不经 shell、参数逐个传入；路径按字面匹配，文件名里的 * ? 不会被当成通配。
function git(root, args, { input, allowFail = false } = {}) {
  const result = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], { encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024, input });
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
function commitSpecs(root, commit) {
  if (git(root, ['cat-file', '-t', `${commit}:./.spec`], { allowFail: true }) !== 'tree') return null;
  const specs = [];
  for (const record of git(root, ['ls-tree', '-r', '-z', commit, '--', '.spec']).split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    // 与磁盘收集一致：只看普通 spec.md，不跟随链接，嵌套深度上限相同。
    if (type !== 'blob' || mode === '120000' || !/^\.spec\/.+\/spec\.md$/.test(file)) continue;
    const parts = file.split('/');
    if (parts.length - 3 > MAX_DEPTH) continue;
    specs.push({ id: parts[parts.length - 2], spec: file, code: codeList(git(root, ['show', `${commit}:./${file}`])) });
  }
  return specs.sort((a, b) => a.spec.localeCompare(b.spec));
}
// 没有 Git 边界的目录没有可读历史。此时工作区也没有 `.spec` 才算无 spec；
// 有 `.spec` 仍按检查失败报 git，不能把“读不到历史”说成“没有 spec”。
function insideGitWorkTree(root) {
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    try { lstatSync(path.join(cursor, '.git')); return true; } catch { /* 继续向上找仓库边界 */ }
    if (path.dirname(cursor) === cursor) return false;
  }
}
// 检查版本缺省为 HEAD；只有检查 HEAD 时才看当前 worktree 的文件与未提交改动。
// 显式 ref 先固定成提交 OID，spec 清单、正文、code 路径和存在性都取自该提交。
export function checkSpecs(root, { ref } = {}) {
  const label = ref || 'HEAD';
  const head = label === 'HEAD';
  // HEAD 且工作区没有 .spec 时不必拉起 git，保持原有快速跳过。
  let specs = head ? collectSpecs(root) : null;
  if (head && !specs) return { ok: true, ref: label, skipped: 'no-spec', findings: [] };
  if (!head && !insideGitWorkTree(root) && !collectSpecs(root)) return { ok: true, ref: label, skipped: 'no-spec', findings: [] };
  const findings = [];
  let displayRef = label;
  try {
    if (git(root, ['rev-parse', '--is-shallow-repository']) === 'true') throw new CheckError('shallow');
    const commit = git(root, ['rev-parse', '--verify', '--quiet', `${label}^{commit}`]);
    if (!head) {
      displayRef = commit;
      specs = commitSpecs(root, commit);
      if (!specs) return { ok: true, ref: displayRef, skipped: 'no-spec', findings: [] };
    }
    const byId = new Map();
    for (const spec of specs) byId.set(spec.id, [...(byId.get(spec.id) || []), spec]);
    for (const [specId, group] of byId) if (group.length > 1) findings.push({ id: specId, spec: group.map(s => s.spec), code: null, kind: 'duplicate-id', commits: [] });
    const commits = new Map();
    const log = git(root, ['log', '--format=%H%x1f%P%x1f%T%x1f%(trailers:key=Spec-OK,valueonly,separator=%x2C)%x1e', commit]);
    for (const record of log.split('\x1e')) {
      const [hash, parents, tree, trailers = ''] = record.replace(/^\s+/, '').split('\x1f');
      if (!hash) continue;
      commits.set(hash, { parents: parents ? parents.split(' ') : [], tree, ok: new Set(trailers.split(',').map(s => s.trim()).filter(Boolean)) });
    }
    const dirty = new Set();
    if (head) {
      const parts = git(root, ['status', '--porcelain', '--untracked-files=all', '-z']).split('\0');
      for (let index = 0; index < parts.length; index++) {
        const entry = parts[index];
        if (entry.length < 4) continue;
        dirty.add(entry.slice(3));
        if (entry[0] === 'R' || entry[0] === 'C') dirty.add(parts[++index]);
      }
    }
    for (const spec of specs) {
      if (byId.get(spec.id).length > 1) continue;
      // 放行按 id 匹配：空提交（单父且树不变）覆盖其全部祖先；内容提交只豁免自己。
      const acks = [...commits].filter(([, c]) => c.ok.has(spec.id) && c.parents.length === 1 && commits.get(c.parents[0])?.tree === c.tree).map(([hash]) => hash);
      const versions = git(root, ['rev-list', commit, '--', spec.spec]).split('\n').filter(Boolean);
      for (const code of spec.code) {
        const exists = validPath(code) && (head ? existsSync(path.join(root, code)) : git(root, ['cat-file', '-e', `${commit}:./${code}`], { allowFail: true }) !== null);
        if (!exists) { findings.push({ id: spec.id, spec: spec.spec, code, kind: 'missing', commits: [] }); continue; }
        // 排除项走 stdin：避开命令行长度上限，也不会把 ^<commit> 误放到 -- 之后当成路径。
        const input = [commit, ...versions.map(h => `^${h}`), ...acks.map(h => `^${h}`)].join('\n') + '\n';
        const unseen = git(root, ['rev-list', '--stdin', '--', code], { input }).split('\n').filter(Boolean).filter(h => !commits.get(h)?.ok.has(spec.id));
        if (unseen.length) findings.push({ id: spec.id, spec: spec.spec, code, kind: 'drift', commits: unseen });
        if (head && dirty.has(code) && !dirty.has(spec.spec)) findings.push({ id: spec.id, spec: spec.spec, code, kind: 'uncommitted-drift', commits: [] });
      }
    }
  } catch (error) {
    if (error instanceof CheckError) return { ok: false, ref: displayRef, error: error.reason, ...(error.detail ? { detail: error.detail } : {}), findings };
    throw error;
  }
  return { ok: findings.length === 0, ref: displayRef, findings };
}
// 给门禁和 Stop 用的一行摘要。
export function describeFindings(findings) {
  return findings.map(f => f.kind === 'duplicate-id' ? `${f.id} 重名（${f.spec.join('、')}）`
    : `${f.id}：${f.code} ${f.kind}${f.commits.length ? `（${f.commits.length} 个提交：${f.commits.slice(0, 3).map(h => h.slice(0, 7)).join('、')}${f.commits.length > 3 ? '…' : ''}）` : ''}`).join('；');
}

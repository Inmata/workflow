import path from 'node:path';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// spec 漂移检查：`.spec/<id>/spec.md` 的 frontmatter `code:` 列出被管辖文件，改了文件而 spec 没跟着更新即漂移。
// 格式与放行规则沿用 SpexCode（Spec-OK trailer），检测自己实现；每次从 git 历史现算，不保存哈希。
const GIT_TIMEOUT = 10000;
const MAX_DEPTH = 8;
class CheckError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
// 不经 shell、参数逐个传入；路径按字面匹配，文件名里的 * ? 不会被当成通配。
function git(root, args, { input, allowFail = false } = {}) {
  const result = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], { encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024, input });
  // 只去掉末尾换行：porcelain 首行的前导空格是状态位，不能 trim。
  if (result.status === 0) return result.stdout.replace(/[\r\n]+$/, '');
  if (allowFail && result.status !== null && !result.error) return null;
  throw new CheckError('git');
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
// 检查版本缺省为 HEAD；只有检查 HEAD 时才看工作区未提交改动。
export function checkSpecs(root, { ref } = {}) {
  const label = ref || 'HEAD';
  const head = label === 'HEAD';
  const specs = collectSpecs(root);
  if (!specs) return { ok: true, ref: label, skipped: 'no-spec', findings: [] };
  const findings = [];
  const byId = new Map();
  for (const spec of specs) byId.set(spec.id, [...(byId.get(spec.id) || []), spec]);
  for (const [specId, group] of byId) if (group.length > 1) findings.push({ id: specId, spec: group.map(s => s.spec), code: null, kind: 'duplicate-id', commits: [] });
  try {
    if (git(root, ['rev-parse', '--is-shallow-repository']) === 'true') throw new CheckError('shallow');
    const commit = git(root, ['rev-parse', '--verify', '--quiet', `${label}^{commit}`]);
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
    if (error instanceof CheckError) return { ok: false, ref: label, error: error.reason, findings };
    throw error;
  }
  return { ok: findings.length === 0, ref: label, findings };
}
// 给门禁和 Stop 用的一行摘要。
export function describeFindings(findings) {
  return findings.map(f => f.kind === 'duplicate-id' ? `${f.id} 重名（${f.spec.join('、')}）`
    : `${f.id}：${f.code} ${f.kind}${f.commits.length ? `（${f.commits.length} 个提交：${f.commits.slice(0, 3).map(h => h.slice(0, 7)).join('、')}${f.commits.length > 3 ? '…' : ''}）` : ''}`).join('；');
}

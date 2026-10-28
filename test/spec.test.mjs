// spec 漂移检查：真实 git 仓库，覆盖原型的 14 个场景、id 重名和原型修过的三个问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { checkSpecs, codeList } from '../src/spec.mjs';
import { cli, git, temporary } from './helpers.mjs';

const spec = (code, body = '说明') => `---\ntitle: t\ncode:\n${code.map(c => `  - ${c}`).join('\n')}\nrelated:\n  - docs/x.md\n---\n# t\n${body}\n`;
async function put(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
async function commit(root, files, message, extra = []) {
  for (const [file, text] of Object.entries(files)) await put(root, file, text);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message, ...extra]);
  return git(root, ['rev-parse', 'HEAD']);
}
const ack = (root, ids) => git(root, ['commit', '-q', '--allow-empty', '-m', 'spec ok', '-m', '行为不变', '--trailer', `Spec-OK: ${ids}`]);
// a、b 两个 spec 共享 src/shared.mjs。
async function repo() {
  const root = path.join(await temporary('spec-'), 'repo');
  await mkdir(root);
  git(root, ['init', '-q', '-b', 'main']);
  await commit(root, {
    'src/a.mjs': 'a1\n', 'src/shared.mjs': 's1\n', 'src/b.mjs': 'b1\n',
    '.spec/a/spec.md': spec(['src/a.mjs', 'src/shared.mjs']),
    '.spec/group/b/spec.md': spec(['src/b.mjs', 'src/shared.mjs']),
  }, 'init');
  return root;
}
const kinds = result => result.findings.map(f => `${f.id}:${f.code}:${f.kind}`).sort();

test('场景 1-3：初始通过；改代码不改 spec 报漂移；更新 spec 后通过（回归：^<commit> 不能放在 -- 之后）', async () => {
  const root = await repo();
  assert.deepEqual(checkSpecs(root), { ok: true, ref: 'HEAD', findings: [] });
  const changed = await commit(root, { 'src/a.mjs': 'a2\n' }, 'change a');
  const drift = checkSpecs(root);
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.findings, [{ id: 'a', spec: '.spec/a/spec.md', code: 'src/a.mjs', kind: 'drift', commits: [changed] }]);
  // 排除项若被当成路径，spec 版本不会被排除，这里会继续报漂移。
  await commit(root, { '.spec/a/spec.md': spec(['src/a.mjs', 'src/shared.mjs'], '更新') }, 'update spec');
  assert.equal(checkSpecs(root).ok, true);
});

test('场景 4-7：内容提交带 Spec-OK 通过；之后连改两次报 2 个提交；空提交放行后通过；放行后再改又报漂移', async () => {
  const root = await repo();
  await commit(root, { 'src/a.mjs': 'a2\n' }, 'refactor a', ['--trailer', 'Spec-OK: a']);
  assert.equal(checkSpecs(root).ok, true);
  const first = await commit(root, { 'src/a.mjs': 'a3\n' }, 'c1');
  const second = await commit(root, { 'src/a.mjs': 'a4\n' }, 'c2');
  assert.deepEqual(checkSpecs(root).findings[0].commits, [second, first]);
  ack(root, 'a');
  assert.equal(checkSpecs(root).ok, true);
  await commit(root, { 'src/a.mjs': 'a5\n' }, 'c3');
  assert.deepEqual(kinds(checkSpecs(root)), ['a:src/a.mjs:drift']);
});

test('场景 8-10：只放行另一个 id 仍报漂移（回归：按 id 匹配，不按路径）；共享文件只放行一个节点，另一个报漂移；两个都处理后通过', async () => {
  const root = await repo();
  await commit(root, { 'src/a.mjs': 'a2\n' }, 'change a');
  ack(root, 'b');
  assert.deepEqual(kinds(checkSpecs(root)), ['a:src/a.mjs:drift']);
  ack(root, 'a');
  assert.equal(checkSpecs(root).ok, true);
  await commit(root, { 'src/shared.mjs': 's2\n' }, 'change shared');
  ack(root, 'a');
  assert.deepEqual(kinds(checkSpecs(root)), ['b:src/shared.mjs:drift']);
  await commit(root, { '.spec/group/b/spec.md': spec(['src/b.mjs', 'src/shared.mjs'], '共享改动') }, 'update b');
  assert.equal(checkSpecs(root).ok, true);
  // 一个 trailer 写多个 id，用逗号分隔。
  await commit(root, { 'src/shared.mjs': 's3\n' }, 'change shared again');
  ack(root, 'a, b');
  assert.equal(checkSpecs(root).ok, true);
});

test('场景 11：未提交改动报 uncommitted-drift（回归：porcelain 首行前导空格不能被 trim）；spec 一起改则不报；检查非 HEAD 不看工作区', async () => {
  const root = await repo();
  await put(root, 'src/a.mjs', 'dirty\n');
  // 只有一个改动时它就是首行，状态位是前导空格 " M"。
  assert.deepEqual(kinds(checkSpecs(root)), ['a:src/a.mjs:uncommitted-drift']);
  assert.equal(checkSpecs(root, { ref: 'main' }).ok, true);
  await put(root, '.spec/a/spec.md', spec(['src/a.mjs', 'src/shared.mjs'], '同步'));
  assert.equal(checkSpecs(root).ok, true);
});

test('场景 12：分支上改代码、主干上改 spec 后合并，报漂移', async () => {
  const root = await repo();
  git(root, ['checkout', '-q', '-b', 'feature']);
  const changed = await commit(root, { 'src/a.mjs': 'feature\n' }, 'feature change');
  git(root, ['checkout', '-q', 'main']);
  await commit(root, { '.spec/a/spec.md': spec(['src/a.mjs', 'src/shared.mjs'], '主干') }, 'main spec');
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '-q', '--no-ff', '-m', 'merge', 'feature']);
  const result = checkSpecs(root);
  assert.deepEqual(kinds(result), ['a:src/a.mjs:drift']);
  assert.ok(result.findings[0].commits.includes(changed));
});

test('场景 13：被管辖文件改名报 missing；检查历史版本时按该版本的树判断', async () => {
  const root = await repo();
  const before = git(root, ['rev-parse', 'HEAD']);
  await rename(path.join(root, 'src/a.mjs'), path.join(root, 'src/renamed.mjs'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'rename', '--trailer', 'Spec-OK: a']);
  assert.deepEqual(kinds(checkSpecs(root)), ['a:src/a.mjs:missing']);
  assert.equal(checkSpecs(root, { ref: before }).ok, true);
});

test('场景 14：浅克隆拒绝检查，返回 shallow', async () => {
  const root = await repo();
  await commit(root, { 'src/a.mjs': 'a2\n' }, 'second');
  const clone = path.join(path.dirname(root), 'shallow');
  git(path.dirname(root), ['clone', '-q', '--depth', '1', `file://${root.replaceAll('\\', '/')}`, clone]);
  const result = checkSpecs(clone);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'shallow');
});

test('id 重名报 duplicate-id；没有 .spec 跳过；不是 git 仓库返回 git', async () => {
  const root = await repo();
  await commit(root, { '.spec/other/a/spec.md': spec(['src/b.mjs']) }, 'dup');
  const result = checkSpecs(root);
  assert.deepEqual(result.findings, [{ id: 'a', spec: ['.spec/a/spec.md', '.spec/other/a/spec.md'], code: null, kind: 'duplicate-id', commits: [] }]);
  const plain = await temporary('spec-plain-');
  assert.deepEqual(checkSpecs(plain), { ok: true, ref: 'HEAD', skipped: 'no-spec', findings: [] });
  await put(plain, '.spec/a/spec.md', spec(['x.mjs']));
  const failed = checkSpecs(plain);
  assert.equal(failed.error, 'git');
  // 带上 git 的原始报错，方便判断是不是仓库、所有权等环境问题。
  assert.match(failed.detail, /not a git repository/i);
});

test('显式 ref 使用目标提交的 spec 定义：新增 spec 不误报，删除 spec 按该版本判无 spec', async () => {
  const root = path.join(await temporary('spec-ref-'), 'repo');
  await mkdir(root);
  git(root, ['init', '-q', '-b', 'main']);
  const base = await commit(root, { 'src/x.mjs': 'x1\n' }, 'no spec yet');
  const withSpec = await commit(root, { '.spec/new/spec.md': spec(['src/x.mjs']) }, 'add spec');
  // 目标提交没有 .spec：跳过，不能拿当前磁盘新增的 spec 去回溯历史提交。
  assert.deepEqual(checkSpecs(root, { ref: base }), { ok: true, ref: base, skipped: 'no-spec', findings: [] });
  assert.equal(checkSpecs(root, { ref: withSpec }).ok, true);
  const changed = await commit(root, { 'src/x.mjs': 'x2\n' }, 'change x');
  assert.deepEqual(kinds(checkSpecs(root, { ref: changed })), ['new:src/x.mjs:drift']);
  // 删除 spec 的提交按该提交判无 spec，不能回退到 HEAD 或当前磁盘的其他定义。
  await rename(path.join(root, '.spec/new/spec.md'), path.join(root, 'old-spec.md'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'drop spec']);
  const dropped = git(root, ['rev-parse', 'HEAD']);
  assert.deepEqual(checkSpecs(root, { ref: dropped }), { ok: true, ref: dropped, skipped: 'no-spec', findings: [] });
  // HEAD 下空目录仍算“有 .spec 但没有 spec.md”，不报漂移；目标提交则按提交树判无 spec。
  assert.equal(checkSpecs(root).ok, true);
  assert.equal(checkSpecs(root).skipped, undefined);
  // 分支名先固定成 OID，返回的 ref 是实际检查的提交。
  assert.equal(checkSpecs(root, { ref: 'main' }).ref, dropped);
});

test('显式 ref 使用目标提交的 spec 路径：改路径不误报旧提交，新提交按新 id 报漂移', async () => {
  const root = await repo();
  const before = git(root, ['rev-parse', 'HEAD']);
  // 只改 spec 路径（id 随之改变），不动代码。
  await mkdir(path.join(root, '.spec/renamed'));
  await rename(path.join(root, '.spec/a/spec.md'), path.join(root, '.spec/renamed/spec.md'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'rename spec']);
  // 旧提交的 spec 路径仍存在于该提交；不能拿当前磁盘的新路径算版本，否则会误报历史漂移。
  assert.equal(checkSpecs(root, { ref: before }).ok, true);
  assert.equal(checkSpecs(root).ok, true);
  const changed = await commit(root, { 'src/a.mjs': 'a2\n' }, 'change a');
  assert.deepEqual(kinds(checkSpecs(root, { ref: changed })), ['renamed:src/a.mjs:drift']);
  assert.equal(checkSpecs(root, { ref: before }).ok, true);
});

test('显式 ref 读取失败与无 spec 区分：非 Git 目录或无 spec 也先解析 ref，不能返回 no-spec', async () => {
  const plain = await temporary('spec-plain-ref-');
  await put(plain, '.spec/a/spec.md', spec(['x.mjs']));
  const result = checkSpecs(plain, { ref: 'main' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'git');
  // 没有 Git 边界时显式 ref 无法解析成提交，即使工作区没有 .spec 也必须报读取失败。
  const empty = await temporary('spec-plain-ref-empty-');
  const noSpec = checkSpecs(empty, { ref: 'main' });
  assert.equal(noSpec.ok, false);
  assert.equal(noSpec.error, 'git');
  assert.equal(noSpec.skipped, undefined);
  // 默认（HEAD）模式保持既有语义：非 Git 且没有 .spec 时跳过。
  assert.equal(checkSpecs(empty).skipped, 'no-spec');
  // Git 仓库里的无效 ref 同样按读取失败报错，不能当成该版本没有 spec。
  const root = await repo();
  const invalid = checkSpecs(root, { ref: 'no-such-ref' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'git');
});

test('frontmatter 解析：块列表、行内列表、引号与注释；其他字段忽略', () => {
  assert.deepEqual(codeList('---\nhue: 3\ncode:\n  - "src/a b.mjs"\n  - ./src/c.mjs # 注释\nrelated:\n  - docs/x.md\n---\n'), ['src/a b.mjs', 'src/c.mjs']);
  assert.deepEqual(codeList('---\ncode: [src/a.mjs, \'src/b.mjs\']\n---\n'), ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(codeList('# 没有 frontmatter\ncode:\n  - a\n'), []);
});

test('spec check 命令：有漂移退出码 1 并输出 findings；--ref 指定版本', async () => {
  const root = await repo();
  const base = git(root, ['rev-parse', 'HEAD']);
  await commit(root, { 'src/a.mjs': 'a2\n' }, 'change');
  const drift = cli(['spec', 'check', '--project', root]);
  assert.equal(drift.status, 1);
  assert.equal(JSON.parse(drift.stdout).findings[0].kind, 'drift');
  const old = cli(['spec', 'check', '--project', root, '--ref', base]);
  assert.equal(old.status, 0, old.stdout);
  assert.equal(JSON.parse(old.stdout).ref, base);
  assert.equal(cli(['spec', 'check', '--project', root, '--ref', '-x']).status, 1);
});

test('spec check 从项目子目录运行：检查根回到 Git 顶层，HEAD 与显式 ref 都能发现根目录漂移', async () => {
  const root = await repo();
  const base = git(root, ['rev-parse', 'HEAD']);
  await put(root, 'nested/deep/notes.txt', 'n\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'nested']);
  const subdir = path.join(root, 'nested', 'deep');
  const state = await temporary('spec-cli-state-');
  const args = ['spec', 'check', '--state-dir', state];
  // 子目录本身没有 .spec：检查根必须回到 Git 顶层，否则会误报 no-spec。
  const changed = await commit(root, { 'src/a.mjs': 'a2\n' }, 'change');
  const drift = cli(args, { cwd: subdir });
  assert.equal(drift.status, 1, drift.stdout);
  assert.deepEqual(JSON.parse(drift.stdout).findings.map(f => f.kind), ['drift']);
  // 显式 --project 指向子目录，与默认 cwd 走同一条可信解析。
  const explicit = cli([...args, '--project', subdir], { cwd: subdir });
  assert.equal(explicit.status, 1, explicit.stdout);
  assert.equal(JSON.parse(explicit.stdout).findings[0].code, 'src/a.mjs');
  // 显式 ref 同样按顶层检查根读取目标提交。
  const atRef = cli([...args, '--ref', changed], { cwd: subdir });
  assert.equal(atRef.status, 1, atRef.stdout);
  assert.equal(JSON.parse(atRef.stdout).ref, changed);
  const atBase = cli([...args, '--ref', base], { cwd: subdir });
  assert.equal(atBase.status, 0, atBase.stdout);
  assert.equal(JSON.parse(atBase.stdout).ref, base);
});

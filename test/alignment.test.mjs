import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { alignmentStatus, applyAlignment, classify, decideAlignment, scanAlignment, suggestAlignment } from '../src/alignment.mjs';
import { getContext } from '../src/context.mjs';
import { readState, digest } from '../src/store.mjs';
import { cli, event, fixture, identity, start } from './helpers.mjs';

const docPath = project => path.join(project, 'docs', 'WORKFLOW-ALIGNMENT.md');
async function documents(project, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(project, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

test('scan 排除构建目录与链接，分类正确，上限生效', async () => {
  const f = await fixture();
  await documents(f.project, {
    'package.json': '{}\n',
    'scripts/build.ps1': 'exit 0\n',
    'docs/PRODUCT.md': '# 产品\n',
    'docs/usage.md': '# 使用\n',
    'docs/RELEASE-v0.1.0.md': '# 发布\n',
    'docs/plans/v0.6.0/PLAN.md': '# 计划\n',
    'docs/superpowers/plans/old.md': '# 旧计划\n',
    'node_modules/dependency/readme.md': '# 依赖\n',
    'dist/output.md': '# 产物\n',
  });
  await writeFile(path.join(f.area, 'source.md'), '# 链接源\n');
  await link(path.join(f.area, 'source.md'), path.join(f.project, 'hardlink.md'));
  const scanned = await scanAlignment(f.directory, f.project);
  const paths = new Set(scanned.files.map(file => file.path));
  assert.equal(scanned.status, 'scanned');
  assert.ok(paths.has('README.md'));
  assert.ok(paths.has('AGENTS.md'));
  assert.ok(paths.has('package.json'));
  assert.ok(paths.has('scripts/build.ps1'));
  assert.ok(!paths.has('node_modules/dependency/readme.md'));
  assert.ok(!paths.has('dist/output.md'));
  assert.ok(!paths.has('hardlink.md'));
  assert.ok(scanned.skipped.some(item => item.path === 'hardlink.md' && item.reason === 'hardlink'));
  const kinds = Object.fromEntries(scanned.files.map(file => [file.path, file.kind]));
  assert.equal(kinds['README.md'], 'product');
  assert.equal(kinds['docs/usage.md'], 'usage');
  assert.equal(kinds['docs/RELEASE-v0.1.0.md'], 'release');
  assert.equal(kinds['docs/plans/v0.6.0/PLAN.md'], 'plan');
  assert.equal(kinds['docs/superpowers/plans/old.md'], 'archive');
  assert.equal(classify('docs/ARCHITECTURE.md'), 'product');
  const limited = await scanAlignment(f.directory, f.project, { maxFiles: 2 });
  assert.equal(limited.files.length, 2);
  assert.equal(limited.truncated, true);
  await assert.rejects(scanAlignment(f.directory, f.project, { maxFiles: 0 }), { code: 'INPUT' });
});

test('status 检测大小、时间、消失和目录变化', async () => {
  const f = await fixture();
  await documents(f.project, { 'docs/a.md': '原始\n', 'docs/b.md': '待删除\n' });
  await scanAlignment(f.directory, f.project);
  await writeFile(path.join(f.project, 'docs', 'a.md'), '内容变长，大小不同\n');
  await rm(path.join(f.project, 'docs', 'b.md'));
  await writeFile(path.join(f.project, 'docs', 'c.md'), '新增资料\n');
  const status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.exists, true);
  assert.equal(status.stale, true);
  assert.ok(status.changed.some(item => item.path === 'docs/a.md' && item.reason === 'size'));
  assert.ok(status.missing.some(item => item.path === 'docs/b.md'));
  assert.ok(status.directoryChanged.includes('docs'));
  const other = await fixture();
  const clean = await alignmentStatus(other.directory, other.project);
  assert.equal(clean.exists, false);
});

test('apply 只替换标记区，保留手写正文，指纹冲突不覆盖', async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, 'docs'), { recursive: true });
  const original = '# 我的笔记\n手写前置内容\n\n<!-- workflow-alignment:begin -->\n旧正文\n<!-- workflow-alignment:end -->\n\n## 我的补充\n手写后置内容\n';
  await writeFile(docPath(f.project), original);
  await scanAlignment(f.directory, f.project);
  const result = await apply(f, { content: '# 项目对齐\n## 对齐依据\n新正文' });
  assert.equal(result.status, 'applied');
  const updated = await readFile(docPath(f.project), 'utf8');
  assert.ok(updated.startsWith('# 我的笔记\n手写前置内容\n\n'));
  assert.ok(updated.endsWith('\n\n## 我的补充\n手写后置内容\n'));
  assert.ok(updated.includes('## 对齐依据\n新正文'));
  assert.ok(!updated.includes('旧正文'));
  await writeFile(docPath(f.project), `${updated}\n用户追加内容\n`);
  await assert.rejects(apply(f, { content: '再改一次' }), { code: 'CONFLICT' });
  assert.ok((await readFile(docPath(f.project), 'utf8')).includes('用户追加内容'));
  await assert.rejects(apply(f, { content: '越界', docPath: 'docs/其他.md' }), { code: 'PATH' });
  await assert.rejects(apply(f, { content: '基线不对', baseline: 'not-a-real-digest' }), { code: 'CONFLICT' });
});

test('decide 与 suggest 更新状态和文档维护区，不重复追加', async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, 'docs'), { recursive: true });
  await writeFile(docPath(f.project), '# 项目对齐\n\n## 已裁决记录\n\n手写说明\n\n## 结构建议\n\n手写建议\n\n## 其余\n保留\n');
  await decide(f, { decisions: [{ id: 'D1', status: 'accepted-project', reason: '项目已有约定' }, { id: 'D2', status: 'pending' }] });
  const indexed = (await readState(f.directory)).projects[f.projectId].alignment;
  assert.ok(indexed.files.length > 0, '首次 decide 前应自动补做扫描，否则变更检测失效');
  let status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.pendingDecisions, 1);
  let text = await readFile(docPath(f.project), 'utf8');
  assert.ok(text.includes('D1 accepted-project：项目已有约定'));
  assert.ok(text.includes('## 其余\n保留'));
  await decide(f, { decisions: [{ id: 'D1', status: 'rejected', reason: '复核后改判' }] });
  text = await readFile(docPath(f.project), 'utf8');
  assert.equal((text.match(/D1/g) || []).length, 1);
  assert.ok(text.includes('D1 rejected：复核后改判'));
  assert.ok(text.includes('D2 pending'));
  const stored = (await readState(f.directory)).projects[f.projectId].alignment.decisions.find(item => item.id === 'D1');
  assert.deepEqual(Object.keys(stored).sort(), ['decidedAt', 'id', 'status']);
  await suggest(f, { findings: [{ id: 'F1', problem: '版本号陈旧', location: 'CONTRIBUTING.md', recommendation: '改为与代码常量一致' }] });
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.pendingFindings, 1);
  text = await readFile(docPath(f.project), 'utf8');
  assert.ok(text.includes('| F1 | 版本号陈旧 | CONTRIBUTING.md | 改为与代码常量一致 | pending |'));
  const storedFinding = (await readState(f.directory)).projects[f.projectId].alignment.findings.find(item => item.id === 'F1');
  assert.deepEqual(Object.keys(storedFinding).sort(), ['id', 'status']);
  await assert.rejects(decide(f, { decisions: [{ id: 'D3', status: 'unknown' }] }), { code: 'INPUT' });
  // Lead 直接写表格而没经过 decide/suggest 时，待办数量仍以文档为准。
  const handwritten = await readFile(docPath(f.project), 'utf8');
  await writeFile(docPath(f.project), `${handwritten}\n## 待裁决差异\n\n| ID | 项目现行做法 | workflow 默认 | 影响 | 我的建议 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| D9 | 项目做法 | 默认做法 | 影响 | 建议 | pending |\n| D10 | 项目做法 | 默认做法 | 影响 | 建议 | accepted-project |\n`);
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.pendingDecisions, 2);
  assert.equal(status.pendingFindings, 1);
  await scanAlignment(f.directory, f.project);
  await decide(f, { baseline: digest(await readFile(docPath(f.project))), decisions: [{ id: 'D9', status: 'accepted-project', reason: '已确认差异' }] });
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.pendingDecisions, 1);
  assert.ok((await readFile(docPath(f.project), 'utf8')).includes('| D9 | 项目做法 | 默认做法 | 影响 | 建议 | accepted-project |'));
});

test('decide 写入末节时停在管理区结束标记前，并清理占位行', async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, 'docs'), { recursive: true });
  await writeFile(docPath(f.project), '<!-- workflow-alignment:begin -->\n# 项目对齐\n\n## 已裁决记录\n\n- 暂无\n<!-- workflow-alignment:end -->\n\n手写尾注\n');
  await decide(f, { decisions: [{ id: 'D1', status: 'accepted-workflow', reason: '用户选 1A' }] });
  await decide(f, { decisions: [{ id: 'D2', status: 'accepted-workflow', reason: '用户选 2A' }] });
  const text = await readFile(docPath(f.project), 'utf8');
  assert.equal(text, '<!-- workflow-alignment:begin -->\n# 项目对齐\n\n## 已裁决记录\n\nD1 accepted-workflow：用户选 1A\nD2 accepted-workflow：用户选 2A\n<!-- workflow-alignment:end -->\n\n手写尾注\n');
});

test('对齐写入受只读/计划权限与明确基线保护', async () => {
  for (const mode of ['read-only', 'plan']) {
    const f = await fixture(); await start(f, { mode, allowedPaths: ['WORKFLOW-ALIGNMENT.md'] });
    await assert.rejects(applyAlignment(f.directory, f.project, { ...await identity(f), baseline: null, content: '# 对齐' }), { code: 'PERMISSION' });
    assert.equal((await readState(f.directory)).projects[f.projectId].alignment, undefined);
  }
  const f = await fixture(); await start(f, { mode: 'write', allowedPaths: ['WORKFLOW-ALIGNMENT.md'] });
  await assert.rejects(applyAlignment(f.directory, f.project, { ...await identity(f), content: '# 对齐' }), { code: 'CONFLICT' });
});

test('context 注入 alignment，旧项目返回 exists:false，新回合标记 stale', async () => {
  const f = await fixture();
  let context = await getContext(f.directory, f.project, 'lead', f.sessionId);
  assert.deepEqual(context.alignment, { path: 'docs/WORKFLOW-ALIGNMENT.md', exists: false, stale: false, changed: [], missing: [], directoryChanged: [], pendingDecisions: 0, pendingFindings: 0 });
  assert.ok(context.instruction.includes('项目尚未对齐'));
  await documents(f.project, { 'docs/PRODUCT.md': '# 产品\n' });
  await scanAlignment(f.directory, f.project);
  await apply(f, { content: '# 项目对齐\n', decisions: [{ id: 'D1', status: 'pending' }] });
  context = await getContext(f.directory, f.project, 'lead', f.sessionId);
  assert.equal(context.alignment.exists, true);
  assert.equal(context.alignment.stale, false);
  assert.equal(context.alignment.pendingDecisions, 1);
  assert.ok(context.instruction.includes('1 项待裁决'));
  const worker = await getContext(f.directory, f.project, 'worker', f.sessionId);
  assert.equal(worker.alignmentGuide, undefined);
  await writeFile(path.join(f.project, 'docs', 'PRODUCT.md'), '# 产品\n已变更\n');
  const output = await event(f, 'UserPromptSubmit');
  const injected = JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 入口：'.length));
  assert.equal(injected.alignment.stale, true);
  assert.ok(injected.alignment.changed.some(item => item.path === 'docs/PRODUCT.md'));
  assert.ok(injected.instruction.includes('对齐索引已过期'));
});

test('CLI 接入 align scan/status，state 只保存 ID 与状态', async () => {
  const f = await fixture();
  await documents(f.project, { 'docs/usage.md': '# 使用\n' });
  const scanned = cli(['project', 'align', 'scan', '--root', f.project, '--state-dir', f.directory, '--max-files', '5']);
  assert.equal(scanned.status, 0, scanned.stdout);
  const scanResult = JSON.parse(scanned.stdout);
  assert.equal(scanResult.status, 'scanned');
  assert.ok(scanResult.files.length <= 5);
  const status = cli(['project', 'align', 'status', '--root', f.project, '--state-dir', f.directory]);
  assert.equal(status.status, 0, status.stdout);
  assert.equal(JSON.parse(status.stdout).stale, false);
  const state = await readState(f.directory);
  const alignment = state.projects[f.projectId].alignment;
  assert.equal(alignment.schemaVersion, 1);
  assert.equal(alignment.docPath, 'docs/WORKFLOW-ALIGNMENT.md');
  assert.equal(alignment.docFingerprint, null);
});

test('sources 确认单个来源后不再提示，未确认来源仍过期', async () => {
  const f = await fixture();
  await documents(f.project, { 'docs/a.md': '原始\n' });
  await scanAlignment(f.directory, f.project);
  await writeFile(path.join(f.project, 'README.md'), '# 项目\n原始内容\n已变更\n');
  await writeFile(path.join(f.project, 'docs', 'a.md'), '已变更\n');
  let status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, true);
  assert.deepEqual(status.changed.map(item => item.path).sort(), ['README.md', 'docs/a.md']);
  assert.ok(status.changed.every(item => Number.isSafeInteger(item.size) && typeof item.mtimeMs === 'number'));
  // 旧客户端只写正文/裁决，不传 sources 时不刷新任何来源基线。
  await apply(f, { content: '# 项目对齐\n' });
  await decide(f, { decisions: [{ id: 'D1', status: 'pending' }] });
  await suggest(f, { findings: [{ id: 'F1', problem: '缺少索引', location: 'docs', recommendation: '补索引' }] });
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, true);
  assert.deepEqual(status.changed.map(item => item.path).sort(), ['README.md', 'docs/a.md']);
  let context = await getContext(f.directory, f.project, 'lead', f.sessionId);
  assert.ok(context.instruction.includes('sources'));
  await apply(f, { content: '# 项目对齐\n', sources: [await snapshot(f.project, 'README.md')] });
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, true);
  assert.deepEqual(status.changed.map(item => item.path), ['docs/a.md']);
  await apply(f, { content: '# 项目对齐\n', sources: [await snapshot(f.project, 'docs/a.md')] });
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, false);
  assert.deepEqual(status.changed, []);
  context = await getContext(f.directory, f.project, 'lead', f.sessionId);
  assert.ok(!context.instruction.includes('对齐索引已过期'));
});

test('sources 快照在提交前复核，确认期间再次修改保留 stale', async () => {
  const f = await fixture();
  await scanAlignment(f.directory, f.project);
  await writeFile(path.join(f.project, 'README.md'), '# 项目\n第一次修改\n');
  const stale = await snapshot(f.project, 'README.md');
  await writeFile(path.join(f.project, 'README.md'), '# 项目\n第二次修改，内容更长\n');
  const result = await apply(f, { content: '# 项目对齐\n', sources: [stale] });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.unconfirmed, [{ path: 'README.md', reason: 'size' }]);
  let status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, true);
  assert.deepEqual(status.changed.map(item => item.path), ['README.md']);
  const fixed = await apply(f, { content: '# 项目对齐\n', sources: [await snapshot(f.project, 'README.md')] });
  assert.deepEqual(fixed.confirmed, ['README.md']);
  assert.deepEqual(fixed.unconfirmed, []);
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, false);
});

test('sources 支持新增、删除与 decisions/findings 一次提交', async () => {
  const f = await fixture();
  await documents(f.project, { 'docs/a.md': '原始\n' });
  await scanAlignment(f.directory, f.project);
  await rename(path.join(f.project, 'docs', 'a.md'), path.join(f.area, 'a-removed.md'));
  await writeFile(path.join(f.project, 'docs', 'new.md'), '新增资料\n');
  await writeFile(path.join(f.project, 'docs', 'other.md'), '另一份新增\n');
  let status = await alignmentStatus(f.directory, f.project);
  assert.ok(status.missing.some(item => item.path === 'docs/a.md'));
  assert.ok(status.directoryChanged.includes('docs'));
  const result = await apply(f, {
    content: '# 项目对齐\n',
    decisions: [{ id: 'D1', status: 'accepted-project', reason: '用户选择项目做法' }],
    findings: [{ id: 'F1', problem: '缺少索引', location: 'docs', recommendation: '补索引' }],
    sources: [{ path: 'docs/a.md', deleted: true }, await snapshot(f.project, 'docs/new.md')],
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.confirmed.sort(), ['docs/a.md', 'docs/new.md']);
  assert.deepEqual(result.unconfirmed, []);
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, true);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.directoryChanged, ['docs']);
  const indexed = (await readState(f.directory)).projects[f.projectId].alignment.files.map(file => file.path);
  assert.ok(!indexed.includes('docs/a.md'));
  assert.ok(indexed.includes('docs/new.md'));
  assert.ok(!indexed.includes('docs/other.md'));
  const text = await readFile(docPath(f.project), 'utf8');
  assert.ok(text.includes('D1 accepted-project：用户选择项目做法'));
  assert.ok(text.includes('| F1 | 缺少索引 | docs | 补索引 | pending |'));
  await apply(f, { content: '# 项目对齐\n', sources: [await snapshot(f.project, 'docs/other.md')] });
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, false);
  assert.deepEqual(status.directoryChanged, []);
});

test('新目录只确认部分来源时，未确认来源仍触发 stale', async () => {
  const f = await fixture();
  await documents(f.project, { 'docs/a.md': '原始\n' });
  await scanAlignment(f.directory, f.project);
  await documents(f.project, { 'docs/new/a.md': '新增 a\n', 'docs/new/b.md': '新增 b\n' });
  const first = await apply(f, { content: '# 项目对齐\n', sources: [await snapshot(f.project, 'docs/new/a.md')] });
  assert.deepEqual(first.confirmed, ['docs/new/a.md']);
  let status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, true, JSON.stringify(status));
  assert.ok(status.directoryChanged.includes('docs'), JSON.stringify(status));
  // 目录基线不能提前把 docs/new 记为已同步，否则第二次检查会被跳过。
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, true, JSON.stringify(status));
  await apply(f, { content: '# 项目对齐\n', sources: [await snapshot(f.project, 'docs/new/b.md')] });
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, false, JSON.stringify(status));
  assert.deepEqual(status.directoryChanged, []);
});

test('多层新增目录中已确认文件不占用未收录搜索名额', async () => {
  const f = await fixture();
  await documents(f.project, { 'docs/a.md': '原始\n' });
  await scanAlignment(f.directory, f.project);
  await documents(f.project, {
    'docs/new/deep/a.md': 'a\n',
    'docs/new/deep/b.md': 'b\n',
    'docs/new/deep/c.md': 'c\n',
  });
  const first = await apply(f, {
    content: '# 项目对齐\n',
    sources: [await snapshot(f.project, 'docs/new/deep/a.md'), await snapshot(f.project, 'docs/new/deep/b.md')],
  });
  assert.deepEqual(first.confirmed, ['docs/new/deep/a.md', 'docs/new/deep/b.md']);
  let status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, true, JSON.stringify(status));
  assert.ok(status.directoryChanged.includes('docs'), JSON.stringify(status));
  await apply(f, { content: '# 项目对齐\n', sources: [await snapshot(f.project, 'docs/new/deep/c.md')] });
  status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, false, JSON.stringify(status));
  assert.deepEqual(status.directoryChanged, []);
});

test('sources 拒绝越界路径、无效快照、重复与对齐文档自身', async () => {
  const f = await fixture();
  await scanAlignment(f.directory, f.project);
  const cases = [
    ['README.md', 'INPUT'],
    [[{}], 'PATH'],
    [[{ path: '../outside.md' }], 'PATH'],
    [[{ path: 'docs/picture.png' }], 'INPUT'],
    [[{ path: 'README.md', size: 1 }], 'INPUT'],
    [[{ path: 'README.md', size: 1, mtimeMs: 1 }, { path: 'README.md' }], 'INPUT'],
    [[{ path: 'README.md', deleted: true, size: 1, mtimeMs: 1 }], 'INPUT'],
    [[{ path: 'WORKFLOW-ALIGNMENT.md' }], 'INPUT'],
  ];
  for (const [sources, code] of cases) {
    await assert.rejects(apply(f, { content: '# 项目对齐\n', sources }), { code }, JSON.stringify(sources));
  }
});

async function snapshot(project, relative) {
  const info = await lstat(path.join(project, relative));
  return { path: relative, size: info.size, mtimeMs: info.mtimeMs };
}

async function authorized(f, operation, input) {
  if (!f.alignmentTask) { await start(f, { mode: 'write', allowedPaths: ['docs/WORKFLOW-ALIGNMENT.md', 'WORKFLOW-ALIGNMENT.md'] }); f.alignmentTask = true; }
  const p = (await readState(f.directory)).projects[f.projectId];
  const relative = input.docPath || p.alignment?.docPath || 'docs/WORKFLOW-ALIGNMENT.md';
  const bytes = await readFile(path.join(f.project, relative)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const baseline = p.alignment?.docFingerprint ?? (bytes === null ? null : digest(bytes));
  return operation(f.directory, f.project, { ...await identity(f), baseline, ...input });
}
const apply = (f, input) => authorized(f, applyAlignment, input);
const decide = (f, input) => authorized(f, decideAlignment, input);
const suggest = (f, input) => authorized(f, suggestAlignment, input);

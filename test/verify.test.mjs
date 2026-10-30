import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checksFromScripts, parseArgs, runChecks, selectChecks } from '../scripts/verify.mjs';
import { temporary } from './helpers.mjs';

const node = JSON.stringify(process.execPath);
const verifyEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify.mjs');
const marker = name => `${node} -e "console.log('${name}')"`;

test('F10 正例：全部检查通过时退出码为 0，原始输出与摘要都留存', async () => {
  const outDir = path.join(await temporary('verify-pass-'), 'out');
  const checks = [
    { id: 'alpha', command: marker('alpha-raw-marker'), selected: true, synthetic: false, note: '样例检查' },
    { id: 'demo', command: marker('demo-raw-marker'), selected: true, synthetic: true, note: '合成 smoke：仅隔离样例' },
  ];
  const { summary, markdown } = runChecks(checks, { outDir });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.overall, 'passed');
  assert.deepEqual(summary.checks.map(check => check.status), ['passed', 'passed']);
  assert.match(await readFile(path.join(outDir, 'alpha.log'), 'utf8'), /alpha-raw-marker/);
  assert.match(await readFile(path.join(outDir, 'demo.log'), 'utf8'), /demo-raw-marker/);
  const stored = JSON.parse(await readFile(path.join(outDir, 'summary.json'), 'utf8'));
  assert.equal(stored.overall, 'passed');
  assert.equal(stored.checks[1].synthetic, true);
  const retained = await readFile(path.join(outDir, 'summary.md'), 'utf8');
  assert.match(retained, /demo（合成 smoke）/);
  assert.match(retained, /未运行项：无/);
  assert.match(markdown, /总体：通过/);
});

test('F10 失败传播：子命令退出 3 时整体非零，失败项留痕且后续检查仍执行', async () => {
  const outDir = path.join(await temporary('verify-fail-'), 'out');
  const checks = [
    { id: 'first', command: `${node} -e "console.error('boom-marker'); process.exit(3)"`, selected: true },
    { id: 'second', command: marker('second-ran'), selected: true },
  ];
  const { summary } = runChecks(checks, { outDir });
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.overall, 'failed');
  assert.equal(summary.checks[0].status, 'failed');
  assert.equal(summary.checks[0].exitCode, 3);
  assert.match(await readFile(summary.checks[0].log, 'utf8'), /boom-marker/);
  assert.equal(summary.checks[1].status, 'passed');
  assert.match(await readFile(summary.checks[1].log, 'utf8'), /second-ran/);
  const retained = await readFile(path.join(outDir, 'summary.md'), 'utf8');
  assert.match(retained, /first \| 失败 \| 3 \|/);
});

test('F10 未完成：package.json 缺少脚本时标为未运行，整体非零', async () => {
  const outDir = path.join(await temporary('verify-missing-'), 'out');
  const checks = checksFromScripts({ test: marker('only-test-script') });
  assert.equal(checks.find(check => check.id === 'check').command, null);
  const { summary } = runChecks(checks, { outDir });
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.checks.find(check => check.id === 'check').status, 'not-run');
  assert.match(summary.checks.find(check => check.id === 'check').reason, /缺少 check 脚本/);
  assert.equal(summary.checks.find(check => check.id === 'check').log, null);
  assert.equal(summary.checks.find(check => check.id === 'test').status, 'passed');
  const retained = await readFile(path.join(outDir, 'summary.md'), 'utf8');
  assert.match(retained, /缺少 check 脚本/);
  assert.match(retained, /未运行项：check（package.json 缺少 check 脚本）、demo（package.json 缺少 demo 脚本）/);
  assert.doesNotMatch(retained, /未运行项：无/);
});

test('F10 未运行原因：被终止的检查也列入未运行项并保留原因', async () => {
  const outDir = path.join(await temporary('verify-timeout-'), 'out');
  const checks = [{ id: 'slow', command: `${node} -e "setTimeout(() => {}, 5000)"`, selected: true }];
  const { summary } = runChecks(checks, { outDir, timeoutMs: 300 });
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.checks[0].status, 'not-run');
  assert.match(summary.checks[0].reason, /超过时限（300ms）被终止/);
  const retained = await readFile(path.join(outDir, 'summary.md'), 'utf8');
  assert.match(retained, /未运行项：slow（超过时限（300ms）被终止）/);
});

test('F10 选择：显式子集只运行选中项，未选项明确标为未选择', async () => {
  const outDir = path.join(await temporary('verify-select-'), 'out');
  const all = checksFromScripts({ check: marker('selected-check'), test: `${node} -e "process.exit(9)"`, demo: `${node} -e "process.exit(8)"` });
  const selected = selectChecks(all, ['check']);
  assert.deepEqual(selected.map(check => [check.id, check.selected]), [['check', true], ['test', false], ['demo', false]]);
  const { summary } = runChecks(selected, { outDir });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.checks.find(check => check.id === 'test').status, 'not-run');
  assert.equal(summary.checks.find(check => check.id === 'test').reason, '未选择');
  assert.match(await readFile(path.join(outDir, 'summary.md'), 'utf8'), /未运行项：test（未选择）、demo（未选择）/);
  assert.throws(() => selectChecks(all, ['bogus']), /未知检查：bogus/);
});

test('F10 默认组合与 package.json 脚本一致，demo 始终标为合成 smoke', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const checks = checksFromScripts(pkg.scripts);
  assert.deepEqual(checks.map(check => check.id), ['check', 'test', 'demo']);
  assert.equal(checks[0].command, pkg.scripts.check);
  assert.equal(checks[1].command, pkg.scripts.test);
  assert.equal(checks[2].command, pkg.scripts.demo);
  assert.equal(checks.filter(check => check.synthetic).map(check => check.id).join(','), 'demo');
});

test('F10 参数边界：未知检查与缺参在运行前失败，--help 不运行检查', () => {
  const unknown = spawnSync(process.execPath, [verifyEntry, 'bogus'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /未知检查：bogus/);
  assert.doesNotMatch(unknown.stdout, /workflow 验证摘要/);
  const missing = spawnSync(process.execPath, [verifyEntry, '--out'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /--out 需要目录参数/);
  const help = spawnSync(process.execPath, [verifyEntry, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /用法：node scripts\/verify\.mjs/);
  assert.deepEqual(parseArgs(['check', '--out', 'reports']), { ids: ['check'], out: 'reports' });
});

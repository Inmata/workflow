import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { command } from '../src/entry.mjs';
import * as entryModule from '../src/entry.mjs';
import { root, temporary } from './helpers.mjs';
import { fixture, cli } from './helpers.mjs';

// 测试独立给出期望，不复用生产实现。
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const shQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
// Windows PowerShell 5.1 不能把双引号或空参数原样交给原生程序，这类值改为安全标记传输。
const MARK = 'workflow-arg64:';

const SPECIAL = [
  'D:/sample with space',
  "D:/quote'single",
  'D:/double"quote',
  'D:/dollar$HOME',
  'D:/sub$(Set-Content canary-q-w-b.txt x)',
  'D:/back`tick',
  'D:/semi;Write-Output canary',
  'D:/amp&whoami',
  'D:/pipe|whoami',
  'D:/paren(1)',
  'relative trailing \\',
  '',
  // 与传输标记相同的字面值和带单双引号、$、子表达式的用户自由文本也要逐字往返。
  'workflow-arg64:YWJj',
  '用户自由文本 $HOME "引号"',
];

// command() 会把绝对路径统一成正斜杠；期望值按同一规则换算，其余字符逐字比较。
const EXPECTED = SPECIAL.map(value => path.isAbsolute(value) ? value.replaceAll('\\', '/') : value);

// 真实宿主里的两个 PowerShell 都验证；不把 pwsh 的结果冒充 Windows PowerShell 5.1。
function discover(name) {
  if (process.platform !== 'win32') return null;
  const probe = spawnSync(name, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (probe.error || probe.status !== 0) return null;
  return { command: name, version: probe.stdout.trim() };
}
const SHELLS = ['powershell.exe', 'pwsh.exe'].map(discover).filter(Boolean);
const shellArgs = source => ['-NoProfile', '-NonInteractive', '-Command', source];
const shell = (item, source, options = {}) => spawnSync(item.command, shellArgs(source), { encoding: 'utf8', windowsHide: true, timeout: 30000, ...options });

async function recorder(area) {
  const file = path.join(area, 'recorder.mjs');
  const entryUrl = pathToFileURL(path.join(root, 'src', 'entry.mjs')).href;
  // 记录器按真实 CLI 的方式只还原 command() 生成的传输参数，打印前不修改原始 argv。
  await writeFile(file, `import { transportArguments } from ${JSON.stringify(entryUrl)};\nprocess.stdout.write(JSON.stringify(transportArguments(process.argv.slice(2))));\n`);
  return file;
}
// 取 command() 实际生成的参数段，避免另造一份字符串。
function argumentPart(args) {
  const full = command(args), head = `${command([])} `;
  assert.ok(full.startsWith(head), full);
  return full.slice(head.length);
}
const parseJSON = (text, label) => {
  try { return JSON.parse(text); } catch { assert.fail(`${label} 的输出不是 JSON：${JSON.stringify(text.slice(0, 400))}`); }
};

test('普通参数保持原样，特殊参数使用单引号字面量而不是可展开的双引号', () => {
  const plain = command(['D:/plain/path']);
  assert.ok(plain.endsWith(' D:/plain/path'), plain);
  const generated = command(["D:/a b", "D:/it's", 'D:/x$(y)', 'D:/x"y"', '$HOME']);
  const quote = process.platform === 'win32' ? psQuote : shQuote;
  for (const value of ["D:/a b", "D:/it's", 'D:/x$(y)', '$HOME']) assert.ok(generated.includes(quote(value)), generated);
  for (const value of ["D:/a b", "D:/it's", 'D:/x$(y)', '$HOME']) assert.ok(!generated.includes(`"${value}"`), generated);
  if (process.platform === 'win32') {
    // 5.1 无法用引号表达的值编码为只含安全字符的标记；CLI 启动时还原为原值。
    const encoded = command(['D:/x"y"', '']);
    for (const value of ['D:/x"y"', '', 'workflow-arg64:YWJj', '用户自由文本 $HOME "引号"']) {
      const marker = MARK + Buffer.from(value, 'utf8').toString('base64url');
      // 每个值都单独生成命令，确认它本身（而不是同批其他参数）触发了编码和开关。
      assert.ok(command([value]).includes(marker), `${JSON.stringify(value)} 未编码`);
      assert.ok(command([value]).includes(entryModule.TRANSPORT_FLAG), `${JSON.stringify(value)} 未带传输开关`);
      assert.equal(typeof entryModule.decodeArguments, 'function', '缺少命令行参数还原入口');
      assert.equal(entryModule.decodeArguments([marker])[0], value);
    }
    assert.ok(encoded.includes(MARK));
    // 没有需要编码的参数时不追加开关，命令形状保持原样。
    assert.ok(!command(['D:/plain/path']).includes(entryModule.TRANSPORT_FLAG));
    // 带开关时只还原标记；不带开关时同名字面文本不被改写。
    assert.equal(entryModule.transportArguments([MARK + Buffer.from('abc').toString('base64url'), entryModule.TRANSPORT_FLAG]).join(' '), 'abc');
    assert.equal(entryModule.transportArguments(['workflow-arg64:YWJj'])[0], 'workflow-arg64:YWJj');
  }
});

for (const item of SHELLS) {
  test(`${item.command} ${item.version}：真实 shell 下特殊参数逐字到达 Node 进程`, async t => {
    t.diagnostic(`shell=${item.command} version=${item.version}`);
    const area = await temporary('entry-shell-');
    const file = await recorder(area);
    const source = `node ${psQuote(file)} ${argumentPart(SPECIAL)}`;
    const result = shell(item, source, { cwd: area });
    const canary = await lstat(path.join(area, 'canary-q-w-b.txt')).catch(() => null);
    assert.equal(canary, null, '参数里的子表达式或命令不能被额外执行');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseJSON(result.stdout, item.command), EXPECTED, `${item.command} 的参数未逐字到达`);
  });

  test(`${item.command} ${item.version}：生成的 CLI 命令按原值传参`, async t => {
    t.diagnostic(`shell=${item.command} version=${item.version}`);
    const area = await temporary('entry-cli-');
    const state = path.join(area, 'state');
    for (const value of SPECIAL.filter(value => value !== '')) {
      const result = shell(item, command(['project', 'onboard', '--root', value], { stateDir: state }), { cwd: area });
      const parsed = parseJSON(result.stdout, `${item.command} ${JSON.stringify(value)}`);
      assert.equal(parsed.ok, false, JSON.stringify(parsed));
      assert.equal(parsed.error, 'ENOENT', `${JSON.stringify(value)} => ${JSON.stringify(parsed)}`);
      assert.ok(parsed.message.includes(path.resolve(area, value)), `${JSON.stringify(value)} 未原样到达 CLI：${parsed.message}`);
    }
    const canary = await lstat(path.join(area, 'canary-q-w-b.txt')).catch(() => null);
    assert.equal(canary, null, '参数里的子表达式或命令不能被额外执行');
  });

  test(`${item.command} ${item.version}：普通路径的生成命令可直接执行`, () => {
    const result = shell(item, command(['--help']));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('"usage"'), result.stdout);
  });
}

if (process.platform === 'win32' && !SHELLS.length) {
  test('未找到真实 PowerShell，参数往返未验证', { skip: 'powershell.exe 与 pwsh.exe 均不可用' }, () => {});
}

// 传输标记只是插件内部约定，不能把用户直接输入的同名文本当成编码值。
test('直接调用 CLI 时，与传输标记相同的字面参数保持原样', async () => {
  const f = await fixture();
  for (const literal of ['workflow-arg64:YWJj', 'workflow-arg64:']) {
    const result = cli(['signal', 'task-start', '--state-dir', f.directory, '--root', f.project, '--session', f.sessionId, '--turn', f.turnId, '--id', `s-${literal.length}`, '--task', 'task-1', '--route', 'lead-direct', '--goal', literal, '--mode', 'write', '--paths', 'README.md'], { cwd: f.project });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).workflow_signal.goal, literal);
  }
});

// 入口模块被 bin 之外的代码导入时，不得改写调用者自己的 process.argv。
test('导入 entry.mjs 不修改调用者的 process.argv', async () => {
  const area = await temporary('entry-import-');
  const file = path.join(area, 'importer.mjs');
  const url = pathToFileURL(path.join(root, 'src', 'entry.mjs')).href;
  await writeFile(file, `import ${JSON.stringify(url)};\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
  const args = ['workflow-arg64:YWJj', 'workflow-arg64:', 'plain'];
  const result = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, cwd: area });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});


// POSIX 保持原语义：单引号关闭-拼接-重开；本机为 Windows 时不冒充已验证。
test('POSIX shell 下特殊参数保持原语义', { skip: process.platform === 'win32' ? '仅在 POSIX 上生成 POSIX 命令' : false }, async () => {
  const area = await temporary('entry-posix-');
  const file = await recorder(area);
  const result = spawnSync('bash', ['-c', `node ${shQuote(file)} ${argumentPart(SPECIAL)}`], { encoding: 'utf8', cwd: area, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await lstat(path.join(area, 'canary-q-w-b.txt')).catch(() => null), null);
  assert.deepEqual(JSON.parse(result.stdout), EXPECTED);
});

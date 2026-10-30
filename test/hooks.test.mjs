import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { handleHook } from '../src/hooks.mjs';
import { taskKey } from '../src/protocol.mjs';
import { command } from '../src/entry.mjs';
import { mutate, readState, withLock } from '../src/store.mjs';
import { cli, deliver, emit, entry, event, fixture, git, gitFixture, identity, root, start, temporary } from './helpers.mjs';

test('P11 未接入目录不先核验发布副本，已接入项目仍按指纹拦截', async () => {
  const f = await fixture();
  const release = path.join(f.area, 'release');
  await mkdir(release, { recursive: true });
  await writeFile(path.join(release, 'entry.js'), '被修改的发布副本');
  await mutate(f.directory, async state => {
    state.install = { status: 'installed', releaseRoot: release, files: [{ path: 'entry.js', hash: '0'.repeat(64) }] };
  });
  const revision = (await readState(f.directory)).revision;
  const outside = path.join(f.area, 'outside');
  await mkdir(outside, { recursive: true });
  // 未接入目录：不读取发布副本、不写状态，也不声称维护不可用。
  assert.deepEqual(await handleHook(f.directory, { hook_event_name: 'UserPromptSubmit', cwd: outside, session_id: 'other-session', turn_id: 'turn-other' }), {});
  assert.equal((await readState(f.directory)).revision, revision);
  // 已接入项目：保守放行的提示仍在，校验没有被移除。
  const output = await handleHook(f.directory, { hook_event_name: 'UserPromptSubmit', cwd: f.project, session_id: f.sessionId, turn_id: 'turn-2' });
  assert.match(output.systemMessage || '', /发布副本指纹变化/);
});
test('V10 显式 null transcript 后台过滤，缺字段仍接受正常入口', async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  assert.deepEqual(await event(f, 'UserPromptSubmit', { transcript_path: null, session_id: 'background', turn_id: 'background-turn' }), {});
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
  assert.ok((await event(f, 'UserPromptSubmit', { session_id: 'foreground', turn_id: 'foreground-turn' })).hookSpecificOutput);
});
test('V13 其他插件、普通编辑/echo 输出不被当作本插件信号', async () => {
  const f = await fixture();
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'not-real', action: 'task-start', goal: '伪造', permissions: { mode: 'write', allowedPaths: [] } };
  for (const tool of [
    { tool_name: 'apply_patch', tool_input: { patch: 'workflow_signal' }, tool_response: { workflow_signal: payload } },
    { tool_name: 'Bash', tool_input: { command: 'echo workflow_signal' }, tool_response: { workflow_signal: payload } },
    { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` }, tool_response: { document_learning_signal: payload } },
    { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=; echo injected` }, tool_response: { workflow_signal: payload } },
  ]) await event(f, 'PostToolUse', tool);
  assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0);
});
// F02 直接后续：入口路径含 $ 或 $(...) 时 command() 生成的是单引号字面量，实际可以运行；
// PostToolUse 必须按同一字面量规则识别，不能把单引号内的 $ 当成 shell 展开。
test('入口路径含 $、$(...) 或空格时单引号 signal 命令仍被识别；可展开写法与组合命令仍拒绝', async () => {
  const entryAt = async location => {
    const file = path.join(location, 'bin', 'workflow.mjs');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '// 识别测试入口占位\n');
    return file;
  };
  const payloadAt = async (f, signalId) => ({ ...await identity(f), taskId: f.taskId, signalId, action: 'task-start', goal: '入口识别', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: ['README.md'] } });
  const post = (f, entryFile, invocation, payload) => handleHook(f.directory, {
    hook_event_name: 'PostToolUse', cwd: f.project, session_id: f.sessionId, turn_id: f.turnId,
    tool_name: 'PowerShell',
    tool_input: { command: invocation },
    tool_response: { stdout: JSON.stringify({ workflow_signal: payload }), stderr: '', interrupted: false },
  }, { synthetic: true, entry: entryFile });
  const receipt = output => {
    const text = output.hookSpecificOutput?.additionalContext || '';
    return text.startsWith('workflow 回执：') ? JSON.parse(text.slice('workflow 回执：'.length)) : null;
  };

  for (const name of ['plugin$HOME', 'plugin$(Write-Output canary)', 'plugin $HOME $(Write-Output canary)']) {
    const f = await fixture();
    const entryFile = await entryAt(path.join(f.area, name));
    const payload = await payloadAt(f, `literal-${name.length}`);
    const generated = command(['signal', 'task-start', '--session', f.sessionId, '--turn', f.turnId, '--id', payload.signalId], { cli: entryFile, stateDir: f.directory });
    assert.match(generated, /^node '/, generated);
    const result = receipt(await post(f, entryFile, generated, payload));
    assert.equal(result?.accepted, true, `${name}: ${JSON.stringify(result)}`);
  }

  // 引号外或双引号内的 $ 仍会展开；组合命令仍不属于单次直接调用。
  const f = await fixture();
  const entryFile = await entryAt(path.join(f.area, 'plugin$HOME'));
  const payload = await payloadAt(f, 'rejected');
  const slashed = entryFile.replaceAll('\\', '/');
  const forged = (await entryAt(path.join(f.area, 'other', 'plugin'))).replaceAll('\\', '/');
  const tail = `signal task-start --session ${f.sessionId} --turn ${f.turnId} --id rejected`;
  for (const [label, invocation] of [
    ['未引用 $', `node ${slashed} ${tail}`],
    ['双引号 $', `node "${slashed}" ${tail}`],
    ['额外命令', `node '${slashed}' ${tail}; echo injected`],
    ['管道', `node '${slashed}' ${tail} | more`],
    ['命令连接', `node '${slashed}' ${tail} && echo injected`],
    ['其他入口', `node '${forged}' ${tail}`],
  ]) {
    const output = await post(f, entryFile, invocation, payload);
    assert.equal(receipt(output), null, `${label} 不应回执：${JSON.stringify(output)}`);
    assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0, label);
  }
});
// F02 直接后续：分号、反引号、& 和单引号本身在 PowerShell 单引号内都是字面量；
// 识别时必须先解析引号，不能在任何引号出现前整条拒绝。
test('入口路径含分号、反引号或单引号时单引号 signal 命令仍被识别；引号外组合与伪造入口仍拒绝', async () => {
  const entryAt = async location => {
    const file = path.join(location, 'bin', 'workflow.mjs');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '// 识别测试入口占位\n');
    return file;
  };
  const payloadAt = async (f, signalId) => ({ ...await identity(f), taskId: f.taskId, signalId, action: 'task-start', goal: '入口识别', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: ['README.md'] } });
  const post = (f, entryFile, invocation, payload) => handleHook(f.directory, {
    hook_event_name: 'PostToolUse', cwd: f.project, session_id: f.sessionId, turn_id: f.turnId,
    tool_name: 'PowerShell',
    tool_input: { command: invocation },
    tool_response: { stdout: JSON.stringify({ workflow_signal: payload }), stderr: '', interrupted: false },
  }, { synthetic: true, entry: entryFile });
  const receipt = output => {
    const text = output.hookSpecificOutput?.additionalContext || '';
    return text.startsWith('workflow 回执：') ? JSON.parse(text.slice('workflow 回执：'.length)) : null;
  };

  for (const name of ['plugin;part', 'plugin`part', "plugin'part", 'plugin&part']) {
    const f = await fixture();
    const entryFile = await entryAt(path.join(f.area, name));
    const payload = await payloadAt(f, `literal-${name.length}`);
    const generated = command(['signal', 'task-start', '--session', f.sessionId, '--turn', f.turnId, '--id', payload.signalId], { cli: entryFile, stateDir: f.directory });
    assert.match(generated, /^node '/, generated);
    // 生成命令按 PowerShell 语法把内部单引号写成连续两个；识别时要还原成原路径。
    if (name.includes("'")) assert.match(generated, /''/, `${name}: ${generated}`);
    const result = receipt(await post(f, entryFile, generated, payload));
    assert.equal(result?.accepted, true, `${name}: ${JSON.stringify(result)}`);
  }

  // 引号外（或双引号内反引号转义）的分号、管道、命令连接仍是组合语法；伪造入口也仍拒绝。
  const f = await fixture();
  const entryFile = await entryAt(path.join(f.area, 'plugin;part'));
  const backtickEntry = await entryAt(path.join(f.area, 'plugin`part'));
  const forged = (await entryAt(path.join(f.area, 'other;part', 'plugin'))).replaceAll('\\', '/');
  const payload = await payloadAt(f, 'rejected');
  const slashed = entryFile.replaceAll('\\', '/');
  const backtickSlashed = backtickEntry.replaceAll('\\', '/');
  const tail = `signal task-start --session ${f.sessionId} --turn ${f.turnId} --id rejected`;
  for (const [label, invocation] of [
    ['未引用分号', `node ${slashed} ${tail}`],
    ['引号外分号', `node '${slashed}' ${tail}; echo injected`],
    ['引号外管道', `node '${slashed}' ${tail} | more`],
    ['引号外命令连接', `node '${slashed}' ${tail} && echo injected`],
    ['引号外反引号', `node '${slashed}' ${tail} \`echo injected`],
    ['引号外换行', `node '${slashed}' ${tail}\n echo injected`],
    ['双引号内反引号', `node "${backtickSlashed}" ${tail}`],
    ['其他入口', `node '${forged}' ${tail}`],
  ]) {
    const output = await post(f, entryFile, invocation, payload);
    assert.equal(receipt(output), null, `${label} 不应回执：${JSON.stringify(output)}`);
    assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0, label);
  }
});
test('V08 已知提问工具明确标 waiting-user，未知 payload 不猜完成', async () => {
  const f = await fixture();
  await start(f);
  await deliver(f);
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.deepEqual(await handleHook(f.directory, { hook_event_name: 'FutureUnknownEvent', cwd: f.project, session_id: f.sessionId, turn_id: f.turnId }), {});
});
test('真实 CLI signal 输出经过模型可见 output 包装后接收；命令本身不写状态', async () => {
  const f = await fixture();
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'cli-start', action: 'task-start', goal: 'CLI 链路', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: ['README.md'] } };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  const result = cli(['signal', '--base64', encoded]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
  const output = await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 ${encoded}` }, tool_response: { output: result.stdout } });
  assert.equal(JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 回执：'.length)).accepted, true);
});
// 真实 shell 运行 command() 生成的命令，再把同一事件交给真实 hook 入口（bin/workflow.mjs hook）：
// 入口复制到含 $HOME、$(...) 和空格的路径；若任一位置被展开，CLI 会找不到脚本或参数被改写。
test('真实 shell 执行含 $HOME/$(...) 入口的生成命令后，真实 hook 入口接受回执', { skip: process.platform !== 'win32' }, async () => {
  const shells = [
    ['powershell.exe 5.1', 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe'],
    ['pwsh.exe 7', 'C:/Program Files/PowerShell/7/pwsh.exe'],
  ].filter(([, file]) => existsSync(file));
  assert.ok(shells.length, '没有可用的 PowerShell');
  // 只复制运行 signal/hook 所需的最小产品；子表达式文本按字面量构造，不执行。
  const productArea = await temporary();
  const pluginRoot = path.join(productArea, 'plugin $HOME $(Write-Output canary)');
  await cp(path.join(root, 'bin'), path.join(pluginRoot, 'bin'), { recursive: true });
  await cp(path.join(root, 'src'), path.join(pluginRoot, 'src'), { recursive: true });
  await cp(path.join(root, 'package.json'), path.join(pluginRoot, 'package.json'));
  const copiedEntry = path.join(pluginRoot, 'bin', 'workflow.mjs');
  for (const [index, [label, shell]] of shells.entries()) {
    const f = await fixture({ claude: true });
    const id = await identity(f);
    const signalId = `e2e-${index}`;
    const goal = '入口 "引号" 与空格';
    const generated = command(['signal', 'task-start', '--session', f.sessionId, '--turn', id.turnId, '--id', signalId, '--task', `task-e2e-${index}`, '--route', 'lead-direct', '--goal', goal, '--mode', 'write', '--paths', 'README.md'], { cli: copiedEntry, stateDir: f.directory });
    assert.match(generated, /--workflow-arg64-transport/, `${label}: ${generated}`);
    const ran = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', generated], { cwd: f.project, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(ran.status, 0, `${label}: ${ran.stderr}`);
    const payload = JSON.parse(ran.stdout).workflow_signal;
    assert.equal(payload.signalId, signalId, label);
    assert.equal(payload.goal, goal, label);
    const hooked = spawnSync(process.execPath, [copiedEntry, 'hook', '--agent', 'claude', '--state-dir', f.directory], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse', cwd: f.project, session_id: f.sessionId, prompt_id: f.promptId,
        tool_name: 'PowerShell', tool_input: { command: generated },
        tool_response: { stdout: ran.stdout, stderr: ran.stderr, interrupted: false },
      }),
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(hooked.status, 0, `${label}: ${hooked.stderr}`);
    const text = JSON.parse(hooked.stdout).hookSpecificOutput?.additionalContext || '';
    assert.ok(text.startsWith('workflow 回执：'), `${label}: ${hooked.stdout}`);
    assert.equal(JSON.parse(text.slice('workflow 回执：'.length)).accepted, true, `${label}: ${text}`);
  }
});
// 真实 shell 执行单引号内的分号、反引号、单引号与子表达式文本，再把同一事件交给隔离的 Hook 入口。
// 生成命令不依赖传输编码：入口路径和 goal 都应按 PowerShell 单引号字面量原样到达。
test('真实 shell 执行含分号/反引号/单引号入口与字面目标的生成信号后，真实 hook 入口接受并保持原值', { skip: process.platform !== 'win32' }, async () => {
  const shells = [
    ['powershell.exe 5.1', 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe'],
    ['pwsh.exe 7', 'C:/Program Files/PowerShell/7/pwsh.exe'],
  ].filter(([, file]) => existsSync(file));
  assert.ok(shells.length, '没有可用的 PowerShell');
  const productArea = await temporary();
  const pluginRoot = path.join(productArea, "plugin;part`part'quote");
  await cp(path.join(root, 'bin'), path.join(pluginRoot, 'bin'), { recursive: true });
  await cp(path.join(root, 'src'), path.join(pluginRoot, 'src'), { recursive: true });
  await cp(path.join(root, 'package.json'), path.join(pluginRoot, 'package.json'));
  const copiedEntry = path.join(pluginRoot, 'bin', 'workflow.mjs');
  const goal = "预算 $100; 反引号 ` 与 $(Set-Content canary-q-w-b-signal.txt x) 及 '单引号'";
  for (const [index, [label, shell]] of shells.entries()) {
    const f = await fixture({ claude: true });
    const id = await identity(f);
    const signalId = `literal-e2e-${index}`;
    const generated = command(['signal', 'task-start', '--session', f.sessionId, '--turn', id.turnId, '--id', signalId, '--task', `task-literal-${index}`, '--route', 'lead-direct', '--goal', goal, '--mode', 'write', '--paths', 'README.md'], { cli: copiedEntry, stateDir: f.directory });
    assert.match(generated, /^node '/, `${label}: ${generated}`);
    // 没有双引号/空参数，生成命令只靠单引号字面量；内部单引号写成连续两个。
    assert.doesNotMatch(generated, /--workflow-arg64-transport/, `${label}: ${generated}`);
    assert.match(generated, /''/, `${label}: ${generated}`);
    const ran = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', generated], { cwd: f.project, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(ran.status, 0, `${label}: ${ran.stderr}`);
    assert.equal(existsSync(path.join(f.project, 'canary-q-w-b-signal.txt')), false, `${label}: 子表达式被执行`);
    const payload = JSON.parse(ran.stdout).workflow_signal;
    assert.equal(payload.goal, goal, label);
    const hooked = spawnSync(process.execPath, [copiedEntry, 'hook', '--agent', 'claude', '--state-dir', f.directory], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse', cwd: f.project, session_id: f.sessionId, prompt_id: f.promptId,
        tool_name: 'PowerShell', tool_input: { command: generated },
        tool_response: { stdout: ran.stdout, stderr: ran.stderr, interrupted: false },
      }),
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(hooked.status, 0, `${label}: ${hooked.stderr}`);
    const text = JSON.parse(hooked.stdout).hookSpecificOutput?.additionalContext || '';
    assert.ok(text.startsWith('workflow 回执：'), `${label}: ${hooked.stdout}`);
    assert.equal(JSON.parse(text.slice('workflow 回执：'.length)).accepted, true, `${label}: ${text}`);
    const task = Object.values((await readState(f.directory)).tasks)[0];
    assert.equal(task.goal, goal, label);
  }
});
// 引号外的 PowerShell 圆括号是表达式：PowerShell 先求值再把结果作为参数，命令文本却仍像单次直接调用。
// 识别必须按引号状态保守拒绝；单引号内的 ( ) ; 与反引号仍是字面值，不影响 command() 生成的命令。
test('引号外 PowerShell 圆括号表达式不被当作单次直接调用；单引号内的括号、分号与反引号仍是字面值', async () => {
  const entryAt = async location => {
    const file = path.join(location, 'bin', 'workflow.mjs');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '// 识别测试入口占位\n');
    return file;
  };
  const payloadAt = async (f, signalId, goal = '入口识别') => ({ ...await identity(f), taskId: f.taskId, signalId, action: 'task-start', goal, route: 'lead-direct', permissions: { mode: 'write', allowedPaths: ['README.md'] } });
  const post = (f, entryFile, invocation, payload) => handleHook(f.directory, {
    hook_event_name: 'PostToolUse', cwd: f.project, session_id: f.sessionId, turn_id: f.turnId,
    tool_name: 'PowerShell',
    tool_input: { command: invocation },
    tool_response: { stdout: JSON.stringify({ workflow_signal: payload }), stderr: '', interrupted: false },
  }, { synthetic: true, entry: entryFile });
  const receipt = output => {
    const text = output.hookSpecificOutput?.additionalContext || '';
    return text.startsWith('workflow 回执：') ? JSON.parse(text.slice('workflow 回执：'.length)) : null;
  };

  // 正例：单引号内的括号、分号与反引号由 command() 生成为字面量，仍属于单次直接调用。
  const literal = await fixture();
  const literalEntry = await entryAt(path.join(literal.area, 'plugin(字面)'));
  const literalGoal = '字面 (括号) 与 分号; 与 反引号`';
  const literalPayload = await payloadAt(literal, 'literal-parens', literalGoal);
  const literalCommand = command(['signal', 'task-start', '--session', literal.sessionId, '--turn', literal.turnId, '--id', literalPayload.signalId, '--goal', literalGoal], { cli: literalEntry, stateDir: literal.directory });
  assert.match(literalCommand, /'/, literalCommand);
  const accepted = receipt(await post(literal, literalEntry, literalCommand, literalPayload));
  assert.equal(accepted?.accepted, true, JSON.stringify(accepted));

  // 反例：引号外的 ( ) / @( ) 会先执行表达式；即使输出是合法信号也不能按直接调用接收。
  const f = await fixture();
  const entryFile = await entryAt(path.join(f.area, 'plugin(expr)'));
  const payload = await payloadAt(f, 'rejected-parens');
  const slashed = entryFile.replaceAll('\\', '/');
  const tail = `signal task-start --session ${f.sessionId} --turn ${f.turnId} --id rejected-parens`;
  for (const [label, invocation] of [
    ['圆括号表达式', `node '${slashed}' ${tail} --goal (Write-Output 'a;b')`],
    ['数组子表达式', `node '${slashed}' ${tail} --goal @(Write-Output 'a;b')`],
    ['无引号圆括号', `node '${slashed}' ${tail} --goal (Get-Date)`],
    ['参数位圆括号', `node '${slashed}' --state-dir '${f.directory}' ${tail} --goal (Write-Output 'a;b')`],
  ]) {
    const output = await post(f, entryFile, invocation, payload);
    assert.equal(receipt(output), null, `${label} 不应回执：${JSON.stringify(output)}`);
    assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0, label);
  }
});
// 真实 PowerShell 5.1/7 执行引号外圆括号表达式：表达式先求值，CLI 仍能生成合法信号；
// 同一命令交给隔离 hook 入口时必须拒绝，不能把表达式结果当作可直接接收的输入。
test('真实 PowerShell 执行引号外圆括号表达式后，隔离 hook 入口拒绝该命令', { skip: process.platform !== 'win32' }, async () => {
  const shells = [
    ['powershell.exe 5.1', 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe'],
    ['pwsh.exe 7', 'C:/Program Files/PowerShell/7/pwsh.exe'],
  ].filter(([, file]) => existsSync(file));
  assert.ok(shells.length, '没有可用的 PowerShell');
  const productArea = await temporary();
  const pluginRoot = path.join(productArea, 'plugin-paren');
  await cp(path.join(root, 'bin'), path.join(pluginRoot, 'bin'), { recursive: true });
  await cp(path.join(root, 'src'), path.join(pluginRoot, 'src'), { recursive: true });
  await cp(path.join(root, 'package.json'), path.join(pluginRoot, 'package.json'));
  const copiedEntry = path.join(pluginRoot, 'bin', 'workflow.mjs');
  for (const [index, [label, shell]] of shells.entries()) {
    const f = await fixture({ claude: true });
    const id = await identity(f);
    const signalId = `paren-e2e-${index}`;
    const slashedEntry = copiedEntry.replaceAll('\\', '/');
    const stateDir = f.directory.replaceAll('\\', '/');
    // --goal 位置是引号外的圆括号表达式；PowerShell 先执行 Write-Output，再把结果传给 node。
    const generated = `node '${slashedEntry}' signal task-start --session '${f.sessionId}' --turn '${id.turnId}' --id '${signalId}' --task 'task-paren-${index}' --route lead-direct --goal (Write-Output 'a;b') --mode write --paths README.md --state-dir '${stateDir}'`;
    const ran = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', generated], { cwd: f.project, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(ran.status, 0, `${label}: ${ran.stderr}`);
    const payload = JSON.parse(ran.stdout).workflow_signal;
    // goal 是表达式结果而不是字面文本，证明表达式确实在执行；CLI 侧仍会生成可接受形状的信号。
    assert.equal(payload.goal, 'a;b', label);
    assert.equal(payload.signalId, signalId, label);
    const hooked = spawnSync(process.execPath, [copiedEntry, 'hook', '--agent', 'claude', '--state-dir', f.directory], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse', cwd: f.project, session_id: f.sessionId, prompt_id: f.promptId,
        tool_name: 'PowerShell', tool_input: { command: generated },
        tool_response: { stdout: ran.stdout, stderr: ran.stderr, interrupted: false },
      }),
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(hooked.status, 0, `${label}: ${hooked.stderr}`);
    const text = JSON.parse(hooked.stdout).hookSpecificOutput?.additionalContext || '';
    assert.equal(text.startsWith('workflow 回执：'), false, `${label}: 不应回执 ${hooked.stdout}`);
    assert.match(text, /未接受/, `${label}: ${hooked.stdout}`);
    assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0, label);
  }
});
test('P01 入口短暂争用后有总预算等待，新会话最终持久化；预算耗尽只给恢复提示不冒充成功', async () => {
  const f = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withLock(f.directory, 'state', async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 30));
  const entered = event({ ...f, sessionId: 'session-contended', turnId: 'turn-contended' }, 'UserPromptSubmit');
  setTimeout(release, 200);
  const output = await entered;
  await holder;
  assert.ok(output.hookSpecificOutput?.additionalContext.startsWith('workflow 入口：'), JSON.stringify(output));
  const persisted = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === 'session-contended');
  assert.equal(persisted.turnId, 'turn-contended');
  assert.ok(persisted.ticket);
});
test('P01 入口拿不到身份时只给恢复提示，不输出入口成功也不建立猜测身份', async () => {
  const f = await fixture();
  const before = Object.keys((await readState(f.directory)).sessions).length;
  // SessionStart 没有宿主回合标识，也没有既有会话：本机不知道这是哪一回合。
  const output = await handleHook(f.directory, { hook_event_name: 'SessionStart', cwd: f.project, session_id: 'session-cold-start' }, { synthetic: true, entry });
  assert.equal(output.hookSpecificOutput.additionalContext.includes('workflow 入口：'), false);
  assert.match(output.hookSpecificOutput.additionalContext, /未建立入口身份/);
  assert.equal(Object.keys((await readState(f.directory)).sessions).length, before);
});
test('宿主模式在普通 PostToolUse 与入口更新，缺字段跨回合保留，旧回合和工具输出不能改模式', async () => {
  const f = await fixture();
  await start(f);
  const session = async () => Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  const revision = (await session()).revision;
  assert.deepEqual(await event(f, 'PostToolUse', { permission_mode: 'plan', tool_name: 'Read', tool_input: {}, tool_response: {} }), {});
  assert.equal((await session()).permissionMode, 'plan');
  assert.equal((await session()).revision, revision);
  await event(f, 'PostToolUse', { permission_mode: undefined, tool_name: 'Read', tool_response: { permission_mode: 'default' } });
  assert.equal((await session()).permissionMode, 'plan', '工具输出不是宿主模式来源');
  await event(f, 'PostToolUse', { turn_id: 'old-turn', permission_mode: 'default', tool_name: 'Read', tool_response: {} });
  assert.equal((await session()).permissionMode, 'plan', '旧回合事件不能改当前模式');
  f.turnId = 'turn-next';
  await event(f, 'UserPromptSubmit', { permission_mode: undefined });
  assert.equal((await session()).permissionMode, 'plan', '入口缺字段不能丢最近已知模式');
  await event(f, 'SessionStart', { permission_mode: 'read-only' });
  assert.equal((await session()).permissionMode, 'read-only', '同一回合入口也同步当前模式');
  await event(f, 'PostToolUse', { permission_mode: 'default', tool_name: 'Read', tool_response: {} });
  assert.equal((await session()).permissionMode, 'default');
});

test('P01 结束事件落盘失败如实报告，不把内存写入当作已持久化', async () => {
  const f = await fixture();
  await start(f);
  // 用同名文件占住 lifecycle-events 目录，令事件记录无法落盘。
  await writeFile(path.join(f.directory, 'lifecycle-events'), '故意占用目录名称');
  const output = await event(f, 'Interrupt');
  assert.match(output.systemMessage, /未能保存 Interrupt 事件记录/);
  assert.match(output.systemMessage, /仅尝试写入当前状态/);
});
test('P01 结束事件记录与状态锁同时失败时如实报告：既未落盘也未应用', async () => {
  const f = await fixture();
  await start(f);
  await writeFile(path.join(f.directory, 'lifecycle-events'), '故意占用目录名称');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withLock(f.directory, 'state', async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 30));
  const output = await event(f, 'Interrupt');
  release();
  await holder;
  assert.match(output.systemMessage, /未能保存 Interrupt 事件记录/);
  assert.match(output.systemMessage, /LOCKED/);
  assert.match(output.systemMessage, /事件未应用/);
  assert.doesNotMatch(output.systemMessage, /已另存为本机待办/);
});
test('未知会话与未知事件保守放行，不建立业务任务', async () => {
  const f = await fixture();
  for (const old of [
    { hook_event_name: 'SessionStart', cwd: f.project, session_id: 'unknown-session-1' },
    { hook_event_name: 'UserPromptSubmit', cwd: f.project, session_id: 'unknown-session-1', turn_id: 'unknown-turn-1' },
    { hook_event_name: 'FutureUnknownEvent', cwd: f.project, session_id: 'unknown-session-1' },
  ]) {
    const output = await handleHook(f.directory, old, { synthetic: true });
    assert.equal(output.decision, undefined);
  }
  assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0);
});
test('结构化提问自动记 waiting-user 且同一回合只改一次；未知工具不自动记', async () => {
  const phaseOf = async f => Object.values((await readState(f.directory)).sessions).find(s => s.sessionId === f.sessionId).phase;
  const revisionOf = async f => Object.values((await readState(f.directory)).sessions).find(s => s.sessionId === f.sessionId).revision;
  const f = await fixture();
  await start(f);
  const before = await revisionOf(f);
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.equal(await phaseOf(f), 'waiting-user');
  assert.equal(await revisionOf(f), before + 1);
  // 同一回合再次调用提问工具：状态已相同，不再产生第二次修改。
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.equal(await revisionOf(f), before + 1);

  // 已显式发过 waiting-user 时，提问工具不再重复修改。
  const g = await fixture();
  await start(g);
  await emit(g, { action: 'phase', phase: 'waiting-user' });
  const declared = await revisionOf(g);
  await event(g, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.equal(await revisionOf(g), declared);

  // 不认识的工具不自动记录。
  const h = await fixture();
  await start(h);
  const plain = await revisionOf(h);
  await event(h, 'PostToolUse', { tool_name: 'some_other_question_tool', tool_input: {}, tool_response: {} });
  assert.equal(await phaseOf(h), 'executing');
  assert.equal(await revisionOf(h), plain);
});
test('提问工具按宿主分表：原生与 Codeg MCP 名称置 waiting-user，跨宿主名称不误认', async () => {
  const { claudeEvent, claudeStart } = await import('./helpers.mjs');
  const phase = async f => Object.values((await readState(f.directory)).sessions).find(s => s.sessionId === f.sessionId).phase;
  for (const tool of ['request_user_input', 'request_user_input_async', 'mcp__codeg-mcp__ask_user_question', 'mcp__codeg_mcp__ask_user_question']) {
    const f = await fixture();
    await start(f);
    await event(f, 'PostToolUse', { tool_name: tool, tool_input: {}, tool_response: {} });
    assert.equal(await phase(f), 'waiting-user', tool);
  }
  for (const tool of ['AskUserQuestion', 'mcp__codeg-mcp__ask_user_question']) {
    const f = await fixture({ claude: true });
    await claudeStart(f);
    await claudeEvent(f, 'PostToolUse', { tool_name: tool, tool_input: {}, tool_response: {} });
    assert.equal(await phase(f), 'waiting-user', tool);
  }
  const codex = await fixture();
  await start(codex);
  await event(codex, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {} });
  assert.equal(await phase(codex), 'executing');
  const claude = await fixture({ claude: true });
  await claudeStart(claude);
  await claudeEvent(claude, 'PostToolUse', { tool_name: 'request_user_input', tool_input: {}, tool_response: {} });
  assert.equal(await phase(claude), 'executing');
});

// F05 隔离故障样本：用预加载替换 spec 检查里的 spawnSync，模拟 Git 变慢或卡住。
// 预加载只改 `--literal-pathspecs` 的调用（spec.mjs 专用），并记录真实传给 spawnSync 的 timeout。
// 卡住分支按 spawnSync 的契约在 options.timeout 后返回 ETIMEDOUT；整次检查还受总预算限制，
// 因此既能验证单次调用占满预算，也能验证多次慢调用不会累计超过宿主回执窗口。
async function slowGitPreload(f) {
  const file = path.join(f.area, 'slow-git.mjs');
  const log = path.join(f.area, 'git-timeout.log');
  await writeFile(file, [
    "import cp from 'node:child_process';",
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const real = cp.spawnSync.bind(cp);',
    'const delay = Number(process.env.SLOW_GIT_MS || 0);',
    'const hang = Number(process.env.SLOW_GIT_HANG_MS || 0);',
    'cp.spawnSync = (command, args = [], options = {}) => {',
    "  if (command !== 'git' || !Array.isArray(args) || !args.includes('--literal-pathspecs')) return real(command, args, options);",
    "  if (process.env.SLOW_GIT_LOG) fs.appendFileSync(process.env.SLOW_GIT_LOG, JSON.stringify({ timeout: options.timeout, args }) + '\\n');",
    '  if (hang > 0) {',
    '    const limit = Math.max(0, Math.min(hang, Number(options.timeout) || hang));',
    '    const until = Date.now() + limit;',
    '    while (Date.now() < until) {}',
    "    return { status: null, signal: null, error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };",
    '  }',
    "  real(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ' + delay + ')'], { windowsHide: true });",
    '  return real(command, args, options);',
    '};',
    'syncBuiltinESMExports();',
  ].join('\n'));
  return { file, log };
}
async function waitForGitLog(log, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await readFile(log, 'utf8').catch(() => '');
    if (raw.trim().split('\n').filter(Boolean).length >= count) return raw;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}
const gitCalls = log => readFile(log, 'utf8').then(raw => raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
async function specTaskFixture() {
  const f = await gitFixture();
  await mkdir(path.join(f.project, 'src'), { recursive: true });
  await writeFile(path.join(f.project, 'src', 'app.mjs'), 'export const app = 1;\n');
  await mkdir(path.join(f.project, '.spec', 'app'), { recursive: true });
  await writeFile(path.join(f.project, '.spec', 'app', 'spec.md'), '---\ntitle: app\ncode:\n  - src/app.mjs\n---\n# app\n');
  git(f.project, ['add', '-A']);
  git(f.project, ['commit', '-q', '-m', 'add spec']);
  await start(f);
  return f;
}
function taskEndEvent(f, payload) {
  return {
    hook_event_name: 'PostToolUse', cwd: f.project, session_id: f.sessionId, turn_id: f.turnId, permission_mode: 'default',
    tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` },
    tool_response: { output: JSON.stringify({ workflow_signal: payload }) },
  };
}
function spawnHook(f, hookEvent, env, timeoutMs) {
  // 注入用 NODE_OPTIONS 必须叠加在外部删除保护适配器之后，不能覆盖既有 --import。
  const nodeOptions = [process.env.NODE_OPTIONS, env?.NODE_OPTIONS].filter(Boolean).join(' ');
  const child = spawn(process.execPath, [entry, 'hook', '--state-dir', f.directory, '--agent', 'codex'], {
    env: { ...process.env, ...env, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(hookEvent));
  const started = Date.now();
  const done = new Promise((resolve, reject) => {
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.on('error', reject);
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); resolve({ code, signal, stdout, stderr, elapsed: Date.now() - started }); });
  });
  return { child, done };
}
async function waitForHold(f, timeoutMs) {
  const locks = path.join(f.directory, 'locks');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await readdir(locks).catch(() => []);
    const hold = names.find(name => name.endsWith('.hold'));
    if (hold) return path.join(locks, hold);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}
function hookReceipt(stdout) {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  try {
    const text = JSON.parse(line).hookSpecificOutput?.additionalContext || '';
    return text.startsWith('workflow 回执：') ? JSON.parse(text.slice('workflow 回执：'.length)) : null;
  } catch { return null; }
}

test('F05 spec 慢 Git 在状态锁外预检：竞争会话不被阻塞，Hook 仍返回回执', async t => {
  const f = await specTaskFixture();
  const { file: preload, log } = await slowGitPreload(f);
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'signal-slow-git', action: 'task-end' };
  const { done } = spawnHook(f, taskEndEvent(f, payload), {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    SLOW_GIT_MS: '350',
    SLOW_GIT_LOG: log,
  });
  assert.ok(await waitForGitLog(log, 1, 5000), '慢 Git 预检应已开始');
  // 预检在状态锁外：此刻没有持有票据，竞争会话可以立即用短预算取得状态锁。
  assert.equal(await waitForHold(f, 200), null, '慢 Git 预检期间不应持有状态锁');
  const waitStarted = Date.now();
  assert.equal(await withLock(f.directory, 'state', async () => 'ok', { budgetMs: 1200 }), 'ok');
  const waited = Date.now() - waitStarted;
  assert.ok(waited < 1000, `竞争调用应在短预算内取得状态锁：${waited}ms`);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(hookReceipt(result.stdout)?.accepted, true, result.stdout);
  assert.ok(result.elapsed >= 1800, `Hook 应容纳多次慢 Git 预检：${result.elapsed}ms`);
  assert.ok(result.elapsed < 9000, `Hook 应在宿主 10 秒上限前返回：${result.elapsed}ms`);
  const locks = await readdir(path.join(f.directory, 'locks')).catch(() => []);
  assert.ok(!locks.some(name => name.endsWith('.hold')), 'Hook 退出后不应留下持有票据');
  const calls = await gitCalls(log);
  assert.ok(calls.length >= 6, `spec 检查应发生多次 Git 调用：${calls.length}`);
  assert.ok(calls.every(call => call.timeout > 0 && call.timeout <= 10000), `单次 Git 超时应落在 10 秒内：${JSON.stringify(calls.map(call => call.timeout))}`);
  t.diagnostic(`Hook ${result.elapsed}ms；预检期间竞争调用 ${waited}ms 取得锁；spec Git ${calls.length} 次，单次 timeout 上限 ${Math.max(...calls.map(call => call.timeout))}ms`);
});

test('F05 Git 卡住时总检查预算有界：宿主超时前返回拒绝回执，状态不半应用', async t => {
  const f = await specTaskFixture();
  const { file: preload, log } = await slowGitPreload(f);
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'signal-hung-git', action: 'task-end' };
  const before = await readState(f.directory);
  const { done } = spawnHook(f, taskEndEvent(f, payload), {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    SLOW_GIT_HANG_MS: '15000',
    SLOW_GIT_LOG: log,
  });
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.elapsed >= 3000, `应实际消耗检查预算而非立即跳过：${result.elapsed}ms`);
  assert.ok(result.elapsed < 9500, `必须在宿主 10 秒终止前返回：${result.elapsed}ms`);
  const receipt = hookReceipt(result.stdout);
  assert.equal(receipt?.accepted, false, result.stdout);
  assert.equal(receipt?.reason, 'GATE');
  assert.ok(receipt.missing.includes('spec-check:git'), JSON.stringify(receipt));
  const after = await readState(f.directory);
  const sessionOf = state => Object.values(state.sessions).find(session => session.sessionId === f.sessionId);
  assert.equal(after.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  assert.equal(after.tasks[taskKey(f.projectId, f.taskId)].validation, undefined);
  assert.equal(sessionOf(after).revision, sessionOf(before).revision, '被拒绝的 task-end 不应留下部分状态');
  const locks = await readdir(path.join(f.directory, 'locks')).catch(() => []);
  assert.ok(!locks.some(name => name.endsWith('.hold')), '正常返回后不应留下持有票据');
  const calls = await gitCalls(log);
  assert.ok(calls.length >= 1 && calls.every(call => call.timeout > 0 && call.timeout <= 10000), JSON.stringify(calls.map(call => call.timeout)));
  t.diagnostic(`Hook 在 ${result.elapsed}ms 返回 GATE 拒绝回执；spec Git ${calls.length} 次；单次 timeout=${calls.map(call => call.timeout).join(',')}ms`);
});

test('F05 多次慢 Git 不累计耗尽宿主回执：总预算内返回，调用次数有界', async t => {
  const f = await specTaskFixture();
  const { file: preload, log } = await slowGitPreload(f);
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'signal-many-slow', action: 'task-end' };
  const { done } = spawnHook(f, taskEndEvent(f, payload), {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    SLOW_GIT_MS: '1500',
    SLOW_GIT_LOG: log,
  });
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.elapsed < 9000, `多次慢 Git 不能累计到宿主 10 秒上限：${result.elapsed}ms`);
  const receipt = hookReceipt(result.stdout);
  assert.equal(receipt?.accepted, false, result.stdout);
  assert.ok(receipt.missing.includes('spec-check:git'), JSON.stringify(receipt));
  const calls = await gitCalls(log);
  assert.ok(calls.length >= 1 && calls.length <= 5, `总预算应限制 Git 调用次数：${calls.length}`);
  assert.ok(calls.every(call => call.timeout > 0 && call.timeout <= 10000));
  t.diagnostic(`Hook 在 ${result.elapsed}ms 耗尽总预算返回 GATE；spec Git ${calls.length} 次，timeout=${calls.map(call => call.timeout).join(',')}ms`);
});

// 正常并发：另一个会话在锁外预检的 status 之后改动受管文件。锁内只复核绑定（一次有界 rev-parse + 文件快照），
// 发现检查对象已变化就按过期拒绝，不把干净预检当成当前结果，也不在锁内重跑 status/log/rev-list。
async function concurrentChangeAfterStatus(f, log, hookEvent, env) {
  const { done } = spawnHook(f, hookEvent, { NODE_OPTIONS: `--import=${pathToFileURL(env.preload).href}`, SLOW_GIT_MS: '350', SLOW_GIT_LOG: log });
  // spec 检查按 shallow、rev-parse、log、status、rev-list… 顺序同步调用；第 5 次调用开始时 status 已返回。
  assert.ok(await waitForGitLog(log, 5, 8000), '预检应已越过 status 并继续后续 Git 调用');
  await writeFile(path.join(f.project, 'src', 'app.mjs'), 'export const app = 2;\n');
  return done;
}
function lastHookJSON(stdout) {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  try { return JSON.parse(line); } catch { return null; }
}
test('F05 预检期间正常并发改动受管文件：task-end 按过期拒绝，锁内不重跑慢 Git', async t => {
  const f = await specTaskFixture();
  const { file: preload, log } = await slowGitPreload(f);
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'signal-concurrent-task-end', action: 'task-end' };
  const result = await concurrentChangeAfterStatus(f, log, taskEndEvent(f, payload), { preload });
  assert.equal(result.code, 0, result.stderr);
  const receipt = hookReceipt(result.stdout);
  assert.equal(receipt?.accepted, false, result.stdout);
  assert.equal(receipt?.reason, 'GATE', result.stdout);
  assert.deepEqual(receipt.missing, ['spec-check:stale'], result.stdout);
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  const calls = await gitCalls(log);
  // 预检只跑一轮 status/log/rev-list；锁内复核不得新增这些慢调用，只允许最后一次有界 ref 解析。
  assert.equal(calls.filter(call => call.args.includes('status')).length, 1, 'status 只应由锁外预检调用一次');
  assert.equal(calls.filter(call => call.args.includes('log')).length, 1, 'log 只应由锁外预检调用一次');
  assert.equal(calls.filter(call => call.args.includes('rev-list')).length, 2, 'rev-list 只应由锁外预检调用');
  assert.ok(calls.at(-1)?.args.includes('rev-parse') && calls.at(-1).timeout <= 1000, `锁内复核只做一次有界 ref 解析：${JSON.stringify(calls.at(-1))}`);
  t.diagnostic(`task-end 在 ${result.elapsed}ms 按过期拒绝；最后一次 Git 调用 ${JSON.stringify([calls.at(-1).args.at(-1), calls.at(-1).timeout])}`);
});
test('F05 预检期间正常并发改动受管文件：Stop 明确无法确认，不报门禁无缺项', async t => {
  const f = await specTaskFixture();
  const { file: preload, log } = await slowGitPreload(f);
  const stopEvent = { hook_event_name: 'Stop', cwd: f.project, session_id: f.sessionId, turn_id: f.turnId, permission_mode: 'default' };
  const result = await concurrentChangeAfterStatus(f, log, stopEvent, { preload });
  assert.equal(result.code, 0, result.stderr);
  const output = lastHookJSON(result.stdout);
  assert.equal(output?.decision, 'block', result.stdout);
  assert.match(output.reason, /spec 检查无法确认/);
  assert.match(output.reason, /spec-check:stale/);
  assert.doesNotMatch(output.reason, /门禁已无缺项/);
  t.diagnostic(`Stop 在 ${result.elapsed}ms 明确无法确认：${output.reason.slice(0, 80)}…`);
});

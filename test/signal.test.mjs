import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mutate, readState } from '../src/store.mjs';
import { buildSignal } from '../src/signal.mjs';
import { sessionKey } from '../src/protocol.mjs';
import { resolveProject } from '../src/projects.mjs';
import { cli, emit, entry, event, fixture, start } from './helpers.mjs';

// 便捷子命令：CLI 只读状态拼 payload，交给 PostToolUse 接受；返回 CLI 结果与 hook 回执。
function build(f, action, args = [], session = f) {
  return cli(['signal', action, '--state-dir', f.directory, '--root', f.project, '--session', session.sessionId, '--turn', session.turnId, ...args]);
}
const quote = value => /\s/.test(value) ? `"${value}"` : value;
async function acceptCommand(f, action, args, commandArgs, session = f) {
  const run = build(f, action, args, session);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const command = `node "${entry}" signal ${action} --session ${session.sessionId} --turn ${session.turnId} ${commandArgs}`;
  const output = await event({ ...f, sessionId: session.sessionId, turnId: session.turnId }, 'PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { output: run.stdout } });
  const text = output.hookSpecificOutput?.additionalContext;
  assert.ok(text?.startsWith('workflow 回执：'), JSON.stringify(output));
  return { payload: JSON.parse(run.stdout).workflow_signal, receipt: JSON.parse(text.slice('workflow 回执：'.length)) };
}
async function accept(f, action, args, session = f) {
  return acceptCommand(f, action, args, args.map(quote).join(' '), session);
}
const startArgs = (id, extra = []) => ['--id', id, '--task', 'task-1', '--route', 'lead-direct', '--goal', '便捷 信号', '--mode', 'write', '--paths', 'README.md', ...extra];

test('lead-direct 两条子命令完成任务；CLI 本身不写状态', async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  const run = build(f, 'task-start', startArgs('s1'));
  assert.equal(run.status, 0, run.stdout);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
  const started = await accept(f, 'task-start', startArgs('s1'));
  assert.equal(started.receipt.accepted, true, JSON.stringify(started));
  assert.deepEqual(started.payload.permissions, { mode: 'write', allowedPaths: ['README.md'] });
  const ended = await accept(f, 'task-end', ['--id', 'e1']);
  assert.equal(ended.receipt.accepted, true, JSON.stringify(ended));
  const task = Object.values((await readState(f.directory)).tasks)[0];
  assert.equal(task.lifecycle, 'complete');
  assert.equal(task.route, 'lead-direct');
});
test('新任务漏填 --route 经真实 PostToolUse 被拒；历史任务续接不填 route 仍可继续', async () => {
  const f = await fixture();
  const missing = await accept(f, 'task-start', ['--id', 's1', '--task', 'task-1', '--goal', '漏填分流', '--mode', 'write', '--paths', 'README.md']);
  assert.equal(missing.receipt.accepted, false, JSON.stringify(missing.receipt));
  assert.equal(missing.receipt.reason, 'ROUTE');
  assert.equal(Object.keys((await readState(f.directory)).tasks).length, 0);
  const started = await accept(f, 'task-start', startArgs('s2'));
  assert.equal(started.receipt.accepted, true, JSON.stringify(started.receipt));
  const [key] = Object.keys((await readState(f.directory)).tasks);
  // 旧版本写出的任务没有 route 字段；续接不能按新任务要求补填。
  await mutate(f.directory, async state => { delete state.tasks[key].route; });
  const continued = await accept(f, 'task-start', ['--id', 's3', '--task', 'task-1']);
  assert.equal(continued.receipt.accepted, true, JSON.stringify(continued.receipt));
  assert.equal(continued.receipt.kept.goal, '便捷 信号');
  assert.equal((await readState(f.directory)).tasks[key].route, undefined);
});
test('同 signalId 重试输出相同正文并命中回执；改正文返回 SIGNAL_ID', async () => {
  const f = await fixture();
  const first = await accept(f, 'task-start', startArgs('s1'));
  // 中间状态又变化一次，重放仍要复原首次的 expectedRevision。
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: {}, tool_response: {} });
  const again = await accept(f, 'task-start', startArgs('s1'));
  assert.deepEqual(again.payload, first.payload);
  assert.equal(again.receipt.replayed, true);
  const changed = await accept(f, 'task-start', startArgs('s1', ['--plans', 'docs/a.md']));
  assert.equal(changed.receipt.accepted, false);
  assert.equal(changed.receipt.reason, 'SIGNAL_ID');
});
test('读写之间 revision 变化被拒；回合过期、中断、未知会话在 CLI 直接报错', async () => {
  const f = await fixture();
  const run = build(f, 'task-start', startArgs('s1'));
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: {}, tool_response: {} });
  const output = await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal task-start --id s1` }, tool_response: { output: run.stdout } });
  const receipt = JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 回执：'.length));
  assert.equal(receipt.reason, 'REVISION');
  const stale = build({ ...f, turnId: 'turn-old' }, 'task-start', startArgs('s2'));
  assert.equal(JSON.parse(stale.stdout).error, 'STALE');
  const unknown = build({ ...f, sessionId: 'nobody' }, 'task-start', startArgs('s3'));
  assert.equal(JSON.parse(unknown.stdout).error, 'IDENTITY');
  await event(f, 'Interrupt');
  assert.equal(JSON.parse(build(f, 'task-start', startArgs('s4')).stdout).error, 'STALE');
});
test('并发两个会话各自补齐自己的身份，互不串用', async () => {
  const f = await fixture();
  const other = { sessionId: 'session-2', turnId: 'turn-9' };
  await event({ ...f, ...other }, 'UserPromptSubmit');
  const a = await accept(f, 'task-start', startArgs('a1'));
  const b = await accept(f, 'task-start', ['--id', 'b1', '--task', 'task-2', '--route', 'lead-direct', '--goal', '另一个', '--mode', 'read-only'], other);
  assert.equal(a.receipt.accepted && b.receipt.accepted, true);
  assert.notEqual(a.payload.ticket, b.payload.ticket);
  assert.equal(b.payload.sessionId, 'session-2');
});
test('packages 便捷参数完成单包派发/消费/审查，经真实 PostToolUse 写入账本', async () => {
  const f = await fixture();
  await start(f);
  const dispatched = await accept(f, 'packages', ['--id', 'p1', '--package', 'w1', '--role', 'worker', '--status', 'dispatched', '--channel', 'codeg:claude_code', '--handle', 'task-9', '--depends-on', 'w0', '--base-ref', 'abc123']);
  assert.equal(dispatched.receipt.accepted, true, JSON.stringify(dispatched));
  const task = async () => Object.values((await readState(f.directory)).tasks)[0];
  assert.deepEqual(
    { role: (await task()).packages.w1.role, status: (await task()).packages.w1.status, channel: (await task()).packages.w1.channel, handle: (await task()).packages.w1.handle, dependsOn: (await task()).packages.w1.dependsOn, baseRef: (await task()).packages.w1.baseRef },
    { role: 'worker', status: 'dispatched', channel: 'codeg:claude_code', handle: 'task-9', dependsOn: ['w0'], baseRef: 'abc123' },
  );
  // 消费时不重复 --role：--ref 按已有包角色落到 deliveredRef。
  const consumed = await accept(f, 'packages', ['--id', 'p2', '--package', 'w1', '--status', 'consumed', '--ref', 'def456']);
  assert.equal(consumed.receipt.accepted, true, JSON.stringify(consumed));
  assert.equal((await task()).packages.w1.deliveredRef, 'def456');
  const review = await accept(f, 'packages', ['--id', 'p3', '--package', 'r1', '--role', 'reviewer', '--status', 'dispatched', '--channel', 'codeg:codex', '--reviews', 'w1', '--handle', 'task-10']);
  assert.equal(review.receipt.accepted, true, JSON.stringify(review));
  const pass = await accept(f, 'packages', ['--id', 'p4', '--package', 'r1', '--status', 'consumed', '--verdict', 'PASS', '--ref', 'def456']);
  assert.equal(pass.receipt.accepted, true, JSON.stringify(pass));
  assert.deepEqual(
    { reviews: (await task()).packages.r1.reviews, reviewedRef: (await task()).packages.r1.reviewedRef, verdict: (await task()).packages.r1.verdict },
    { reviews: 'w1', reviewedRef: 'def456', verdict: 'PASS' },
  );
});
test('task-end 便捷 validation 用 --final-ref 补 ref，证据可重复给出', async () => {
  const f = await fixture();
  await start(f);
  const ended = await accept(f, 'task-end', ['--id', 'e1', '--final-ref', 'abc123', '--evidence', 'npm test 250/250 通过', '--evidence', 'npm run check 0 错误']);
  assert.equal(ended.receipt.accepted, true, JSON.stringify(ended));
  const task = Object.values((await readState(f.directory)).tasks)[0];
  assert.equal(task.lifecycle, 'complete');
  assert.equal(task.finalRef, 'abc123');
  assert.deepEqual(task.validation, { ref: 'abc123', evidence: ['npm test 250/250 通过', 'npm run check 0 错误'] });
  // 与 --input 同字段冲突、缺 ref、两个 ref 不一致都返回 INPUT，不静默覆盖。
  const file = path.join(f.area, 'validation.json');
  await writeFile(file, JSON.stringify({ validation: { ref: 'other', evidence: ['旧证据'] } }));
  assert.equal(JSON.parse(build(f, 'task-end', ['--id', 'e2', '--validation-ref', 'abc123', '--input', file]).stdout).error, 'INPUT');
  assert.equal(JSON.parse(build(f, 'task-end', ['--id', 'e3', '--evidence', '仅有证据']).stdout).error, 'INPUT');
  assert.equal(JSON.parse(build(f, 'task-end', ['--id', 'e4', '--validation-ref', 'abc123', '--final-ref', 'def456']).stdout).error, 'INPUT');
});
test('便捷字段用错动作由 CLI 返回 INPUT；合法字面值中的 shell 元字符不再被参数层误拒', async () => {
  const f = await fixture();
  await start(f);
  const misplaced = [
    [['--id', 'x1', '--package', 'w1', '--status', 'dispatched', '--validation-ref', 'abc123'], '--validation-ref'],
    [['--id', 'x2', '--final-ref', 'abc123', '--evidence', 'x', '--status', 'dispatched'], '--status'],
  ];
  for (const [args, field] of misplaced) {
    const action = args.includes('--final-ref') ? 'task-end' : 'packages';
    const result = JSON.parse(build(f, action, args).stdout);
    assert.equal(result.error, 'INPUT', `${field}: ${result.message}`);
    assert.match(result.message, new RegExp(field));
  }
  // 这些字符在 PowerShell 单引号内是普通字面量；CLI 只拼 payload，不再把自由文本误判成组合命令。
  for (const [action, args, field, value] of [
    ['packages', ['--id', 'x3', '--package', 'w1', '--role', 'worker', '--status', 'dispatched', '--note', 'a|b'], 'note', 'a|b'],
    ['packages', ['--id', 'x4', '--package', 'w1', '--role', 'worker', '--status', 'dispatched', '--handle', 'a&b'], 'handle', 'a&b'],
    ['task-end', ['--id', 'x5', '--final-ref', 'abc123', '--evidence', 'a;b'], 'evidence', 'a;b'],
    ['packages', ['--id', 'x6', '--package', 'w1', '--role', 'worker', '--status', 'dispatched', '--note', 'a -> b'], 'note', 'a -> b'],
  ]) {
    const built = JSON.parse(build(f, action, args).stdout);
    assert.equal(built.error, undefined, `${value}: ${built.message}`);
    const payload = built.workflow_signal;
    assert.equal(action === 'packages' ? payload.packages[0][field] : payload.validation.evidence[0], value);
  }
  // 没有 --package 就只给包字段、或没有任何包字段，都直接报错。
  assert.equal(JSON.parse(build(f, 'packages', ['--id', 'x7', '--status', 'dispatched']).stdout).error, 'INPUT');
  assert.equal(JSON.parse(build(f, 'packages', ['--id', 'x8', '--package', 'w1']).stdout).error, 'INPUT');
  // 新包用 --ref 但没给角色，无法判断写 deliveredRef 还是 reviewedRef。
  assert.equal(JSON.parse(build(f, 'packages', ['--id', 'x9', '--package', 'new1', '--status', 'dispatched', '--ref', 'abc123']).stdout).error, 'INPUT');
});
test('packages 便捷字段缺 --package 时返回 INPUT，--input 批量载荷不被改写', async () => {
  const f = await fixture();
  await start(f);
  const before = JSON.stringify(await readState(f.directory));
  const file = path.join(f.area, 'multi.json');
  await writeFile(file, JSON.stringify({ packages: [
    { packageId: 'w1', role: 'worker', status: 'dispatched' },
    { packageId: 'w2', role: 'worker', status: 'dispatched' },
  ] }));
  const status = JSON.parse(build(f, 'packages', ['--id', 'm1', '--input', file, '--status', 'consumed']).stdout);
  assert.equal(status.error, 'INPUT');
  assert.match(status.message, /--status/);
  assert.match(status.message, /--package/);
  assert.match(status.message, /--input/);
  // 只给 --role 也同样拒绝，而不是按批量载荷静默丢弃。
  const role = JSON.parse(build(f, 'packages', ['--id', 'm2', '--input', file, '--role', 'worker']).stdout);
  assert.equal(role.error, 'INPUT');
  assert.match(role.message, /--role/);
  assert.equal(JSON.stringify(await readState(f.directory)), before);
});
test('task-start/phase/task-end 收到包字段也返回 INPUT，不再静默丢弃', async () => {
  const f = await fixture();
  await start(f);
  const before = JSON.stringify(await readState(f.directory));
  const cases = [
    ['task-start', startArgs('s2', ['--status', 'dispatched'])],
    ['task-start', startArgs('s3', ['--package', 'w1'])],
    ['phase', ['--id', 'ph1', '--phase', 'executing', '--role', 'worker']],
    ['task-end', ['--id', 'te1', '--final-ref', 'abc123', '--package', 'w1']],
    ['task-end', ['--id', 'te2', '--final-ref', 'abc123', '--verdict', 'PASS']],
  ];
  for (const [action, args] of cases) {
    const result = JSON.parse(build(f, action, args).stdout);
    assert.equal(result.error, 'INPUT', `${action} ${args.join(' ')}: ${result.message}`);
  }
  assert.equal(JSON.stringify(await readState(f.directory)), before);
});
test('中文、引号和旧接口命令文本经 PostToolUse 正常接受', async () => {
  const f = await fixture();
  await start(f);
  // 双引号在单引号参数内是普通字符；全角标点不触发 shell 元字符拒绝。
  const note = '中文说明，"引号" 与逗号，不是组合命令';
  const sent = await acceptCommand(f, 'packages', ['--id', 'q1', '--package', 'wq', '--role', 'worker', '--status', 'dispatched', '--note', note], `--id q1 --package wq --role worker --status dispatched --note '${note}'`);
  assert.equal(sent.receipt.accepted, true, JSON.stringify(sent));
  assert.equal(Object.values((await readState(f.directory)).tasks)[0].packages.wq.note, note);
  // 旧接口：同批多个包与中文说明继续用 --input；--base64 仍可用。
  const file = path.join(f.area, 'legacy.json');
  await writeFile(file, JSON.stringify({ packages: [
    { packageId: 'w1', role: 'worker', status: 'dispatched', handle: 'h1', channel: 'codeg:claude_code', note: '旧接口："引号" 与中文' },
    { packageId: 'w2', role: 'worker', status: 'dispatched', handle: 'h2' },
  ] }));
  const batch = await accept(f, 'packages', ['--id', 'q2', '--input', file]);
  assert.equal(batch.receipt.accepted, true, JSON.stringify(batch));
  const encoded = Buffer.from(JSON.stringify({ packages: [{ packageId: 'w1', status: 'consumed', deliveredRef: 'abc123' }] })).toString('base64');
  const consumed = await accept(f, 'packages', ['--id', 'q3', '--base64', encoded]);
  assert.equal(consumed.receipt.accepted, true, JSON.stringify(consumed));
  const state = await readState(f.directory);
  assert.equal(Object.values(state.tasks)[0].packages.w2.status, 'dispatched');
  assert.equal(Object.values(state.tasks)[0].packages.w1.deliveredRef, 'abc123');
});
test('自由文本字面值经 CLI、单引号命令和 Hook 回执保持原样，JSON 与传输标记不被误解码', async () => {
  const f = await fixture();
  await start(f);
  // 同时覆盖 $、ASCII 分号、反引号、子表达式文本、单引号、JSON 双引号和传输标记同名文本。
  const goal = '预算 $100; 反引号 ` 与 $(Write-Output canary) 及 \'单引号\' {"workflow_signal":true} workflow-arg64:YWJj';
  const run = build(f, 'task-update', ['--id', 'literal-1', '--goal', goal]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const payload = JSON.parse(run.stdout).workflow_signal;
  assert.equal(payload.goal, goal);
  // 用户按 PowerShell 单引号语法书写：内部单引号加倍；命令里的 $、反引号、分号和 JSON 都按字面值到达。
  const psQuote = value => `'${value.replaceAll("'", "''")}'`;
  const invocation = `node "${entry}" signal task-update --session ${f.sessionId} --turn ${f.turnId} --id literal-1 --goal ${psQuote(goal)}`;
  const output = await event(f, 'PostToolUse', {
    tool_name: 'PowerShell', tool_input: { command: invocation },
    tool_response: { stdout: run.stdout, stderr: '', interrupted: false },
  });
  const text = output.hookSpecificOutput?.additionalContext || '';
  assert.ok(text.startsWith('workflow 回执：'), JSON.stringify(output));
  const receipt = JSON.parse(text.slice('workflow 回执：'.length));
  assert.equal(receipt.accepted, true, JSON.stringify(receipt));
  assert.equal(receipt.goal, goal);
  assert.equal(Object.values((await readState(f.directory)).tasks)[0].goal, goal);
});
test('便捷命令跨会话、组合命令和非本插件入口的伪造输出仍拒绝', async () => {
  const f = await fixture();
  await start(f);
  const other = { sessionId: 'session-2', turnId: 'turn-9' };
  await event({ ...f, ...other }, 'UserPromptSubmit');
  const run = build(f, 'packages', ['--id', 'x1', '--package', 'w1', '--role', 'worker', '--status', 'dispatched']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const output = await event({ ...f, ...other }, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal packages --session ${f.sessionId} --turn ${f.turnId} --id x1 --package w1 --role worker --status dispatched` }, tool_response: { output: run.stdout } });
  assert.match(output.hookSpecificOutput.additionalContext, /不属于当前宿主会话/);
  const fake = run.stdout;
  const composed = await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal packages --id x2 --package w1 --role worker --status dispatched && echo ok` }, tool_response: { output: JSON.stringify({ workflow_signal: JSON.parse(fake).workflow_signal }) } });
  assert.match(composed.hookSpecificOutput.additionalContext, /未接受/);
  const foreign = await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'node "/tmp/not-plugin/bin/workflow.mjs" signal packages --id x3 --package w1 --role worker --status dispatched' }, tool_response: { output: JSON.stringify({ workflow_signal: JSON.parse(fake).workflow_signal }) } });
  assert.match(foreign.hookSpecificOutput.additionalContext, /未接受/);
  assert.equal(Object.values((await readState(f.directory)).tasks)[0].packages.w1, undefined);
});
test('packages 用 --input 只放结构化字段；带身份字段或缺 packages 被拒；未知动作被拒', async () => {
  const f = await fixture();
  await start(f);
  const { writeFile } = await import('node:fs/promises');
  const file = path.join(f.area, 'pkg.json');
  await writeFile(file, JSON.stringify({ packages: [{ packageId: 'w1', role: 'worker', status: 'dispatched', handle: 'h1' }] }));
  const sent = await accept(f, 'packages', ['--id', 'p1', '--input', file]);
  assert.equal(sent.receipt.accepted, true, JSON.stringify(sent));
  await writeFile(file, JSON.stringify({ ticket: 'forged', packages: [] }));
  assert.equal(JSON.parse(build(f, 'packages', ['--id', 'p2', '--input', file]).stdout).error, 'INPUT');
  assert.equal(JSON.parse(build(f, 'packages', ['--id', 'p3']).stdout).error, 'INPUT');
  assert.equal(JSON.parse(build(f, 'launch', ['--id', 'p4']).stdout).error, 'ACTION');
  // 字面值不再在 CLI 参数层被拒；phase 是否为合法枚举仍由 Hook 的 acceptSignal 校验。
  assert.equal(JSON.parse(build(f, 'phase', ['--id', 'p5', '--phase', 'a&b']).stdout).workflow_signal.phase, 'a&b');
});
test('task-update 子命令只带显式字段，paths-mode 缺省 replace；接受后返回有效权限', async () => {
  const f = await fixture();
  await start(f);
  const empty = build(f, 'task-update', ['--id', 'u0']);
  const payload = JSON.parse(empty.stdout).workflow_signal;
  assert.equal(payload.action, 'task-update');
  assert.equal(payload.goal, undefined);
  assert.equal(payload.permissions, undefined);
  assert.equal(payload.allowedPathsMode, undefined);
  const built = JSON.parse(build(f, 'task-update', ['--id', 'u1', '--paths', 'docs/a.md', '--paths-mode', 'append', '--mode', 'write']).stdout).workflow_signal;
  assert.deepEqual(built.permissions, { mode: 'write', allowedPaths: ['docs/a.md'] });
  assert.equal(built.allowedPathsMode, 'append');
  const sent = await accept(f, 'task-update', ['--id', 'u2', '--goal', '新目标', '--paths', 'README.md']);
  assert.equal(sent.receipt.accepted, true, JSON.stringify(sent));
  assert.equal(sent.receipt.goal, '新目标');
  assert.deepEqual(sent.receipt.permissions.allowedPaths, ['README.md']);
  assert.deepEqual(sent.receipt.change.permissions.allowedPaths.removed, ['LESSONS.md', 'docs/说明.md']);
});
test('task-update 命令行与 --input 的 permissions 按子字段合并，收缩路径不被丢弃', async () => {
  const f = await fixture();
  await start(f);
  const file = path.join(f.area, 'update.json');
  await writeFile(file, JSON.stringify({ permissions: { allowedPaths: ['README.md'] } }));
  const built = JSON.parse(build(f, 'task-update', ['--id', 'u1', '--mode', 'write', '--input', file]).stdout).workflow_signal;
  assert.deepEqual(built.permissions, { mode: 'write', allowedPaths: ['README.md'] });
  const sent = await accept(f, 'task-update', ['--id', 'u2', '--mode', 'write', '--input', file]);
  assert.equal(sent.receipt.accepted, true, JSON.stringify(sent));
  assert.deepEqual(sent.receipt.permissions.allowedPaths, ['README.md']);
  assert.deepEqual(sent.receipt.change.permissions.allowedPaths.removed, ['LESSONS.md', 'docs/说明.md']);
});
test('task-update 同一 permissions 子字段两处冲突返回 INPUT；相同值可合并', async () => {
  const f = await fixture();
  await start(f);
  const file = path.join(f.area, 'update.json');
  await writeFile(file, JSON.stringify({ permissions: { mode: 'read-only', allowedPaths: ['README.md'] } }));
  const conflict = JSON.parse(build(f, 'task-update', ['--id', 'u1', '--mode', 'write', '--input', file]).stdout);
  assert.equal(conflict.error, 'INPUT');
  await writeFile(file, JSON.stringify({ permissions: { mode: 'write' } }));
  const same = JSON.parse(build(f, 'task-update', ['--id', 'u2', '--mode', 'write', '--paths', 'README.md', '--input', file]).stdout).workflow_signal;
  assert.deepEqual(same.permissions, { mode: 'write', allowedPaths: ['README.md'] });
});
test('task-update 当前动作不支持的便捷参数直接报错，不再静默忽略', async () => {
  const f = await fixture();
  await start(f);
  const before = JSON.stringify(await readState(f.directory));
  for (const [key, value] of [['route', 'delegated'], ['channels', 'worker=lead'], ['plans', 'docs/a.md'], ['parent', 'task-0'], ['phase', 'executing'], ['delivery', 'd1'], ['role', 'worker'], ['package', 'w1'], ['final-ref', 'abc']]) {
    const result = JSON.parse(build(f, 'task-update', ['--id', `bad-${key}`, '--goal', '新目标', `--${key}`, value]).stdout);
    assert.equal(result.error, 'UNSUPPORTED', `${key}: ${result.message}`);
    assert.match(result.message, new RegExp(`--${key}`));
  }
  assert.equal(JSON.stringify(await readState(f.directory)), before);
});
test('task-update 拒绝全局解析器接受但本动作不用的参数，--path 与 --goal 混用不静默丢弃', async () => {
  const f = await fixture();
  await start(f);
  const before = JSON.stringify(await readState(f.directory));
  const cases = [['path', 'docs/a.md'], ['ref', 'HEAD'], ['agent', 'codex'], ['user-dir', f.area], ['max-files', '5'], ['pending', 'p1'], ['transaction', 't1'], ['owner', 'someone'], ['coexistence-mode', 'bounded'], ['query', 'x'], ['run', 'r1'], ['version', '1']];
  for (const [key, value] of cases) {
    const result = JSON.parse(build(f, 'task-update', ['--id', `bad-${key}`, '--goal', '新目标', `--${key}`, value]).stdout);
    assert.equal(result.error, 'UNSUPPORTED', `${key}: ${result.message}`);
    assert.match(result.message, new RegExp(`--${key}`));
  }
  for (const key of ['global', 'now', 'skip-learning', 'enable-learning', 'keep', 'discard']) {
    const result = JSON.parse(build(f, 'task-update', ['--id', `bad-${key}`, '--goal', '新目标', `--${key}`]).stdout);
    assert.equal(result.error, 'UNSUPPORTED', `${key}: ${result.message}`);
    assert.match(result.message, new RegExp(`--${key}`));
  }
  assert.equal(JSON.stringify(await readState(f.directory)), before);
});
test('task-update 合法公共选项与业务选项的完整 CLI 调用仍被接受', async () => {
  const f = await fixture();
  await start(f);
  const sent = await accept(f, 'task-update', ['--project', f.project, '--id', 'u-full', '--task', 'task-1', '--goal', '完整调用', '--mode', 'write', '--paths', 'README.md', '--paths-mode', 'append']);
  assert.equal(sent.receipt.accepted, true, JSON.stringify(sent));
  assert.equal(sent.receipt.goal, '完整调用');
  assert.deepEqual(sent.receipt.permissions.allowedPaths, ['README.md', 'LESSONS.md', 'docs/说明.md']);
  assert.equal(sent.payload.allowedPathsMode, 'append');
  const file = path.join(f.area, 'update-full.json');
  await writeFile(file, JSON.stringify({ permissions: { mode: 'write' } }));
  const withInput = JSON.parse(build(f, 'task-update', ['--project', f.project, '--id', 'u-input', '--goal', '带输入', '--input', file]).stdout);
  assert.equal(withInput.error, undefined, JSON.stringify(withInput));
  assert.equal(withInput.workflow_signal.goal, '带输入');
  const encoded = Buffer.from(JSON.stringify({ permissions: { mode: 'write' } })).toString('base64');
  const withBase64 = JSON.parse(build(f, 'task-update', ['--id', 'u-base64', '--goal', '带 base64', '--base64', encoded]).stdout);
  assert.equal(withBase64.error, undefined, JSON.stringify(withBase64));
  assert.equal(withBase64.workflow_signal.goal, '带 base64');
});
test('委派子会话不带 --task 也能 role-claim；声明后入口换成角色指引', async () => {
  const f = await fixture();
  await start(f);
  const worker = { sessionId: 'worker-session', turnId: 'worker-turn' };
  await event({ ...f, ...worker }, 'UserPromptSubmit');
  const claimed = await accept(f, 'role-claim', ['--id', 'c1', '--role', 'worker', '--package', 'w1'], worker);
  assert.equal(claimed.receipt.accepted, true, JSON.stringify(claimed));
  const entry = await event({ ...f, sessionId: worker.sessionId, turnId: 'worker-turn-2' }, 'UserPromptSubmit');
  assert.match(entry.hookSpecificOutput.additionalContext, /"role":"worker"/);
  assert.doesNotMatch(entry.hookSpecificOutput.additionalContext, /入口与本会话上一回合相同/);
});
test('回执 revision 为 1 时重放仍复原 expectedRevision=0', () => {
  const session = { turnId: 't1', taskId: 'task-1', ticket: 'k', interruptEpoch: 0, revision: 1, receipts: { e1: { hash: 'h', result: { revision: 1 } } } };
  const state = { sessions: { [sessionKey('p1', 's1')]: session } };
  const payload = buildSignal(state, { project: { projectId: 'p1' } }, 'task-end', { session: 's1', turn: 't1', id: 'e1' });
  assert.equal(payload.expectedRevision, 0);
});
test('同会话后续回合入口只给短指引；SessionStart 恢复完整入口', async () => {
  const f = await fixture();
  const parse = output => JSON.parse(output.hookSpecificOutput.additionalContext.replace(/^[\s\S]*?workflow 入口：/, ''));
  const second = parse(await event({ ...f, turnId: 'turn-2' }, 'UserPromptSubmit'));
  assert.match(second.instruction, /入口与本会话上一回合相同/);
  assert.equal(second.signal.examples, undefined);
  const resumed = parse(await event({ ...f, turnId: 'turn-2' }, 'SessionStart', { source: 'compact' }));
  assert.ok(resumed.signal.examples.length);
  assert.doesNotMatch(resumed.instruction, /入口与本会话上一回合相同/);
});
test('Stop 与显式 save 后未再改状态不重复落盘；中间 save 后继续改状态仍二次落盘；未注册目录零匹配返回 null', async () => {
  const f = await fixture();
  await start(f);
  const r0 = (await readState(f.directory)).revision;
  await event(f, 'Stop');
  assert.equal((await readState(f.directory)).revision, r0 + 1);
  await mutate(f.directory, async (state, save) => {
    state.customStep = 1;
    await save();
    state.customStep = 2;
  });
  const after = await readState(f.directory);
  assert.equal(after.revision, r0 + 3);
  assert.equal(after.customStep, 2);
  assert.equal(await resolveProject(after, path.dirname(f.directory)), null);
  const stateFile = path.join(f.directory, 'state.json');
  for (const [broken, code] of [['{bad', 'STATE'], ['null', 'SCHEMA']]) {
    await writeFile(stateFile, broken);
    await assert.rejects(() => mutate(f.directory, async () => {}), { code });
    assert.equal(await readFile(stateFile, 'utf8'), broken);
  }
});
test('计划模式普通讨论不单独阻挡；本回合显式进入计划交付才核对分包与通道', async () => {
  const f = await fixture();
  const entryOut = await event({ ...f, turnId: 'plan-1' }, 'UserPromptSubmit', { permission_mode: 'plan' });
  assert.match(entryOut.hookSpecificOutput.additionalContext, /分几个工作包.*真实新增的角色或通道/);
  // 本回合没有 task-start/phase：普通解释直接放行。
  assert.deepEqual(await event({ ...f, turnId: 'plan-1' }, 'Stop'), {});

  f.turnId = 'plan-2';
  await event(f, 'UserPromptSubmit', { permission_mode: 'plan' });
  assert.equal((await emit(f, { action: 'task-start', goal: '交付计划', route: 'lead-direct', permissions: { mode: 'plan', allowedPaths: [] } })).result.accepted, true);
  const blocked = await event(f, 'Stop');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /计划交付核对.*分几个包.*Lead 直接执行.*不需要询问 Worker/);
  assert.deepEqual(await event(f, 'Stop'), {});

  // 历史 plans 不跨回合推断本回合在交付计划：活动任务声明过 plans，下一回合 plan 模式普通追问仍放行。
  f.turnId = 'plan-3';
  await event(f, 'UserPromptSubmit', { permission_mode: 'plan' });
  await emit(f, { action: 'task-start', goal: '按计划实施', route: 'lead-direct', plans: ['docs/plan.md'], permissions: { mode: 'plan', allowedPaths: [] } });
  f.turnId = 'plan-4';
  await event(f, 'UserPromptSubmit', { permission_mode: 'plan' });
  assert.deepEqual(await event(f, 'Stop'), {});
  // 同一回合本回合显式声明阶段时仍核对一次。
  await emit(f, { action: 'phase', phase: 'executing' });
  const explicit = await event(f, 'Stop');
  assert.equal(explicit.decision, 'block');
  assert.match(explicit.reason, /计划交付核对/);
  assert.deepEqual(await event(f, 'Stop'), {});

  // 计划模式普通讨论不落到通用门禁阻挡；有包在途时仍按在途阻挡。
  f.turnId = 'plan-5';
  await event(f, 'UserPromptSubmit', { permission_mode: 'plan' });
  await emit(f, { action: 'packages', packages: [{ packageId: 'w1', role: 'worker', status: 'dispatched', channel: 'builtin:general-purpose' }] });
  const inflight = await event(f, 'Stop');
  assert.equal(inflight.decision, 'block');
  assert.match(inflight.reason, /仍有 1 个工作包在途/);

  // 结构化提问工具自动记 waiting-user，不再要求先发一次 phase。
  f.turnId = 'plan-6';
  await event(f, 'UserPromptSubmit', { permission_mode: 'plan' });
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.deepEqual(await event(f, 'Stop'), {});

  // 计划模式下的纯操作路线即使在显式任务阶段也放行。
  const g = await fixture();
  g.turnId = 'plan-op';
  await event(g, 'UserPromptSubmit', { permission_mode: 'plan' });
  await emit(g, { action: 'task-start', goal: '查看', route: 'operation-only', permissions: { mode: 'plan', allowedPaths: [] } });
  assert.deepEqual(await event(g, 'Stop'), {});
});
test('计划交付核对与在途包同时成立时合并为一次阻挡，在途提示在前', async () => {
  const f = await fixture();
  f.turnId = 'plan-inflight';
  await event(f, 'UserPromptSubmit', { permission_mode: 'plan' });
  const started = await emit(f, { action: 'task-start', goal: '交付计划', route: 'delegated', permissions: { mode: 'plan', allowedPaths: [] } });
  assert.equal(started.result.accepted, true, JSON.stringify(started.result));
  await emit(f, { action: 'phase', phase: 'executing' });
  await emit(f, { action: 'packages', packages: [{ packageId: 'w9', role: 'worker', status: 'dispatched', handle: 'task-9', channel: 'codeg:codex' }] });
  const blocked = await event(f, 'Stop');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /仍有 1 个工作包在途（w9\(task-9\)）.*get_delegation_status/);
  assert.match(blocked.reason, /另：workflow 计划交付核对/);
  // 同回合已挡过一次，第二次 Stop 放行。
  assert.deepEqual(await event(f, 'Stop'), {});
});
test('计划交付核对沿用已声明的通道，只对真实新增的角色或通道提问', async () => {
  const f = await fixture();
  f.turnId = 'plan-channel';
  await event(f, 'UserPromptSubmit', { permission_mode: 'plan' });
  await emit(f, {
    action: 'task-start', goal: '交付计划', route: 'delegated',
    permissions: { mode: 'plan', allowedPaths: [] },
    channels: { worker: 'codeg:claude_code', reviewer: 'codeg:codex' },
  });
  const blocked = await event(f, 'Stop');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /已有明确安排直接沿用.*Worker 通道 codeg:claude_code.*Reviewer 通道 codeg:codex/);
  assert.match(blocked.reason, /只有计划里真实新增的角色或通道且尚无明确安排时/);
  assert.doesNotMatch(blocked.reason, /不需要询问 Worker/);
});
#!/usr/bin/env node
// P10 输入路径测量：同一“单 Worker + 单 Reviewer、无返修”流程分别用旧 JSON 文件写法与便捷参数写法。
// 只数载荷准备（写 JSON 文件）与命令发送次数；两者相加即工具调用数，不推算模型轮次或费用。
// 状态与项目都在系统临时目录，不读真实宿主配置；结束时用 trash 移入回收站。
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { enableProject } from '../../src/projects.mjs';
import { getContext } from '../../src/context.mjs';
import { handleHook } from '../../src/hooks.mjs';
import { readState } from '../../src/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = path.join(root, 'bin', 'workflow.mjs');
const sessionId = 'bench-session';
const turnId = 'bench-turn';
const taskId = 'bench-task';
const deliveredRef = 'abc123';
const evidence = ['npm test 250/250 通过', 'npm run check 0 错误'];
// 只用于生成命令文本；值里避免引号，带空格的参数用双引号包住（与 shellTokens 的规则一致）。
const token = value => /[\s"]/g.test(value) ? `"${value}"` : value;

async function setup(prefix) {
  const area = await mkdtemp(path.join(tmpdir(), `workflow-p10-bench-${prefix}`));
  const project = path.join(area, 'project');
  const stateDir = path.join(area, 'state');
  await mkdir(project);
  await writeFile(path.join(project, 'README.md'), '# 项目\n');
  await enableProject(stateDir, project, { owner: sessionId });
  await handleHook(stateDir, { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: sessionId, turn_id: turnId, permission_mode: 'default' }, { synthetic: true, entry });
  const context = await getContext(stateDir, project, 'lead', sessionId);
  return { area, project, stateDir, identity: context.identity };
}

function flow(f) {
  const counts = { writes: 0, commands: 0 };
  const common = ['--state-dir', f.stateDir, '--root', f.project, '--session', f.identity.sessionId, '--turn', f.identity.turnId, '--task', taskId];
  async function send(args) {
    const run = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    counts.commands += 1;
    if (run.status !== 0) throw new Error(`CLI 失败：${run.stdout}${run.stderr}`);
    // 真实命令文本 + 该命令真实输出走当前 PostToolUse；只有回执 accepted 才算写入。
    const command = ['node', token(entry), ...args.map(token)].join(' ');
    const output = await handleHook(f.stateDir, {
      hook_event_name: 'PostToolUse', cwd: f.project, session_id: sessionId, turn_id: turnId, permission_mode: 'default',
      tool_name: 'Bash', tool_input: { command }, tool_response: { output: run.stdout },
    }, { synthetic: true, entry });
    const text = output.hookSpecificOutput?.additionalContext;
    if (!text?.startsWith('workflow 回执：')) throw new Error(`hook 未回执：${command}`);
    const receipt = JSON.parse(text.slice('workflow 回执：'.length));
    if (!receipt.accepted) throw new Error(`信号未被接受：${JSON.stringify(receipt)}`);
  }
  async function payload(name, value) {
    const file = path.join(f.area, name);
    await writeFile(file, JSON.stringify(value));
    counts.writes += 1;
    return file;
  }
  return { counts, common, send, payload };
}

async function oldFlow(f) {
  const { counts, common, send, payload } = flow(f);
  await send(['signal', 'task-start', ...common, '--id', 'start-1', '--route', 'delegated', '--goal', 'P10 基准流程', '--mode', 'write', '--paths', 'README.md']);
  const dispatch = await payload('dispatch.json', { packages: [{ packageId: 'w1', role: 'worker', status: 'dispatched', channel: 'codeg:claude_code', handle: 'worker-task-1' }] });
  await send(['signal', 'packages', ...common, '--id', 'pkg-1', '--input', dispatch]);
  const batch = await payload('batch.json', { packages: [
    { packageId: 'w1', status: 'consumed', deliveredRef },
    { packageId: 'r1', role: 'reviewer', status: 'dispatched', channel: 'codeg:codex', handle: 'reviewer-task-1', reviews: 'w1' },
  ] });
  await send(['signal', 'packages', ...common, '--id', 'pkg-2', '--input', batch]);
  const review = await payload('review.json', { packages: [{ packageId: 'r1', status: 'consumed', verdict: 'PASS', reviewedRef: deliveredRef }] });
  await send(['signal', 'packages', ...common, '--id', 'pkg-3', '--input', review]);
  const end = await payload('end.json', { validation: { ref: deliveredRef, evidence } });
  await send(['signal', 'task-end', ...common, '--id', 'end-1', '--final-ref', deliveredRef, '--input', end]);
  return counts;
}

async function newFlow(f) {
  const { counts, common, send, payload } = flow(f);
  await send(['signal', 'task-start', ...common, '--id', 'start-1', '--route', 'delegated', '--goal', 'P10 基准流程', '--mode', 'write', '--paths', 'README.md']);
  await send(['signal', 'packages', ...common, '--id', 'pkg-1', '--package', 'w1', '--role', 'worker', '--status', 'dispatched', '--channel', 'codeg:claude_code', '--handle', 'worker-task-1']);
  // 一次消费并派下一阶段是同批两个包，按协议继续用 --input；单包便捷参数不硬塞批量语义。
  const batch = await payload('batch.json', { packages: [
    { packageId: 'w1', status: 'consumed', deliveredRef },
    { packageId: 'r1', role: 'reviewer', status: 'dispatched', channel: 'codeg:codex', handle: 'reviewer-task-1', reviews: 'w1' },
  ] });
  await send(['signal', 'packages', ...common, '--id', 'pkg-2', '--input', batch]);
  await send(['signal', 'packages', ...common, '--id', 'pkg-3', '--package', 'r1', '--status', 'consumed', '--verdict', 'PASS', '--ref', deliveredRef]);
  await send(['signal', 'task-end', ...common, '--id', 'end-1', '--final-ref', deliveredRef, ...evidence.flatMap(item => ['--evidence', item])]);
  return counts;
}

async function verify(f) {
  const task = Object.values((await readState(f.stateDir)).tasks).find(item => item.taskId === taskId);
  if (!task || task.lifecycle !== 'complete') throw new Error('流程未完成');
  if (task.packages.w1?.status !== 'consumed' || task.packages.r1?.verdict !== 'PASS' || task.packages.r1?.reviewedRef !== deliveredRef) throw new Error('账本与预期不符');
  if (task.validation?.ref !== deliveredRef || task.validation?.evidence?.length !== evidence.length) throw new Error('validation 与预期不符');
}

const areas = [];
try {
  const oldFixture = await setup('old-'); areas.push(oldFixture.area);
  const oldCounts = await oldFlow(oldFixture);
  await verify(oldFixture);
  const newFixture = await setup('new-'); areas.push(newFixture.area);
  const newCounts = await newFlow(newFixture);
  await verify(newFixture);
  const total = counts => counts.writes + counts.commands;
  const report = {
    flow: 'task-start → 派发 worker → 消费 worker 并派发 reviewer → reviewer PASS → task-end(validation)',
    old: { ...oldCounts, toolCalls: total(oldCounts) },
    new: { ...newCounts, toolCalls: total(newCounts) },
    reduction: {
      writes: oldCounts.writes - newCounts.writes,
      commands: oldCounts.commands - newCounts.commands,
      toolCalls: total(oldCounts) - total(newCounts),
      toolCallsPercent: Number(((total(oldCounts) - total(newCounts)) * 100 / total(oldCounts)).toFixed(1)),
    },
    note: '同批多包（消费 worker 并派发 reviewer）按协议继续用 --input；若拆成两条单包便捷命令，新写法为写文件 0、命令 6、总调用 6。',
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  if (areas.length) {
    // npm 全局的 trash 在 Windows 是 .cmd，经 shell 调用；路径逐个加引号以容纳空格。
    const command = ['trash', ...areas.map(item => `"${item}"`)].join(' ');
    const cleaned = spawnSync(command, { encoding: 'utf8', windowsHide: true, timeout: 60000, shell: true });
    if (cleaned.status !== 0) process.stderr.write(`临时目录未能用 trash 清理，请手动处理：${areas.join('、')}\n${cleaned.stderr || ''}\n`);
  }
}

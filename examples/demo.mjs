import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = path.join(tmpdir(), 'workflow-tests');
await mkdir(parent, { recursive: true });
const area = await mkdtemp(path.join(parent, 'demo-'));
try {
const directory = path.join(area, 'state');
const userDir = path.join(area, '.codex');
const project = path.join(area, 'project');
await mkdir(project);
await writeFile(path.join(project, 'README.md'), '# 隔离样例\n');
let entry = path.join(product, 'bin', 'workflow.mjs');
const invoke = (args, value) => {
  const result = spawnSync(process.execPath, [entry, ...args, '--state-dir', directory], { encoding: 'utf8', input: value === undefined ? undefined : JSON.stringify(value), windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
};
const installation = invoke(['install', '--agent', 'codex', '--user-dir', userDir]);
assert.equal(installation.status, 'installed');
entry = path.join(installation.releaseRoot, 'bin', 'workflow.mjs');
const binding = invoke(['project', 'enable', '--root', project, '--owner', 'demo-session']);
const hook = (name, extra = {}) => invoke(['hook', '--agent', 'codex'], { hook_event_name: name, cwd: project, session_id: 'demo-session', turn_id: 'demo-turn', permission_mode: 'default', ...extra });
hook('UserPromptSubmit');
const context = () => invoke(['context', '--role', 'lead', '--project', project, '--session', 'demo-session']);
const signal = extra => {
  const payload = { ...context().identity, taskId: 'demo-task', signalId: crypto.randomUUID(), ...extra };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const output = invoke(['signal', '--base64', encoded]);
  const received = hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 ${encoded}` }, tool_response: { output: JSON.stringify(output) } });
  const receipt = JSON.parse(received.hookSpecificOutput.additionalContext.slice('workflow 回执：'.length));
  assert.equal(receipt.accepted, true, JSON.stringify(receipt));
  return receipt;
};
signal({ action: 'task-start', goal: '隔离样例补齐有证据项目经验', permissions: { mode: 'write', allowedPaths: ['LESSONS.md'] } });
const baseline = invoke(['knowledge', 'inspect', '--project', project, '--path', 'LESSONS.md']);
const candidate = { id: 'demo-finding', taskId: 'demo-task', workPackage: 'demo', conditions: '当前合成样例', finding: '演示条目需明确条件', recommendation: '资料写明条件与证据', evidence: ['synthetic:demo-input'] };
const transaction = invoke(['knowledge', 'apply'], { ...context().identity, candidates: [candidate], changes: [{ path: 'LESSONS.md', baseline: baseline.fingerprint, content: '# 样例经验\n仅用于当前合成场景；参考 synthetic:demo-input。\n', responsibility: '样例经验', reason: '验证完整知识事务', evidence: candidate.evidence, candidateIds: [candidate.id] }] });
assert.equal(transaction.status, 'applied');
signal({ action: 'phase', phase: 'delivering', deliveryId: 'demo-delivery', disposition: { status: 'updated', transactionIds: [transaction.transactionId] } });
assert.deepEqual(hook('Stop'), {});
signal({ action: 'task-end' });
assert.equal(invoke(['project', 'disable', '--root', project]).status, 'disabled');
assert.equal(invoke(['uninstall', '--agent', 'codex']).status, 'uninstalled');
const result = { status: 'passed', mode: 'synthetic-isolated-cli', area, projectId: binding.projectId, transactionId: transaction.transactionId, installedRelease: installation.releaseRoot, stages: ['临时发布安装', '显式绑定', '入口注入', '真实CLI信号及回执', '知识快照与事务', '交付Stop放行', '任务结束', '停用与撤销'], realACP: 'not-tested', realUserConfigChanged: false };
await writeFile(path.join(area, 'result.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  await rm(area, { recursive: true, force: true });
}

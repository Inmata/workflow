import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { fail, writeJSON } from './store.mjs';

const DISABLE = ['hooks', 'shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'plugins', 'apps', 'memories', 'browser_use', 'computer_use', 'image_generation', 'code_mode', 'code_mode_host', 'skill_search', 'sleep_tool', 'workspace_dependencies', 'unbounded_connection_retries', 'view_image', 'goals'];
// Codex 0.164 起 unified_exec 只能由托管 requirements 关闭，用户 -c 后仍报 true；
// 实测 shell_tool=false 时请求中已无 exec_command/write_stdin，故不以它的开关值判定隔离。
const MANAGED_ONLY = ['unified_exec'];
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
export function commandFor(executable, args) {
  if (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')) return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '& ' + psQuote(executable) + ' ' + args.map(psQuote).join(' ')] };
  return { executable, args };
}
export async function runProcess(executable, args, options = {}) {
  const command = commandFor(executable, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: options.cwd, env: options.env || process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false, overflow = false;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { expired = true; kill(); }, options.timeoutMs || 15000);
    const collect = (key, bytes) => {
      if (key === 'out') stdout += bytes; else stderr += bytes;
      if (stdout.length + stderr.length > (options.maxOutputChars || 2000000)) { overflow = true; kill(); }
    };
    child.stdout.on('data', b => collect('out', b));
    child.stderr.on('data', b => collect('err', b));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut: expired, overflow }); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input || '');
  });
}
export async function preflight(config, runDir, execute = runProcess) {
  await mkdir(runDir, { recursive: true });
  const common = config.profile ? ['--profile', config.profile] : [];
  const help = await execute(config.executorPath, ['exec', '--help'], { cwd: runDir });
  if (help.code !== 0 || !['--json', '--output-schema', '--ephemeral', '--sandbox'].every(k => help.stdout.includes(k))) fail('EXECUTOR', '执行器缺少必要的非交互能力');
  // Codex 0.164 起 features 子命令拒绝 --profile；-c 覆盖优先于 profile，不带 profile 核对不影响隔离结论。
  const features = await execute(config.executorPath, ['features', 'list'], { cwd: runDir });
  if (features.code !== 0) fail('ISOLATION', '无法验证执行器功能开关');
  const available = new Set(features.stdout.split(/\r?\n/).map(l => l.trim().split(/\s+/)[0]));
  for (const required of ['hooks', 'shell_tool', 'multi_agent', 'plugins']) if (!available.has(required)) fail('ISOLATION', '此执行器无法确认隔离 ' + required);
  const flags = DISABLE.filter(k => available.has(k)).flatMap(k => ['-c', 'features.' + k + '=false']);
  // Codex 0.164 的 multi_agent=false 不再移除 spawn_agent 等协作工具，需同时关闭 agents。
  flags.push('-c', 'agents.enabled=false', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"');
  // MCP 清单只用于取名称并逐一禁用；不保存原始清单或认证信息。
  const mcp = await execute(config.executorPath, [...common, ...flags, 'mcp', 'list', '--json'], { cwd: runDir });
  let servers;
  try { servers = JSON.parse(mcp.stdout); } catch { fail('ISOLATION', '无法辨认 MCP 清单'); }
  if (mcp.code !== 0 || !Array.isArray(servers)) fail('ISOLATION', '无法核实 MCP 隔离');
  for (const server of servers) {
    if (typeof server.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(server.name)) fail('ISOLATION', 'MCP 名称无法安全覆盖');
    flags.push('-c', 'mcp_servers.' + server.name + '.enabled=false');
  }
  const verified = await execute(config.executorPath, [...common, ...flags, 'mcp', 'list', '--json'], { cwd: runDir });
  let after;
  try { after = JSON.parse(verified.stdout); } catch { fail('ISOLATION', 'MCP 禁用结果不可辨认'); }
  if (verified.code !== 0 || !Array.isArray(after) || after.some(s => s.enabled !== false)) fail('ISOLATION', 'MCP 尚未全部禁用');
  const featureCheck = await execute(config.executorPath, [...flags, 'features', 'list'], { cwd: runDir });
  if (featureCheck.code !== 0 || DISABLE.filter(k => available.has(k) && !MANAGED_ONLY.includes(k)).some(k => !featureCheck.stdout.split(/\r?\n/).some(l => l.trim().startsWith(k + ' ') && /\bfalse\s*$/.test(l)))) fail('ISOLATION', '工具或 hook 仍启用');
  return { common, flags, checkedAt: new Date().toISOString(), status: 'capabilities-verified', modelInvocation: false };
}
export async function codexRunner(config, prompt, schema, runDir, capability) {
  const schemaFile = path.join(runDir, 'response-schema.json');
  const answerFile = path.join(runDir, 'answer.json');
  await writeJSON(schemaFile, schema);
  const args = [...capability.common, 'exec', ...capability.flags, '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--json', '--output-schema', schemaFile, '--output-last-message', answerFile];
  if (config.model) args.push('--model', config.model);
  if (config.reasoningEffort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(config.reasoningEffort));
  args.push('-');
  const result = await runProcess(config.executorPath, args, { cwd: runDir, input: prompt, timeoutMs: config.maxRunMinutes * 60000, env: { ...process.env, WORKFLOW_REVIEW: '1' } });
  let usage = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    try { const event = JSON.parse(line); if (event.usage) usage = event.usage; } catch {}
  }
  if (result.timedOut) return { status: 'timeout', usage };
  if (result.code !== 0 || result.overflow) return { status: 'failed', usage, reason: result.overflow ? '输出超过保护上限' : '执行器失败，退出码 ' + result.code };
  let answer;
  try { answer = JSON.parse(await readFile(answerFile, 'utf8')); } catch { return { status: 'failed', usage, reason: '结果不是有效 JSON' }; }
  return { status: 'completed', answer, usage };
}

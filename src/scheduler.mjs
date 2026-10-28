import path from 'node:path';
import { atomicWrite, digest, fail, mutate, readState } from './store.mjs';
import { projectFor, learningConfig } from './learning-config.mjs';
import { projectData } from './learning.mjs';
import { DEFERRED_CODES, reviewOnce } from './review.mjs';
import { runProcess } from './runner.mjs';

const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// 锁竞争、BUSY 等短延期只安排有界重试，不推进正常检查时间；退避上限受检查周期约束。
const DEFER_RETRY_MS = 30000;
const DEFER_RETRY_STEPS = 4;
// Windows 路径不含引号，只需处理结尾反斜杠，否则 `"D:\"` 会把引号转义掉。
const winArg = s => '"' + String(s).replace(/(\\+)$/, '$1$1') + '"';
// 任务定义变化时递增，旧任务在下次运行时自动重新注册。
const TASK_FORMAT = 3;
// 不带 UserId 的登录触发器等于“任意用户登录”，普通权限注册会被拒绝访问。
const currentUser = () => process.env.USERNAME ? (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + process.env.USERNAME : '';
export async function schedulePreview(directory, root, entry) {
  const project = await projectFor(directory, root);
  const state = await readState(directory);
  const installed = Object.values(state.installs || {}).find(i => i.status === 'installed' && i.currentRoot);
  if (installed) entry = path.join(installed.currentRoot, 'bin', 'workflow.mjs');
  const { values: config } = await learningConfig(directory, project);
  const taskName = 'workflow-learning-' + digest(path.resolve(directory) + ':' + project.projectId).slice(0, 24);
  // 直接起 node 会弹出控制台窗口；经 PowerShell 脚本又受执行策略限制。conhost --headless 两者都避开。
  const command = '--headless ' + [process.execPath, entry, 'learning', 'tick', '--state-dir', path.resolve(directory), '--root', project.root].map(winArg).join(' ');
  const xmlText = '<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>workflow 项目知识维护</Description></RegistrationInfo><Triggers><TimeTrigger><Repetition><Interval>PT' + config.checkIntervalMinutes + 'M</Interval></Repetition><StartBoundary>' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</StartBoundary><Enabled>true</Enabled></TimeTrigger><LogonTrigger><Enabled>true</Enabled>' + (currentUser() ? '<UserId>' + xml(currentUser()) + '</UserId>' : '') + '</LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT' + (config.maxRunMinutes + 5) + 'M</ExecutionTimeLimit><Hidden>true</Hidden></Settings><Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>' + xml(command) + '</Arguments></Exec></Actions></Task>';
  return { taskName, projectId: project.projectId, entry, file: path.join(projectData(directory, project), 'scheduler.xml'), command, xml: xmlText, checkIntervalMinutes: config.checkIntervalMinutes, maxRunMinutes: config.maxRunMinutes };
}
export async function installSchedule(directory, root, entry, execute = runProcess) {
  if (process.platform !== 'win32') fail('PLATFORM', '首版调度器只支持 Windows');
  const preview = await schedulePreview(directory, root, entry);
  const project = await projectFor(directory, root);
  if (!project.learning?.enabled) fail('PERMISSION', '先明确启用项目知识维护');
  const existing = await execute('schtasks.exe', ['/Query', '/TN', preview.taskName], {});
  if (existing.code === 0 && project.learning?.schedule?.taskName !== preview.taskName) fail('CONFLICT', '同名任务不属于本插件登记，未覆盖');
  const file = preview.file;
  await atomicWrite(file, Buffer.concat([Buffer.from([255, 254]), Buffer.from(preview.xml, 'utf16le')]));
  const result = await execute('schtasks.exe', ['/Create', '/TN', preview.taskName, '/XML', file, '/F'], {});
  if (result.code !== 0) fail('SCHEDULER', '系统调度注册失败；维护数据保留');
  return mutate(directory, async state => {
    const current = await projectFor(directory, root, state);
    current.learning.schedule = { taskName: preview.taskName, entry: preview.entry, checkIntervalMinutes: preview.checkIntervalMinutes, maxRunMinutes: preview.maxRunMinutes, format: TASK_FORMAT, registeredAt: new Date().toISOString() };
    return { status: 'registered', taskName: preview.taskName };
  });
}
export async function removeSchedule(directory, root, execute = runProcess) {
  const project = await projectFor(directory, root);
  const schedule = project.learning?.schedule;
  if (!schedule) return { status: 'not-registered' };
  const result = await execute('schtasks.exe', ['/Delete', '/TN', schedule.taskName, '/F'], {});
  if (result.code !== 0) fail('SCHEDULER', '撤销系统调度失败，记录保留');
  return mutate(directory, async state => {
    delete state.projects[project.projectId].learning.schedule;
    return { status: 'removed' };
  });
}
export async function tick(directory, root, options = {}) {
  const project = await projectFor(directory, root);
  if (!project.learning?.enabled) return { status: 'disabled' };
  const { values: config } = await learningConfig(directory, project);
  const now = options.now || new Date();
  const interval = config.checkIntervalMinutes * 60000;
  // 检查时间与有效执行时间分开：延期不记作一次检查，下一次机会不必再等整个周期。
  const lastValue = project.learning.lastCheckedAt ? Date.parse(project.learning.lastCheckedAt) : null;
  const retryValue = project.learning.nextCheckAt ? Date.parse(project.learning.nextCheckAt) : null;
  const last = Number.isFinite(lastValue) ? lastValue : null;
  const retryAt = Number.isFinite(retryValue) ? retryValue : null;
  const intervalDue = last === null || now - last >= interval;
  const retryDue = retryAt !== null && now >= retryAt;
  if (!intervalDue && !retryDue) return { status: 'interval' };
  // 直接改配置文件或升级任务定义后，会在下次旧间隔检查时同步系统调度。
  if (project.learning.schedule && (project.learning.schedule.format !== TASK_FORMAT || project.learning.schedule.checkIntervalMinutes !== config.checkIntervalMinutes || project.learning.schedule.maxRunMinutes !== config.maxRunMinutes)) await installSchedule(directory, root, project.learning.schedule.entry, options.execute);
  let result;
  try { result = await reviewOnce(directory, root, options); }
  catch (error) { result = { status: 'deferred', reason: error.code || 'IO' }; }
  const deferred = result.status === 'deferred' && (DEFERRED_CODES.has(result.reason) || result.reason === 'LOCKED');
  await mutate(directory, async state => {
    const learning = state.projects[project.projectId]?.learning;
    if (!learning) return;
    if (!deferred) {
      learning.lastCheckedAt = now.toISOString();
      delete learning.nextCheckAt; delete learning.deferCount;
      return;
    }
    learning.deferCount = (learning.deferCount || 0) + 1;
    const delay = Math.min(interval, DEFER_RETRY_MS * 2 ** Math.min(learning.deferCount - 1, DEFER_RETRY_STEPS));
    learning.nextCheckAt = new Date(now.getTime() + delay).toISOString();
  });
  return result;
}

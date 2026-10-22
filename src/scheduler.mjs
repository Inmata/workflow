import path from 'node:path';
import { atomicWrite, digest, fail, mutate, readState } from './store.mjs';
import { projectFor, learningConfig } from './learning-config.mjs';
import { projectData } from './learning.mjs';
import { reviewOnce } from './review.mjs';
import { runProcess } from './runner.mjs';

const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const quote = s => "'" + s.replaceAll("'", "''") + "'";
export async function schedulePreview(directory, root, entry) {
  const project = await projectFor(directory, root);
  const state = await readState(directory);
  const installed = Object.values(state.installs || {}).find(i => i.status === 'installed' && i.currentRoot);
  if (installed) entry = path.join(installed.currentRoot, 'bin', 'workflow.mjs');
  const { values: config } = await learningConfig(directory, project);
  const taskName = 'workflow-learning-' + digest(path.resolve(directory) + ':' + project.projectId).slice(0, 24);
  const script = path.join(projectData(directory, project), 'scheduler.ps1');
  const command = '& ' + quote(process.execPath) + ' ' + [entry, 'learning', 'tick', '--state-dir', path.resolve(directory), '--root', project.root].map(quote).join(' ') + '\nexit $LASTEXITCODE\n';
  const xmlText = '<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>workflow 项目知识维护</Description></RegistrationInfo><Triggers><TimeTrigger><Repetition><Interval>PT' + config.checkIntervalMinutes + 'M</Interval></Repetition><StartBoundary>' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</StartBoundary><Enabled>true</Enabled></TimeTrigger><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT' + (config.maxRunMinutes + 5) + 'M</ExecutionTimeLimit><Hidden>true</Hidden></Settings><Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>' + xml('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + script + '"') + '</Arguments></Exec></Actions></Task>';
  return { taskName, projectId: project.projectId, entry, script, command, xml: xmlText, checkIntervalMinutes: config.checkIntervalMinutes, maxRunMinutes: config.maxRunMinutes };
}
export async function installSchedule(directory, root, entry, execute = runProcess) {
  if (process.platform !== 'win32') fail('PLATFORM', '首版调度器只支持 Windows');
  const preview = await schedulePreview(directory, root, entry);
  const project = await projectFor(directory, root);
  if (!project.learning?.enabled) fail('PERMISSION', '先明确启用项目知识维护');
  const existing = await execute('schtasks.exe', ['/Query', '/TN', preview.taskName], {});
  if (existing.code === 0 && project.learning?.schedule?.taskName !== preview.taskName) fail('CONFLICT', '同名任务不属于本插件登记，未覆盖');
  await atomicWrite(preview.script, '\uFEFF' + preview.command);
  const file = path.join(path.dirname(preview.script), 'scheduler.xml');
  await atomicWrite(file, Buffer.concat([Buffer.from([255, 254]), Buffer.from(preview.xml, 'utf16le')]));
  const result = await execute('schtasks.exe', ['/Create', '/TN', preview.taskName, '/XML', file, '/F'], {});
  if (result.code !== 0) fail('SCHEDULER', '系统调度注册失败；维护数据保留');
  return mutate(directory, async state => {
    const current = await projectFor(directory, root, state);
    current.learning.schedule = { taskName: preview.taskName, entry: preview.entry, checkIntervalMinutes: preview.checkIntervalMinutes, maxRunMinutes: preview.maxRunMinutes, registeredAt: new Date().toISOString() };
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
  if (project.learning.lastCheckedAt && now - Date.parse(project.learning.lastCheckedAt) < config.checkIntervalMinutes * 60000) return { status: 'interval' };
  await mutate(directory, async state => { state.projects[project.projectId].learning.lastCheckedAt = now.toISOString(); });
  // 直接改配置文件也会在下次旧间隔检查时同步系统调度。
  if (project.learning.schedule && (project.learning.schedule.checkIntervalMinutes !== config.checkIntervalMinutes || project.learning.schedule.maxRunMinutes !== config.maxRunMinutes)) await installSchedule(directory, root, project.learning.schedule.entry, options.execute);
  try { return await reviewOnce(directory, root, options); }
  catch (error) { return { status: 'deferred', reason: error.code || 'IO' }; }
}

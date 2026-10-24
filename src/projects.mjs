import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { atomicWrite, canonical, digest, directoryIdentity, fail, id, mutate, readText, samePath, within, writeJSON } from './store.mjs';

export const BEGIN = '<!-- workflow:begin -->';
export const END = '<!-- workflow:end -->';
function git(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true, timeout: 2500 });
  return result.status === 0 ? result.stdout.trim() : null;
}
export async function identity(root) {
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if ((common === null) !== (top === null) || (common === null && await hasGitBoundary(root))) {
    fail('GIT_UNAVAILABLE', 'Git 仓库身份暂不可用；请核对 Git 可用性、仓库访问和信任设置');
  }
  return { directory: await directoryIdentity(root), gitCommon: common ? await canonical(common) : null, gitRoot: top ? await canonical(top) : null };
}
async function hasGitBoundary(root) {
  let cursor = root;
  for (;;) {
    if (await readGitMarker(cursor)) return true;
    const parent = path.dirname(cursor);
    if (samePath(parent, cursor)) return false;
    cursor = parent;
  }
}
export function identityEqual(a, b) {
  return JSON.stringify(a.directory) === JSON.stringify(b.directory) && (a.gitCommon === null ? b.gitCommon === null : b.gitCommon !== null && samePath(a.gitCommon, b.gitCommon));
}
export async function resolveProject(state, cwd) {
  const actual = await canonical(cwd);
  const actualGit = git(actual, ['rev-parse', '--show-toplevel']);
  const actualTop = actualGit ? await canonical(actualGit) : null;
  const candidates = [];
  for (const project of Object.values(state.projects)) {
    if (!project.enabled) continue;
    for (const tree of project.worktrees) if (within(tree.root, actual)) candidates.push({ project, tree });
  }
  candidates.sort((a, b) => b.tree.root.length - a.tree.root.length);
  for (const candidate of candidates) {
    const { project, tree } = candidate;
    if (actualTop && !samePath(actualTop, tree.identity.gitRoot || tree.root)) continue;
    // Non-Git projects also stop inheritance at a nested .git boundary.
    let cursor = actual;
    let nested = false;
    while (!samePath(cursor, tree.root) && within(tree.root, cursor)) {
      if (await readGitMarker(cursor)) { nested = true; break; }
      cursor = path.dirname(cursor);
    }
    if (nested) continue;
    try {
      if (identityEqual(tree.identity, await identity(tree.root))) return { project, worktree: tree.root, cwd: actual };
    } catch { /* Moved or inaccessible bindings are not inherited. */ }
  }
  return null;
}
async function readGitMarker(directory) {
  try { await lstat(path.join(directory, '.git')); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function agentsFile(root) {
  const file = path.join(root, 'AGENTS.md');
  try { const info = await lstat(file); if (info.isSymbolicLink() || info.nlink > 1) fail('LINK', 'AGENTS 是链接；先核对真实目标'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
export function blockFrom(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || text.indexOf(BEGIN, start + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0) fail('CONFLICT', 'AGENTS 管理区标记不完整或重复');
  return { content: text.slice(start, end + END.length), start, end: end + END.length };
}
// 对齐文件位置与 scan 同一规则：已登记的优先，否则有 docs/ 目录放 docs 下，没有放根目录。
async function alignmentPath(root, previous) {
  if (previous?.alignment?.docPath) return previous.alignment.docPath;
  const docs = await lstat(path.join(root, 'docs')).catch(() => null);
  return docs?.isDirectory() ? 'docs/WORKFLOW-ALIGNMENT.md' : 'WORKFLOW-ALIGNMENT.md';
}
async function portableBlock(root, previous) {
  const links = [];
  for (const relative of ['README.md', 'spec.md', 'SPEC.md', 'PLAN.md', 'LESSONS.md']) {
    if (await readText(path.join(root, relative)) !== null) links.push(`[${relative}](${relative})`);
  }
  return `${BEGIN}\nworkflow 已在本机明确接入；以当前会话 hook 提供的入口读取公共方法和对应角色指引。\n无 hook 入口时遵循项目已有约定，不由复制来的管理区推定接入。\n首次会话先做项目对齐：结论写入 ${await alignmentPath(root, previous)}，差异逐条询问用户，不擅自按任何一方执行。\n${links.length ? `已有资料：${links.join('、')}。\n` : ''}${END}`;
}
export async function enableProject(directory, root, options = {}) {
  root = await canonical(root);
  return mutate(directory, async (state, save) => {
    const previous = Object.values(state.projects).find(p => samePath(p.root, root));
    const currentIdentity = await identity(root);
    const file = await agentsFile(root);
    const original = await readText(file, '');
    const oldBlock = blockFrom(original);
    if (oldBlock && (!previous || digest(oldBlock.content) !== previous.managedBlockHash)) fail('CONFLICT', '发现手改或复制来的管理区；显式核对后再绑定');
    if (previous?.enabled && !identityEqual(previous.identity, currentIdentity)) fail('IDENTITY', '目录或 Git 身份变化；先停用旧绑定再明确接入');
    const block = await portableBlock(root, previous);
    const output = oldBlock ? original.slice(0, oldBlock.start) + block + original.slice(oldBlock.end) : `${original}${original && !original.endsWith('\n') ? '\n' : ''}${block}\n`;
    const projectId = previous?.projectId || id('project');
    const project = {
      schemaVersion: 1, projectId, root, identity: currentIdentity,
      worktrees: [{ root, identity: currentIdentity }], knowledgeRoot: root,
      ownerSessionId: options.owner || previous?.ownerSessionId || null,
      ownerExplicit: Boolean(options.owner || previous?.ownerExplicit), leadSessions: previous?.leadSessions || [],
      managedBlockHash: digest(block), enabled: true,
      coexistenceMode: options.coexistenceMode || previous?.coexistenceMode || 'bounded',
    };
    if (previous?.enabled) project.worktrees = previous.worktrees;
    if (!['bounded', 'pending-only'].includes(project.coexistenceMode)) fail('INPUT', '未知共存模式');
    // Persist intent before touching the managed area, so a crash remains diagnosable.
    await mkdir(path.join(directory, 'project-changes'), { recursive: true });
    await writeJSON(path.join(directory, 'project-changes', `${id('binding')}.json`), { projectId, root, beforeHash: digest(original), managedBlock: block, action: 'enable' });
    project.enabled = false;
    state.projects[projectId] = project;
    await save();
    await agentsFile(root);
    if (await readText(file, '') !== original) fail('CONFLICT', '准备接入时 AGENTS 已被用户修改，已保留原文和未启用绑定');
    if (original !== output) await atomicWrite(file, output);
    project.enabled = true;
    await save();
    return { status: 'enabled', projectId, root, agentsChanged: original !== output };
  });
}
export async function disableProject(directory, root) {
  root = await canonical(root);
  return mutate(directory, async state => {
    const project = Object.values(state.projects).find(p => samePath(p.root, root));
    if (!project) fail('PROJECT', '项目未登记');
    project.enabled = false;
    const file = await agentsFile(root);
    const original = await readText(file, '');
    const block = blockFrom(original);
    if (!block) return { status: 'disabled', projectId: project.projectId, agentsChanged: false };
    if (digest(block.content) !== project.managedBlockHash) return { status: 'disabled', projectId: project.projectId, agentsChanged: false, conflict: '管理区被用户修改，已保留原文' };
    const suffix = original.slice(block.end);
    await atomicWrite(file, original.slice(0, block.start) + (suffix.startsWith('\r\n') ? suffix.slice(2) : suffix.startsWith('\n') ? suffix.slice(1) : suffix));
    return { status: 'disabled', projectId: project.projectId, agentsChanged: true };
  });
}
export async function attachWorktree(directory, projectId, root) {
  root = await canonical(root);
  return mutate(directory, async state => {
    const project = state.projects[projectId];
    if (!project?.enabled) fail('PROJECT', '项目未启用');
    const treeIdentity = await identity(root);
    if (!project.identity.gitCommon || !treeIdentity.gitCommon || !samePath(project.identity.gitCommon, treeIdentity.gitCommon) || !samePath(treeIdentity.gitRoot, root)) fail('IDENTITY', '不是本项目的 Git worktree 根目录');
    if (Object.values(state.projects).some(p => p.projectId !== projectId && p.enabled && p.worktrees.some(tree => samePath(tree.root, root)))) fail('CONFLICT', 'worktree 已绑定其他项目');
    if (!project.worktrees.some(tree => samePath(tree.root, root))) project.worktrees.push({ root, identity: treeIdentity });
    return { status: 'attached', projectId, root, knowledgeRoot: project.knowledgeRoot };
  });
}
export async function setOwner(directory, projectId, sessionId) {
  return mutate(directory, async state => {
    const project = state.projects[projectId];
    if (!project?.enabled) fail('PROJECT', '项目未启用');
    if (!sessionId || typeof sessionId !== 'string') fail('INPUT', '需要明确知识负责人 sessionId');
    project.ownerSessionId = sessionId;
    project.ownerExplicit = true;
    return { projectId, ownerSessionId: sessionId };
  });
}

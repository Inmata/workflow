# Claude Code 适配

Claude Code 主会话可以直接担任 Lead，使用与其他智能体相同的[公共方法](../workflow.md)和[Lead 指引](../roles/lead.md)，负责范围、派工、审查协调、集成与知识处置。受委派的 Claude Code 会话也可按工作包担任 Worker 或 Reviewer；角色由任务决定。

## 安装

```powershell
node bin/workflow.mjs install --agent claude
node bin/workflow.mjs doctor --agent claude
```

安装把自有 handler 合并进 `~/.claude/settings.json` 的 `hooks` 段，保留其他插件的 hooks 和全部顶层配置（`env`、`model` 等）。Codex 与 Claude 的安装记录分开保存，可以只装一个，也可以同时装；`uninstall --agent <宿主>` 只撤自己注册的条目。

handler 用 `command` + `args` 数组（Node 可执行文件、入口脚本、`hook --agent claude --state-dir <状态目录>`），避免 Windows 路径在 shell 字符串里的引号歧义。发布副本、状态目录可与 Codex 共用；升级只更新所选宿主的注册，两个宿主都使用时须分别执行 `install --agent claude` 和 `install --agent codex`。已接入的项目绑定保留。

## 事件与回合

Claude Code 事件没有 `turn_id`，用宿主 `prompt_id` 关联一次用户输入及其后续事件。安装注册以下事件：

| 事件 | 本插件行为 |
| --- | --- |
| SessionStart | 注入 Lead 入口上下文；`source=compact` 时保留既有任务与预算 |
| UserPromptSubmit | 开新回合（新票据），注入 Lead 入口上下文 |
| PostToolUse | 只在命令是直接调用本插件 `signal` 时读取 stdout 中的信号并返回回执 |
| Stop | 放行，不要求经验处置或追加复盘轮次 |
| StopFailure | 按中断保存：撤销票据、保留任务待办，不自动续跑 |
| SessionEnd | 保存未完成任务待办，票据失效 |
| PreCompact / PostCompact | 只记录观测，不输出上下文 |

宿主提供 `prompt_id` 时用它建立回合；入口事件缺失该字段时本机生成，后续事件按当前会话回合关联，不因标识缺失丢弃工具回执。

`hookSpecificOutput.additionalContext` 只在 SessionStart、UserPromptSubmit、PostToolUse、Stop 返回；StopFailure、SessionEnd、PreCompact、PostCompact 仅记录观测，避免事件名不匹配的输出被宿主拒绝。

## 工具回执

Claude Code 的 Bash `tool_response` 把命令输出放在 `stdout`。只认 stdout，不读 stderr；普通输出、组合命令（`;`、管道）、其他插件的信号都不接受。Windows 下 `PowerShell`/`pwsh` 的直接调用（可带前导 `&`）同样识别。

## 差异与限制

- 加载与确认：在 `/hooks` 中核对 workflow 已加载，并处理宿主实际出现的确认提示；安装不代写信任记录。新会话的实际回调才证明执行，不套用其他宿主的 `modified` / `trusted` 状态。参见[官方 hooks 指南](https://code.claude.com/docs/en/hooks-guide)。
- 压缩：`PostCompact` 不支持附加上下文；压缩后的入口由 `SessionStart(source=compact)` 提供。
- 与 Codex 的 `Interrupt` 对应：Claude 用 `StopFailure` 保存中断。
- doctor 只核对本机注册与副本完整性；`discovery`、`trust`、`execution` 需要真实会话证据。

Codeg/ACP 侧的角色分工与委派约定见[Codeg 适配](codeg.md)。

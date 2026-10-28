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
| Stop | 回合结束核对：有在途包时挡一次要求继续等待或说明暂停；无在途包而任务未 task-end 时挡一次列出缺项；不要求经验处置或追加复盘轮次 |
| StopFailure | 按中断保存：撤销票据、保留任务待办，不自动续跑 |
| SessionEnd | 保存未完成任务待办，票据失效 |
| PreCompact / PostCompact | 只记录观测，不输出上下文 |

宿主提供 `prompt_id` 时用它建立回合；入口事件缺失该字段时本机生成，后续事件按当前会话回合关联，不因标识缺失丢弃工具回执。StopFailure、SessionEnd 缺少 `prompt_id` 时不推断当前回合：事件保留在 `deferred/` 按关联不足处理，任务仍 active 时留待办，不撤销新回合票据。

`hookSpecificOutput.additionalContext` 只在 SessionStart、UserPromptSubmit、PostToolUse、Stop 返回；StopFailure、SessionEnd、PreCompact、PostCompact 仅记录观测，避免事件名不匹配的输出被宿主拒绝。

## 工具回执

Claude Code 的 Bash `tool_response` 把命令输出放在 `stdout`。只认 stdout，不读 stderr；普通输出、组合命令（`;`、管道）、其他插件的信号都不接受。Windows 下 `PowerShell`/`pwsh` 的直接调用（可带前导 `&`）同样识别。

## 差异与限制

- 加载与确认：在 `/hooks` 中核对 workflow 已加载，并处理宿主实际出现的确认提示；安装不代写信任记录。新会话的实际回调才证明执行，不套用其他宿主的 `modified` / `trusted` 状态。参见[官方 hooks 指南](https://code.claude.com/docs/en/hooks-guide)。
- 压缩：`PostCompact` 不支持附加上下文；压缩后的入口由 `SessionStart(source=compact)` 提供。
- 与 Codex 的 `Interrupt` 对应：Claude 用 `StopFailure` 保存中断。
- doctor 只核对本机注册与副本完整性；`discovery`、`trust`、`execution` 需要真实会话证据。

## 宿主能力表

证据标注：实测 = 2026-10-23 本机 Claude Code 2.1.293 `claude -p` 隔离 hook 落盘探针，或同日 Codeg 委派探针（临时项目、只读任务）；文档 = [hooks 参考](https://code.claude.com/docs/en/hooks)、[工具参考](https://code.claude.com/docs/en/tools-reference)；记录 = 本机历史 transcript；unknown = 未取得证据。

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| Agent 工具子代理触发 SessionStart/UserPromptSubmit | 不触发；只有 SubagentStart/SubagentStop 和子代理内工具事件 | 实测 |
| 子代理事件区分字段 | `agent_id`、`agent_type`；`session_id` 与父会话相同 | 实测 |
| `--agent` 启动的主会话 | 只带 `agent_type`，不带 `agent_id`，按 Lead 处理 | 文档 |
| Codeg 委派的 Claude 子会话 | 独立会话，触发 SessionStart/UserPromptSubmit 并收到 Lead 入口上下文；事件与环境变量名都与 Lead 无区分；`role-claim` 后移出 Lead 列表 | 实测（Codeg 委派探针） |
| 原生提问工具名 | `AskUserQuestion` | 文档；`-p` 下模型未调用，PostToolUse 未实测 |
| Codeg MCP 提问工具名 | `mcp__codeg-mcp__ask_user_question`（保留连字符） | 记录 + 文档 |
| default 模式能否用 AskUserQuestion | CLI 可用，不限 plan | 文档 |
| 经 Codeg Claude ACP 能否用 AskUserQuestion | 不可用：该会话工具列表没有 `AskUserQuestion`，只有 Codeg MCP `ask_user_question`；以后 Codeg 声明 elicitation 能力时可能变化 | 实测（2026-10-23 Codeg Claude ACP Lead 会话工具列表） |
| auto 模式分类器与插件命令 | 2026-10-23 auto 下 `signal --base64`、`signal --input`、`context`、`knowledge capture`、`project align scan/apply` 均放行（CLI 两轮、Codeg Claude ACP 一轮，hook 记录 permission_mode=auto）；分类器只审模型发起的工具调用，hook 本身照常执行。历史记录中 `install`（改宿主配置）被拒 1 次；同形式的 document-learning `signal` 曾被拒，故放行不是保证 | 实测 + 记录 |
| auto 模式下 Codeg MCP 提问 | 可能被分类器拒绝；设置了禁用 `AskUserQuestion` 的规则时，会被判为绕过规则。此时改用普通文本编号提问，并先发 waiting-user | 记录 |
| 命令被分类器拒绝时 | 不重试、不换写法绕过；向用户说明哪条记录没写入，下一回合用当前 identity 补发 | 约定 |
| auto 模式下 Codeg 委派 | `delegate_to_agent` 可能被分类器拒绝（记录：委派 codex 被拒）；需要委派时请用户放行委派相关工具，见 [Codeg 接续](codeg.md#接续) | 记录 |
| 信号载荷脱敏 | 长 base64 串可能被宿主当作密钥脱敏成占位符，信号随之变成无效 JSON（记录：Codeg Claude ACP Lead 会话）；推荐常用动作用 `signal <action>` 子命令，结构化字段先写 JSON 文件再 `--input` | 记录 |
| 运行中追加消息 / 暂停 / 取消 / 中断恢复 / 批量 wait（Codeg 委派） | 见 [Codeg 能力表](codeg.md#宿主能力表) | — |

插件据此：带 `agent_id` 的事件整体放行，子代理调用本插件 signal 时只回一条“没有 workflow 身份、信号不记录”的说明；内置子代理结束时宿主会通知父会话，派给它的包填 `channel: builtin:<类型>`，Stop 不再要求阻塞等待。Codeg 委派子会话按工作包 `role-claim`；`AskUserQuestion` 与 Codeg MCP 名称在 PostToolUse 自动置 waiting-user，同一回合不重复修改。若某路径 PostToolUse 实际不触发，Lead 显式发 waiting-user。

Codeg/ACP 侧的角色分工与委派约定见[Codeg 适配](codeg.md)。

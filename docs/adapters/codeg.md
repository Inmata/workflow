# Codeg ACP 适配

## 接续

角色分工遵循[公共方法](../workflow.md)，由当前用户已确认的安排、实际类型、入口和并发上限决定。Codex、Claude Code、OpenCode、Pi 的名称不构成固定角色映射；例如 Claude Code 可以作为 Lead，通过当前可用且已授权的委派通道分配 Worker 和 Reviewer。不以泛泛执行请求替代缺失的新增角色决定。角色入口失效时可准备自包含交接文本，只有真实返回 task_id/handle、状态和成果才称已启动/送达。Codeg 委派不自动建隔离 worktree，明确传工作目录，先约定接口和基准。

使用实际可用的 Codeg 委派通道，不静默换路由/模型或修改全局配置。High 仅工具支持且已指定时设置，不自动升 Max。Jev 已配置不表示已调用，只在当前决策有用途且获授权时使用，报告真实结果；简单确定性工作不追加模型调用。网络连接问题可按当前本机约定尝试 7897 代理，不改全局网络。GitHub 用现有 gh/API 认证，只核对状态，不读凭据。

启动成功后仍核对实际进入实施；等待用户输入、未启动、失败和完成分别说明。失败先查子会话具体错误，不猜测计费、认证或能力；已知认证/余额/能力缺口解决对应条件，不反复重启。用户反馈在派发、等待、收结果和决策时接收并传递，无法追加消息则暂停相关动作，在接续任务带入。状态等待用事件或低频有限查询，不忙轮询、不重复播报；按需给子会话入口。

正常完成任务接续新委派会话，沿用原 worktree 和新明确基准，不用 resume_delegation 复活正常终态。中断按工具支持恢复或新建，先确认旧任务停止，带入已有 diff、检查点、有效证据和剩余事项。更换负责人先完成授权与所有权交接。用户中断业务只保存状态；workflow 的知识待办不能恢复业务命令。

## hooks

用户级宿主配置（Codex `hooks.json`、Claude `settings.json`）作为本版唯一注册途径，发布副本和文档一起固定版本。元数据不另外自动注册同一事件。安装不写 trust 记录；发现与信任需实际宿主核对。修改配置后新会话/新连接验证，复用旧连接可能仍加载旧配置。全局 CLI 版本不代表 ACP 内嵌版本。Claude 侧字段差异见[适配说明](claude.md)。

SessionStart/UserPromptSubmit 提供入口；PostToolUse 限定本插件 signal 输出；Stop 仅核对显式 delivering；Interrupt 保存而不续轮；压缩保留任务与预算。明确 transcript_path=null 才按后台过滤，缺字段不当后台；未知事件/损坏状态放行。等待工具或文本反问先 waiting-user，插件不读问号/关键词猜测。

Codex 0.160.1 的 PostCompact 不支持 additionalContext，安装不为它设置 additionalContextLimit，回调仅记录观测并保留状态。压缩后的入口和既有票据由支持附加上下文的 compact SessionStart 提供；是否实际触发该入口须在真实宿主核验，不能用合成压缩事件代替。

合成 fixture 只验证适配机械行为，不会冒充宿主实测。双插件各管自身回执和预算；往返/重复学习无法区分时项目切 pending-only，doctor 显示降级，保留待办，不停用对方。

## 等待与纠正

- 等待集合：一次调用批量传入所有在途 task_id，用有界 `wait_ms`；终态 ID 首次消费后移出集合，并在账本把该包记为 consumed。可能阻塞于用户的任务不用 `wait_ms=0` 无限等待。压缩后按 context `ledger` 判断哪些结果已消费，不重读。
- 中途纠正：能力表没有“运行中追加消息”时，先核对磁盘上已有成果，再取消该任务并确认已停止，然后以新基准、用户原话和已完成工作重新派发；同包返修沿用 packageId（插件自动 attempts+1），范围变化用新 packageId。
- 委派工作包写明 packageId，并要求子会话有 workflow 身份时先发 `role-claim`。未声明的子会话仍按 Lead 计入，会让知识负责人推定失效。

## 宿主能力表

证据标注：实测 = 2026-10-23 本机 Codex CLI 0.163.0 隔离 `CODEX_HOME` hook 落盘探针（`codex exec` 与 `codex app-server` JSON-RPC，模型经本地代理）；源码 = openai/codex 源码（经 DeepWiki）；unknown = 未取得证据，须真实宿主补测。Codeg 内嵌的 Codex ACP 版本可能不同。

| 能力 | Codex CLI / Codeg Codex ACP | 证据 |
| --- | --- | --- |
| 内置子代理（spawn_agent）事件 | 不触发 SessionStart；触发 SubagentStart、带 `agent_id`/`agent_type` 的 UserPromptSubmit、子代理内工具事件和 SubagentStop；`session_id` 与父会话相同，`turn_id` 为子代理自有 | 实测；装入本插件后状态只留父会话 |
| Codeg 委派子会话 | 独立会话，触发入口事件并收到 Lead 上下文；事件与环境变量名都与 Lead 无区分；用 `role-claim`，接受后移出 Lead 列表、`role` 记为声明值 | Claude、Codex 子会话均实测（2026-10-23 Codeg 委派探针） |
| 原生提问工具 hook `tool_name` | `request_user_input`；成功返回才有 PostToolUse，调用被拒（flag 关）时只有 PreToolUse；`codex exec` 下工具报错仍触发 PostToolUse | 实测 |
| MCP 提问 hook `tool_name` | 服务器名 `codeg-mcp` 的连字符被规范为下划线：`mcp__codeg_mcp__ask_user_question`；插件同时识别连字符写法以兼容其他版本 | 实测（同名本地替身 MCP 服务器） |
| `permission_mode` | 只由审批策略决定：`approval_policy=never` 为 `bypassPermissions`，其余为 `default`；Plan 协作模式也报 `default`，hook 无法识别 Plan | 实测 + 源码 |
| Plan 模式提问 | `request_user_input` 可用，PostToolUse 触发 | 实测（app-server `collaborationMode=plan`） |
| Default 模式提问 | flag 开：可用，PostToolUse 触发；flag 关：报 `request_user_input is unavailable in Default mode`。`doctor --agent codex` 只读报告该 flag | 实测 |
| hook 信任 | 未信任的 hook 不执行且无提示；`codex exec --dangerously-bypass-hook-trust` 可临时绕过，app-server 无此参数；`hooks/list` 返回 `currentHash` 与 `trustStatus` | 实测 |
| 运行中追加消息 | unknown；当前 Codeg 工具无追加消息入口，按“中途纠正”流程处理 | 工具清单 |
| 暂停 | 无 | 工具清单 |
| 取消 | `cancel_delegation` | 工具清单 |
| 中断恢复 | `resume_delegation`，只限被中断任务 | 工具清单 |
| 批量 wait | `get_delegation_status` 传多个 task_id，任一终态即返回 | 工具清单 |

| 提问路径 | Codex Plan | Codex Default（flag 关） | Codex Default（flag 开） | Claude CLI | Claude 经 Codeg ACP |
| --- | --- | --- | --- | --- | --- |
| 原生结构化提问 | 可用 | 不可用 | 可用 | 可用 | unknown |
| Codeg MCP `ask_user_question` | 可用 | 可用 | 可用 | 可用 | 可用 |
| 文本编号问题 | 可用 | 可用 | 可用 | 可用 | 可用 |

Codex 的计划模式不进入 hook 的 `permission_mode`，插件的计划会话提示和写入保护在 Codex 上只依赖任务声明的 `permissions.mode=plan|read-only`；Lead 在 Plan 模式下开任务须如实声明。Claude 经 Codeg ACP 一列仍待 [验收](../acceptance.md#6-030-真实宿主验收)。

## 旧入口

旧显示名为“协作开发”，旧调用标识是 `$efficient-parallel-development`。当前插件使用独立的行为文档，不创建第二套活跃技能副本。

接入项目时检查真实客户端加载位置，按项目只注入一套权威方法。已接入新版的项目若显式调用旧入口，应说明当前权威正文；确需兼容时改为短导航，不维护第二份全文。

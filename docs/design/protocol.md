# workflow 协议 v1

本文件说明首版接口。首版为 Node.js 24+、ESM、UTF-8、本地存储，无运行时依赖。日常使用先读[公共方法](../workflow.md)。字段的机械验证不代替需求、证据或写入授权。

## 存储和身份

状态根为 `--state-dir`，默认 `%LOCALAPPDATA%/workflow`（非 Windows 回退到用户数据目录）。`state.json` 的 `schemaVersion=1`，保存 `revision`、`projects`、`tasks`、`sessions`、`transactions`、`pending`、`install`。未知 schema 或损坏状态拒绝修改，hook 保守放行。锁通过独占创建获得，持有文件句柄；锁竞争立即返回 pending，不根据超时抢锁。锁释放保留可回收的诊断文件，不永久删除用户文件。

项目保存 `projectId`、`root`（realpath）、`identity`（目录 dev/ino/birthtime 和 Git 公共目录）、`worktrees`、`knowledgeRoot`、`ownerSessionId`、`leadSessions`、`managedBlockHash`、`enabled`、`coexistenceMode`；可选 `alignment` 见下文“项目对齐”。同名、remote 相同、拷贝入口均不建立绑定。子目录识别遇到独立 `.git` 即停止继承；worktree 必须显式关联且核对公共目录。项目重绑需要显式 enable。多个 Lead 首次冲突时清空自动推定的知识负责人，显式 `project owner` 后才可共享写入。

任务为项目级稳定 ID，记录 `goal`、`parentTaskId`、`lifecycle`、`repairIssued`、`deliveries`、`candidates`、`permissions`。任务 ID 只可经 signal 显式绑定；hook 不根据提示词猜任务，不把新用户回合自动视为新任务。任务由 `task-start` 建立，`task-end` 明确结束；完成可有知识待办。权限包含 `mode=write|read-only|plan` 和本任务资料相对路径 `allowedPaths`，不允许任意源代码或配置写入。

每个 session 保存 `projectId`、`taskId`、`turnId`、`ticket`、`interruptEpoch`、`revision`、`phase`、`interrupted`。新 `UserPromptSubmit` 的 phase 先置 unknown，票据更新；压缩恢复保留当前身份和预算。新回合与 task-start 必须显式声明任务目标/关联；跨 session 接续需要 task-start 指向既有 taskId，不能跨项目消费回执。

## 信号

`signal --input <JSON> | --base64 <UTF-8 JSON>` 只输出 `{workflow_signal: payload}`。仅 PostToolUse 在当前 shell 调用确实执行本安装副本的 `signal` 子命令后接受。解析限定 `tool_response` 的已知结构（直接 JSON、文本行、`output`、MCP `content[].text`），最多三层包装；不扫描文档、聊天、transcript 或任意嵌套键。其他插件命名空间不接受。混入多个不同信号拒绝。

所有信号字段：`schemaVersion:1`、`projectId`、`sessionId`、`turnId`、`taskId`、`ticket`、`interruptEpoch`、`expectedRevision`、`signalId`、`action`。身份/票据/epoch/revision 必须匹配。重复 signalId 仅在同一 session、turn、task 下重放已接受回执；不重放 Stop 的阻断决定。signalId 相同而正文不同拒绝。

| action | 附加字段 | 结果 |
| --- | --- | --- |
| task-start | goal；permissions；可选 parentTaskId | 建立/显式接续任务；不重置 repairIssued |
| phase | phase；delivering 时 deliveryId | 更新明确阶段，可随带 disposition |
| disposition | deliveryId；disposition | 处置当前交付 |
| task-end | 无 | 结束任务；未完知识保留待办 |

phase 为 `unknown`、`operation-only`、`executing`、`waiting-user`、`delivering`。`operation-only` 无经验回执要求。例行查看、指定提交 push、无冲突快进 pull 在文档中分流，插件不执行业务命令。

disposition：

- `no-new-learning`：非空 reason，可附 evidence；已有资料完整承接时直接使用。
- `updated`：非空 transactionIds；每笔必须与当前项目、任务、会话关联，全部文件成功，且候选已处置。普通编辑不产生可信事务。
- `pending-recovery`：pendingId 与 reason；待办必须已由知识事务或 `pending create` 为本任务创建，可定位候选和失败原因。

接受返回 `{accepted:true, revision, taskId, phase}`；拒绝返回 `{accepted:false, reason, revision?}`，不改变当前状态。hook 用 additionalContext 回传，命令退出成功不等于接受。

## Stop、中断和恢复

| 输入状态 | 动作 |
| --- | --- |
| 未绑定、未知、executing、waiting-user、operation-only、缺身份 | 放行 |
| delivering，有有效处置 | 放行 |
| delivering，首次漏处置 | 在同一状态锁内先持久化 repairIssued=true 和知识待办，再返回 decision=block |
| delivering，预算已用、stop_hook_active=true 或 pending-only 共存模式 | 留一项知识待办并放行 |
| Interrupt | 增 interruptEpoch、撤销票据、保存 business-incomplete；无模型续轮 |
| SessionEnd | 保存未完成，撤销当前票据；无模型续轮 |
| PreCompact/PostCompact/compact SessionStart | 保存/恢复既有身份；预算不变 |

PostCompact 不输出 additionalContext；压缩恢复上下文由支持该输出的 compact SessionStart 入口承载。同一回合的既有票据、修订号和任务预算保持不变，真实宿主是否触发该入口另行验收。

已用预算不随 delivery、turn、session、进程、压缩变化。无法确认重复 Stop 时放行。用户后续发言只建立新的未知回合，不恢复旧业务；context 最多返回一项当前项目 `knowledge-pending`，不返回可执行业务命令。恢复知识通过显式 task-start 接续原任务，保留权限和预算。四种停止计数（指定验证修复 1 次、审查返修 2 轮、诊断无新证据 2 轮、知识补偿 1 轮）分别执行，前面三种由角色记录处理。

## 知识事务

`knowledge inspect --project <root> --path <relative>` 输出 `{path,exists,content,fingerprint}`，缺文件 fingerprint=null。`knowledge apply` 输入身份字段与 `changes:[{path,baseline,content,responsibility,reason,evidence,candidateIds}]`、`candidates`。candidate 包含 `id,taskId,workPackage,conditions,finding,recommendation,evidence`。

仅知识负责人、当前有效 write 任务及 allowedPaths 内非敏感 UTF-8 文本可写。禁止绝对路径、`..`、Git/客户端配置、凭据文件、二进制；遇到链接/硬链接拒绝自动写入并要求先核对目标。检查祖先 realpath 防目录链接逃逸。新文件必须有实际正文。非敏感声明和证据由 Lead 核对；插件拒绝常见凭据内容，不复制全仓或完整聊天。

处理顺序：状态锁 → 校验当前身份/修订号 → 每目标文件锁 → 读取基线 → 保存前快照和后内容到本机事务目录并持久化 prepared → 再核指纹 → 同目录临时文件原子替换 → 记录 applied 指纹 → 持久化状态。每个文件独立，部分成功返回 partial；未成功项创建 knowledge-pending。单任务/候选稳定 ID 去重，同候选内容冲突拒绝，重复申请不追加相同经验。

恢复对照 prepared 的前/后指纹：等于后指纹则记已写；等于前指纹则保留未完成；第三种内容记 conflict；不自动重写用户改动。状态或快照持久化失败时不继续文件写入。`knowledge recover --transaction <id>` 只辨认结果并保存待办，续写由 Lead 基于新指纹显式申请，只处理尚未完成的候选。

锁文件在成功释放时移到状态根内的 retired-locks，临时失败产物保留。用户文件和安装副本不自动永久删除；uninstall 撤销自有注册并保留发布副本与记录。

## 项目对齐

对齐是接入后的准备工作，不新增 phase、不改 signal schema，也不建立任务。`project align scan` 只读扫描项目根并写本机状态 `state.projects[projectId].alignment`，不碰项目文件；`status` 只 stat 索引路径；`apply`、`decide`、`suggest` 才写 `docs/WORKFLOW-ALIGNMENT.md` 或根目录同名文件。

索引保存 `schemaVersion`、`generatedAt`、`docPath`、`docFingerprint`、`files`（`path/size/mtimeMs/kind`）、`directories`（索引文件父目录的 `path/mtimeMs`）、`decisions` 与 `findings`（只存 ID、状态和裁决时间）。扫描收集文档文本和工具链入口，排除 `.git`、`node_modules`、`bin`、`obj`、`dist`、`build`、`work`、`release-staging`、缓存和临时目录；默认 200 个文件，`--max-files` 最大 1000。符号链接、硬链接和目录逃逸不进入索引，在 `skipped` 报告原因。每个文件只取大小和 mtime，不读正文；对齐文档自身不进入索引，避免写回后自判过期。

`apply` 用 `workflow-alignment:begin/end` 标记区维护正文，标记外逐字保留；`decide`、`suggest` 按 `## 已裁决记录`、`## 结构建议` 标题定位小节，同一 ID 原位替换。写入前核对 `docFingerprint`（或输入 `baseline`），不一致返回 `CONFLICT` 并保留原文；写入使用同目录临时文件原子替换。首次 `apply`/`decide`/`suggest` 若索引为空，会先补一次只读扫描，保证后续变更检测有效。

`projectContext` 注入 `alignment:{path,exists,docExists,stale,changed,missing,directoryChanged,pendingDecisions,pendingFindings}`。`stale` 只由索引文件大小/mtime 和父目录 mtime 变化得出，不读正文；`pendingDecisions`/`pendingFindings` 以对齐文档表格为准并与索引状态合并，绕过 `decide`/`suggest` 直接写表也不会漏计；`exists=false` 时按未对齐处理。hook 不自动写项目文件，只提示 Lead 增量更新或逐条确认待裁决项。

## 安装和版本

`install --agent codex|claude [--user-dir <dir>]` 将发布白名单复制到状态根 `releases/<version>-<digest>`，再把状态根 `current` 目录联接指向该副本；hook 命令固定使用 `current/bin/workflow.mjs`，升级只切换链接目标，配置字符串和宿主信任不变。只合并宿主配置（Codex `hooks.json`、Claude `settings.json`）中 workflow 自有分组；不写信任记录。Codex 记录保留在 `state.install`（兼容旧版），两个宿主另存于 `state.installs`，分别安装与撤销。自有 handler 必须 command 与 args 同时一致才可移除，避免误删共享 Node 路径的其他插件。保存自有分组、配置前后指纹和逆向操作，备份只含自有条目。活动任务或 prepared 事务存在则延期更新。发布副本指纹不符或 `current` 指向与记录不一致时拒绝覆盖/使用，doctor 报告 unavailable。

AGENTS 仅有可携带的短管理区，不含机器绝对路径。disable 仅在管理区指纹一致时撤下，保留其他正文；用户改动时报告 conflict。uninstall 仅撤销与安装记录一致的自有 hooks；用户后来新增配置全部保留。doctor 分别报告 registration/discovery/trust/execution：未观测的宿主状态为 unknown，不能由配置存在推断可信或执行。

官方接口依据：[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[插件包装](https://developers.openai.com/plugins/build/plugins)。Claude Code 侧依据本机 2.1.292 内嵌的 hook schema：`prompt_id` 关联用户回合，`StopFailure` 承担中断保存，`hookSpecificOutput.additionalContext` 仅对 SessionStart、UserPromptSubmit、PostToolUse、Stop 生效。合成 fixture 明确标记 synthetic；宿主是否实际执行仍需在真实会话中核验。

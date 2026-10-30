# 另一台电脑的验收交接

本阶段完成代码、隔离自动化验证和仓库推送。真实宿主接入、模型调用、Windows 定时运行与实际项目试点留在另一台电脑；以下项目尚不能视为通过。

## 1. 拉取与准备

在 workflow 仓库执行，已有改动先保留，拉取冲突不要强制覆盖：

```powershell
git pull --ff-only
node --version
node --test test/*.test.mjs
node scripts/check-package.mjs
```

需要 Windows、Node.js 24+，以及已配置并能使用目标模型的 Codex CLI。前台可以用 Codex 或 Claude Code。确认目标电脑执行器的 `codex exec --help`、`codex features list`；支持性以 `learning doctor` 的实测结果为准。

## 2. 安装与选择一个试点项目

下面用 PowerShell 变量固定位置，替换项目路径；状态目录沿用该电脑已有安装，不要无意创建第二份状态：

```powershell
$workflowState = Join-Path $env:LOCALAPPDATA 'workflow'
$pilotRoot = 'D:/待试点项目'
node bin/workflow.mjs install --agent codex --state-dir $workflowState
node bin/workflow.mjs doctor --agent codex --state-dir $workflowState
node bin/workflow.mjs project enable --root $pilotRoot --state-dir $workflowState
```

使用 Claude Code 时安装参数改为 `--agent claude`。核对宿主 `/hooks` 发现和信任状态，打开试点项目的新会话确认真实回调。`doctor` 中配置存在、回调观测、宿主实际执行是不同证据，不能互相替代。

首次修改状态会保存 v1 原文备份。旧候选在 `learning enable` 时幂等导入；旧 `applied` 只能证明写入过，不算已验证经验。旧中断任务应为 `suspended`，旧会话不应挡住升级。

## 3. 设置参数，再做无模型检查

按[配置说明](learning.md#配置)准备 `learning-config.json`，自行决定阈值、频率、最长时间、模型和 profile：

```powershell
node bin/workflow.mjs learning config set --root $pilotRoot --state-dir $workflowState --input learning-config.json
node bin/workflow.mjs learning config get --root $pilotRoot --state-dir $workflowState
node bin/workflow.mjs learning doctor --root $pilotRoot --state-dir $workflowState
node bin/workflow.mjs learning schedule preview --root $pilotRoot --state-dir $workflowState
```

核对有效配置及来源、固定状态路径、期望模型/继承关系、隔离能力。这里不触发模型调用，也不注册系统任务；任何失败保留输出中的错误码，不靠放宽隔离继续。

## 4. 开始真实试点

```powershell
node bin/workflow.mjs learning enable --root $pilotRoot --state-dir $workflowState
node bin/workflow.mjs learning schedule install --root $pilotRoot --state-dir $workflowState
node bin/workflow.mjs learning status --root $pilotRoot --state-dir $workflowState
```

至少观察 5 个真实业务任务、跨 2 个日期、一次真实复盘。日期跨度是观察窗口，不要求为了验收造经验。可在材料已落盘、业务结束后用 `learning review --now` 提前做一次真实复盘；仍遵守每日额度。

| 场景 | 验收要看到的结果 |
| --- | --- |
| 普通任务无新材料 | 直接交付；Stop 不要求额外复盘、不强制凑经验 |
| 达阈值前结束会话 | 例如 9 份关闭会话，再开新会话仍见 9 份；数量不足时由年龄触发 |
| 修改配置 | 阈值、频率、最长时间与模型选择来自有效配置，下一次运行采用新值 |
| 已验证方法反复成立 | 事件、日期、证据可核对；重复摘要与 adopted 不增加成熟度 |
| 用户明确纠正旧经验 | 指定知识立即不再默认召回，复盘后保留修订原因与旧证据 |
| 手动提高重要性 | 相关任务排序变化，成熟度不跟着提高；无关任务不强行注入 |
| 用户旧偏好被明确替代 | 保存新偏好与替代依据；旧偏好停止召回 |
| 模型超时或输出失败 | 材料仍 pending，已启动次数计入当天额度，无循环重试 |
| 写入时用户编辑 | 保留用户文件，待恢复；不把半批结果投入召回 |
| 活动/只读/计划任务 | 后台写入延期；不干扰业务 |
| 下次会话使用经验 | `explain` 能说明选中和排除原因；重要修订通知只出现一次 |
| 重启与重新登录 | 系统任务存在、固定入口有效，检查恢复且不会并发复盘 |

## 5. 记录结果与问题

记录所用 Git 提交、Node/CLI 版本、宿主类型、有效配置、真实运行 ID、状态、耗时和可获取的 usage。缺失用量记未知，token 不等于账单。重点看是否减少重复犯错、是否漏召回相关经验、是否打断工作。

出错时保留原始材料和运行记录，给出触发步骤、期望、实际结果及错误码；不要传凭据、登录配置或整个聊天历史。先停止维护：

```powershell
node bin/workflow.mjs learning disable --root $pilotRoot --state-dir $workflowState
node bin/workflow.mjs learning schedule remove --root $pilotRoot --state-dir $workflowState
```

有完整提案的中断运行可用 `learning recover --run <ID>` 恢复，不再调用模型。外部编辑冲突需先核对文件与保存提案，再用 `learning resolve --run <ID> --keep|--discard` 决定保留还是作废；只有本运行的知识文件均未偏离写入前快照时才能作废。不要对同一冲突反复执行 `recover`。不要删除 inbox、state 或快照来“修好”状态。

验收后再决定是否扩大项目范围、调整默认参数或发布新版本。当前本机材料不自动跨电脑同步，换电脑仍需各自建立绑定；Git 只携带项目配置与正式知识。

## 6. 0.3.0 真实宿主验收

本节验证分流、账本、门禁、角色声明和提问路径。合成测试已覆盖机械行为，以下每项结论分别标注“自动验证 / 真实宿主验证 / 未知”。Claude Code 与 Codex 各作一次 Lead。

先补齐[Codeg 能力表](adapters/codeg.md#宿主能力表)与[Claude 能力表](adapters/claude.md#宿主能力表)中的 unknown 格：用临时 hook 落盘脚本（仅本机、事后删除）记录 `hook_event_name`、`agent_id`、`agent_type`、`tool_name`、`permission_mode`。

| 场景 | 通过条件 |
| --- | --- |
| Codex spawn_agent 子代理 | 子线程事件带 `agent_id`；插件不开回合，状态不变 |
| Codeg 委派子会话 | 子会话发 `role-claim` 后入口注入 Worker/Reviewer 上下文 |
| 提问置 waiting-user | Codex 原生、Codex 经 Codeg MCP、Claude `AskUserQuestion`、Claude 经 Codeg MCP 四种组合分别记录 PostToolUse 原文 `tool_name`，确认 phase=waiting-user |
| Codex Plan / Default | 分别记录 hook 上报的 `permission_mode`；Default 且 flag 关闭时通过 Codeg MCP 或文本提问完成一次首次对齐，含跨回合 decide |
| Claude ACP | 在 Codeg 的 Claude ACP 中确认 default 模式能否调用 `AskUserQuestion` |
| 压缩 | 压缩后 compact SessionStart 上下文含 `ledger`，Lead 不重复派工、不重读 consumed 结果 |
| 门禁 | delegated 任务缺审查或验证时 task-end 返回 GATE 与 missing；显式 waivers 后接受 |

2026-10-23 Codex CLI 0.163.0 隔离探针已完成（真实宿主验证）：spawn_agent 子代理事件带 `agent_id`，装入本插件后状态只留父会话；原生提问 `tool_name=request_user_input`，Codeg 同名 MCP 为 `mcp__codeg_mcp__ask_user_question`，两者 PostToolUse 均触发；`permission_mode` 只反映审批策略，Plan 协作模式也报 `default`。详见 [Codeg 能力表](adapters/codeg.md#宿主能力表)。Codeg 委派探针（2026-10-23，临时项目）：Claude 子会话收到 Lead 入口上下文并被计入 Lead 列表，发 `role-claim` 后移出（真实宿主验证）；Codeg Claude ACP 下 Lead 没有 `AskUserQuestion`，只能用 Codeg MCP 提问；Codex 子会话同样收到 Lead 上下文，`role-claim`（`--base64`）回执 accepted，状态中 role=reviewer、leadSessions 为空（真实宿主验证）；该子会话需自行查文档拼出 signal 命令，Lead 上下文已补充命令格式。Claude auto 模式分类器（2026-10-23，真实宿主验证）：CLI 与 Codeg Claude ACP 下 signal（base64/文件两种）、knowledge capture、align scan/apply 均未被拦；发现模型自发写成 `cd … && node … signal` 时信号被静默丢弃，已改为回执提示单独直接调用。门禁与账本提示（2026-10-23，Claude Code 2.1.293 `claude -p` auto，真实宿主验证）：delegated 任务缺审查与验证时 task-end 返回 `GATE`，missing 为 `review:w1`、`validation`，被拒后 revision 不前进；补 validation 与 waiver 后接受。替身 `codeg-mcp` 返回 Codeg 同构的 `{tasks:[…]}` 文本时，PostToolUse 给出“已终态移出”和“已结束未记账”两类提示。压缩与续接：`/compact` 后 compact SessionStart 正常触发；`claude -p` 每次结束都发 SessionEnd，任务被挂起，旧版入口只给 active 任务附账本，续接会话看不到 ledger。已改为挂起任务也附账本（标 lifecycle）；重装后复测通过：真实 `/compact` 加续接后入口含 `{"lifecycle":"suspended","route":"delegated","packages":["w1 worker consumed ref1 - 0","w2 worker dispatched - - 0"]}`，Lead 判断沿用原 taskId 续接、只等 w2，不重读 w1。同一交互会话内不经 SessionEnd 的压缩未实测。收益对照仍须实跑。

收益对照：小修改、可拆分功能、强依赖修改三类任务，各在“Lead 直做”和“分工流程”下跑一次，记录交付是否通过、返工次数、Lead 重复读取的结果数和端到端耗时；token 只记可获取数据，不当账单。结果决定下一轮是否值得扩展账本字段，本节不预设。

### 剩余验收（2026-10-23 交接）

代码与上述记录已在 main（a4905d1）。另一台电脑按第 1、2 节拉取并 `install --agent claude`、`install --agent codex` 后继续以下几项，三项都要求 Lead 是顶层会话，Codeg 委派出的会话不能再委派：

1. Codeg 顶层会话的真实委派：确认 hook 收到的 `get_delegation_status` 原文结构和两类账本提示。
2. Codex 作为 Lead：走一次门禁（GATE 与 waivers）和一次提问。
3. Codex Default 模式（`default_mode_request_user_input` 关闭）下完成一次首次对齐，含跨回合 decide。
4. 同一交互会话内、不经 SessionEnd 的压缩。
5. 收益对照（已取消，见本节末）。

2026-10-23 复测（Codeg 顶层 Codex 会话，Codex CLI 0.164.0，临时仓库 workflow-probe，真实宿主验证）：第 1、2 项通过。Lead 发 task-start（rev 2）后用 `delegate_to_agent` 派 Codex Worker，Worker `role-claim` 被接受，状态中 role=worker，owner 与 leadSessions 仍只有 Lead。`get_delegation_status` 的两类提示原文：w1 完成时为“包 w1 的委派已结束：读取结果后在下一次 packages 中记为 delivered/consumed。”；记为 consumed 后再查为“等待集合含账本已终态的包（w1）：下次查询移出这些 task_id，不重读结果。”。原生 `request_user_input` 提问两次；不派审查直接 task-end 返回 GATE，missing 为 `review:w1`、`validation`，revision 不前进；补 validation 与 review waiver 后接受（rev 9，lifecycle=complete）。会话 `permission_mode=default`，但本机 `default_mode_request_user_input=true`，不算第 3 项。发现：Lead 第一次提问未说明审查是 delegated 路线的固定要求，用户需追问一次；Lead 还在提问前手动发了 `phase=waiting-user`，PostToolUse 也会置该状态，二者重复但无害。

同日后台复盘隔离适配 Codex 0.164：`features list` 不再接受 `--profile`；`unified_exec` 只能由托管 requirements 关闭，用户 `-c` 后仍报 true，但抓取实际请求确认 `shell_tool=false` 时已无 `exec_command`/`write_stdin`，不再以该开关判定；`multi_agent=false` 不再移除 `spawn_agent` 等工具，需加 `agents.enabled=false`。修正后 `learning doctor` 为 `capabilities-verified`，实际请求只剩 `request_user_input`。

同日第 4 项通过（Codeg Claude ACP 顶层会话，permission_mode=auto，真实宿主验证）：task-start 与 packages 后在同一会话 `/compact`，全程无 SessionEnd 观测；`SessionStart:compact` 入口含 `{"lifecycle":"active","route":"delegated","packages":["w1 worker consumed ref1 - 0","w2 worker dispatched - - 0"]}`，Lead 判断不重派、不重读 w1。入口与每次 UserPromptSubmit 都会推进 revision（回执 3，压缩后入口 4、5、6），Lead 应以最新入口的 `expectedRevision` 为准。收尾时 delegated 任务因 w2 未交付，以 `terminal:w2`、`review`、`validation` 三条 waiver 结束（rev 8，lifecycle=complete）。

第 3 项首次尝试未完成（Codeg Codex ACP 0.160.1，flag 已关）：该会话首回合 SessionStart、UserPromptSubmit 均未进入任何 hook（workflow、文档学习都没有注入，状态无该会话），同会话后续 Stop 被记录。根因（经 ACP 版 `codex app-server` 的 `hooks/list` 核实）：Codex 的 hook 信任键按“事件:分组序号”编号，重装时 install 先删除自有分组再追加到末尾，与文档学习插件对调了序号，两边的 SessionStart、UserPromptSubmit、PostToolUse、SessionEnd 都变成 `trust=modified` 而不执行。在 `/hooks` 重新信任后恢复；install 已改为重装时把自有分组放回原序号。Lead 发现 identity 为 null 后停下报告，没有绕过插件手写文件，行为符合预期。另：仓库无 `docs/` 时 scan 按设计登记根目录 `WORKFLOW-ALIGNMENT.md`。

同日第 3 项通过（重新信任后的新会话，Codeg Codex ACP 0.160.1，`permission_mode=default`，flag 关闭，真实宿主验证）：入口 identity 非空；scan 后发 waiting-user，用文本编号问题提问 3 条，没有调用提问工具；用户在下一回合答“1A 2A 3A”，Lead 依次 `project owner`、`apply`、D1/D2 `decide`（均 recorded），status 为 `pendingDecisions: 0`，随后 task-end 被接受，任务 complete。发现：① `decide` 写“## 已裁决记录”这类末节时越过管理区结束标记、把记录追加到文件末尾，且不清理“- 暂无”占位，已修复并补测试；② 旧 Lead 会话留在 leadSessions 中时 owner 为空，首次 apply 返回 `OWNER`，需先 `project owner`，属设计行为但增加首次对齐的步骤；③ Lead 在 `.local/` 写输入 JSON 会让 status 报 `stale`（`directoryChanged: [".local"]`），不影响对齐结论。验收结束后已把 flag 恢复为 true。

1、2 可在 Codeg 里用 Codex 开顶层会话、选一个已接入的临时仓库，粘贴：

```text
你是这个仓库的 Lead（已启用 workflow 插件）。这是一次插件验收，请按协议真实走一遍分工流程。规则：每条插件命令都单独直接执行，不加 cd、&&、; 或管道；JSON 先写到 .local/ 下，再用 `signal --input <文件>` 发送；每次发送都用最新入口里的 expectedRevision（每次用户发言都会推进 revision，不要沿用上一条回执的值）。

业务：在 README.md 末尾加一行 "Codex lead probe."
1. task-start：route=delegated，allowedPaths ["README.md"]，taskId 自己定。
2. 用 delegate_to_agent 派一个 Worker（packageId=w1），让它加这一行、不提交，并让它先发 role-claim。
3. 立刻发 packages：w1 role=worker status=dispatched handle=<返回的 task_id>。
4. 用 get_delegation_status 等 w1 完成，把每次调用后的 "workflow 提示" 原文记下来。
5. 核对 git diff，然后发 packages：w1 status=consumed，deliveredRef 取 `git hash-object README.md` 的结果。
6. 再查一次 get_delegation_status（task_ids 里仍包含 w1），记下提示。
7. 先用提问工具问我一个问题：“是否跳过审查？”，等我回答。
8. 不派审查，直接发 task-end，记下 GATE 回执；再加上 validation 和 waivers 重发一次 task-end。
最后列一张表：步骤 | 命令 | 回执或提示原文（ticket 只保留前 4 个字符）。
```

2026-10-23 结论：第 1~4 项通过；第 5 项收益对照经用户决定取消，不作为发布条件。据此发布 0.3.0。`docs/research/` 的调研报告按约定不入库，需要时手动拷贝。

## 7. 0.5.0 真实宿主验收

2026-10-25，本机从 0.4.1 升级到 0.5.0（0.4.2 已提交但本机未安装），安装前备份了状态和两个宿主的配置。两个模拟仓库从同一初始提交建立并接入：`drift-sim` 给 Codex，`drift-sim-claude` 给 Claude。每个仓库有 `.spec/calc/spec.md`，`code:` 管辖 `src/calc.mjs`。

| 步骤 | 操作 | Codex（Codeg 顶层，真实宿主验证） | Claude（Codeg Claude ACP，claude-sonnet-5.5，真实宿主验证） |
| --- | --- | --- | --- |
| 1 | 改 `src/calc.mjs` 不改 spec，发 task-end | GATE，missing 含 `spec:calc`，findings 为 drift 并列出该提交 | 同 |
| 2 | 用 waivers 豁免 `spec:calc` | 拒绝：“spec 漂移不能豁免：更新 spec，或用 Spec-OK 空提交写明理由” | 同 |
| 3 | 更新 spec 后 task-end | accepted（rev 3） | 同 |
| 4 | 再改代码，做 `Spec-OK: calc` 空提交 | 空提交前报 drift，之后 ok，accepted（rev 5） | 同 |
| 5 | 门禁无缺项但不发 task-end 就结束回合 | Stop 挡一次，提示“任务 sim-t3 门禁已无缺项但仍为 active……”；续轮发 task-end accepted（rev 7） | 同 |

Stop 只挡一次的证据（Claude transcript）：只有 1 条 `hook_blocking_error` 和 1 条 isMeta 的 “Stop hook feedback”；2 条 `stop_hook_summary` 分别是挡下和 task-end 后的第二次 Stop（放行）；全程只有一个 promptId，续轮没有产生新的用户回合。Codex 侧提示以 `<hook_prompt>` 注入，同样没有新回合；第二次 Stop 放行没有单独观测。

Worker 与 Reviewer（drift-sim）：Codex Worker 包 w-mul 增加 `mul` 和测试，同步更新 spec，交付行“文档影响：calc：已更新”，deliveredRef a1c34fb。Claude Reviewer 只读审查，按 spec 验收逐条核对（`sub` 只能由代码推断，原本就没有测试），核实文档影响申报属实，spec check `ok:true`，结论 ACCEPT。Reviewer 另报文件头注释没提乘法、`sub` 缺测试，这两条不阻塞。

环境偏差：

- 用 clone 建第二个模拟仓库时，onboard 因复制来的 AGENTS 管理区报 blocked，这是预期的保护；改用 `git archive` 从初始提交重建后接入。
- Codex 沙箱里 `.git` 只读，提交需要提权；沙箱用户不是仓库所有者，git 报 dubious ownership，spec check 只返回 `error:"git"`。之后 spec check 在 `detail` 里附上 git 的第一行报错。Worker 用 `GIT_CONFIG_*` 环境变量临时设置 `safe.directory`，没有改全局配置。
- 模拟仓库的 `npm test`（`node --test test/`）在 Node 24.19 报 Cannot find module，与 workflow 无关，用 `node --test` 代替。

结论：0.5.0 的 spec 门禁、不可豁免、Spec-OK 放行、Stop 回合结束核对、Worker 文档影响申报和 Reviewer 对照 spec 核对，在两个宿主上都通过。

## 8. 本仓维护的验证场景与命令（F10）

本节只服务本仓源码维护：一次改动该跑什么、怎样算失败、哪些限制仍然存在。它不改变第 1–7 节的真实宿主验收结论；命令退出成功和合成样例都不能替代真实宿主、模型与用户环境。以下命令都在仓库根目录运行，需要 Node.js 24+。

### 8.1 场景对应表

按改动影响选择受影响场景，不要求每次全跑。“失败判定”说明什么情况不能算通过；“边界”列出该检查不能证明的内容。

| 场景 | 选择（命令） | 失败判定 | 边界 |
| --- | --- | --- | --- |
| 接入流程、执行器预检 | `node --test test/onboard.test.mjs test/runner.test.mjs` | 任一用例失败或退出码非 0；核心接入失败时执行器调用数必须为零 | 使用假执行器，不调用模型；涉及 junction/目录联接的删除路径未验证 |
| 命令生成与参数转义 | `node --test test/entry.test.mjs test/install.test.mjs test/runner.test.mjs test/hooks.test.mjs`，受影响时加 `test/signal.test.mjs` | 任一用例失败或退出码非 0；特殊参数未按原值往返即失败 | 无 PowerShell 的机器跳过真实 shell 用例；POSIX 用例在 Windows 跳过，不能互相替代 |
| 任务分流、门禁与信号 | `node --test test/protocol.test.mjs test/gate.test.mjs test/signal.test.mjs` | 任一用例失败；新任务缺 route 未被拒绝、历史任务无法续接都算失败 | 历史无 route 兼容只由合成样本验证；不覆盖真实宿主回合 |
| 知识缓存与学习事务 | `node --test test/learning.test.mjs` | 命中、失效或事务断言失败 | 等长且保留时间戳的编辑不保证实时可见，这是已接受边界；不调用真实模型 |
| 锁、对齐、spec 与 Hook 生命周期 | `node --test test/hooks.test.mjs test/spec.test.mjs test/alignment.test.mjs test/integration.test.mjs` | 任一用例失败；故障样本没复现时只能标“未复现”，不能写通过 | 慢 Git 为注入延迟；宿主 10 秒终止由计时器模拟；读取故障只测了 EACCES；junction 等价性未验证 |
| Hook spec 预检与 Git 预算 | `node --test test/hooks.test.mjs test/gate.test.mjs test/spec.test.mjs test/protocol.test.mjs test/integration.test.mjs` | 任一用例失败；慢 Git 预检期间竞争调用未取得锁、卡住 Git 超过宿主窗口、多次慢调用累计超窗、干净预检后受管文件/提交/ref/会话/索引变化仍被当成通过、`spec-check:stale` 被豁免，或 Stop 在无法确认时报“门禁无缺项”都算失败 | 4 秒 Git 调用总预算为代码常量并按绝对截止时间计算：同步文件快照读取不能中断且会消耗剩余预算、缩短后续 Git 可用时间，锁内复核另有 1 秒独立预算，故 4 秒不保证预检或 Hook 总时长；未在真实超大仓库验证；宿主 10 秒上限由子进程计时观察，不是真实宿主终止；索引快照按大小与 mtime，不承诺还原 mtime 的极端写入；大文件仍退回大小与 mtime；慢 Git 仍为注入延迟 |
| 交付前全量行为测试 | `npm test` | 任一测试失败或退出码非 0；跳过项要在结论中列出，不能当通过 | 测试中的删除改道未在 junction/目录联接上验证；用例数量和耗时随代码与环境变化 |
| 仓库一致性（语法、发布清单、版本、hook 声明、文档链接） | `npm run check` | `ok:false` 或退出码非 0 | 不证明业务行为、外部链接可达或真实宿主回调 |
| CLI、安装或 Hook 生命周期 smoke | `npm run demo` | 退出码非 0 或任一断言失败 | 只有 `synthetic-isolated-cli`；不认证真实 ACP、模型或宿主；`result.json` 随临时目录清理，终端输出或摘要才是可留存证据 |
| 组合调用与留存 | `npm run verify -- check demo --out <目录>` | 选中的必需检查失败或未完成时退出码为 1；参数错误为 2 | 只组合已有命令并留存结果，不新增断言，也不认证真实环境；`scripts/` 不随 npm 发布副本安装 |

只想跑测试名带 F05、P01 或“检查预算”标记的用例时，可对相关文件加 `--test-name-pattern="F05|P01|检查预算"`。

全量测试和 demo 是否通过以当前提交的实际输出为准；Windows 会跳过仅 POSIX 的用例，跳过项不能当通过。测试数量和耗时随代码与环境变化，不设固定门槛。

### 8.2 组合入口的语义

`npm run verify` 调用 `scripts/verify.mjs`（只在仓库源码中可用，`scripts/` 不随 npm 发布副本安装），它读取 `package.json` 的 `check`、`test`、`demo` 脚本并按此顺序执行：

- 默认运行全部三项；显式列出子集（如 `npm run verify -- check demo`）时只运行选中项，其余在摘要中标为“未运行（未选择）”，不计入必需项。
- 退出码：选中检查全部通过为 0；任一失败、脚本缺失或运行被终止为 1；参数错误为 2。某一项失败后仍继续执行其余项，保留完整结果。
- 每项原始输出写到 `<out>/<id>.log`，摘要写到 `<out>/summary.json` 和 `<out>/summary.md`。摘要记录 HEAD、未提交变更数（含未跟踪文件）、Node 与平台、逐项状态/退出码/耗时/日志路径、未运行原因和边界说明。
- `--out` 默认指向系统状态目录（Windows 为 `%LOCALAPPDATA%\workflow-verify\<仓库目录名>\<UTC 时间>`），避免报告随临时目录清理消失，也避免把日志混进仓库；需要交付或 CI artifact 时用 `--out` 指定。
- demo 在摘要中固定标为“合成 smoke”，不能由它的退出码推断真实 ACP、模型或宿主联调已完成。

### 8.3 合成 smoke 的契约

`examples/demo.mjs` 是隔离 CLI 冒烟，不是真实宿主联调。维护它时注意两个契约，否则会出现看似产品回归的失败：

- task-start 必须显式声明 `route: 'lead-direct'`；新任务缺 route 会被拒绝（`ROUTE`）。
- 任务门禁已无缺项但仍为 active 时，第一次 Stop 返回 `decision: 'block'`；发 task-end 后第二次 Stop 才返回 `{}`。把第一次写成 `{}` 会让 demo 失败，也不应为了让它通过而放宽断言。

当前实现按上述契约执行。`npm run demo` 退出 0 只说明合成隔离 CLI 流程通过，不说明真实 ACP、模型或用户宿主已验证。

### 8.4 运行前提与删除边界

- 测试、demo 和安装流程会删除或替换文件：`src/install.mjs` 对符号链接使用非递归删除，其他受管条目使用递归删除；测试清理和 demo 也会删除临时目录。没有外部删除保护时，这些都是真实删除。
- 仓库不提供删除保护适配器。若本机需要把 Node 删除 API 改道到回收站，需自行通过 `NODE_OPTIONS=--import=<适配器>` 注入，并保证 Hook 或测试子进程继承该变量；`npm run verify` 不保证外部预置，子进程覆盖 `NODE_OPTIONS` 时预置会失效。
- 这类适配器对 junction/目录联接的等价性未验证；涉及链接目标的删除只能写“删除保护未完整确认”。
- 本节全部为本地进程级或合成验证。真实宿主回调、实际模型、用户配置与外部系统仍按第 6、7 节单独验收。

### 8.5 维护规则

- 新场景先复用已有命令；确实没有可观察检查时才补最小用例，并回填 8.1。一次性调查输出不自动变成长期门槛。
- 命令或脚本改名时同步本表和 `package.json`；组合入口直接读取 `package.json`，缺脚本会以非零报告，不会静默跳过。
- 不需要每次全跑：按改动选择受影响场景，交付前至少运行受影响场景和 `npm run check`；涉及 CLI、安装或 Hook 生命周期时加 demo（合成）；跨模块或范围不确定时跑全量。
- 场景不再代表真实需求，或维护成本持续高于收益时调整、退役；不以套件规模作为成功指标。
- 证据留在命令输出和 `npm run verify` 的 `<out>/summary.md`、`<out>/*.log` 中；不要把个人机器路径、会话记录或一次性批次日志写进本文件。

### 8.6 CI

未规划。仓库远端是 GitHub，但已跟踪文件中没有 `.github` 工作流；Actions 是否可用、账户额度、runner 环境和 secrets 策略均未确认。未确认托管条件前不写 CI 配置，也不假设平台能力。若以后确认，首选复用 `npm run verify -- --out <artifact 目录>`，把摘要和原始日志作为 artifact 留存；demo 保持合成标识，需要 PowerShell 或回收站适配的检查要先确定 runner 环境，跳过的用例不能当通过。

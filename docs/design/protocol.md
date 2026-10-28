# workflow 协议 v1

本文件说明首版接口。首版为 Node.js 24+、ESM、UTF-8、本地存储，无运行时依赖。日常使用先读[公共方法](../workflow.md)。字段的机械验证不代替需求、证据或写入授权。

## 存储和身份

状态根为 `--state-dir`，默认 `%LOCALAPPDATA%/workflow`（非 Windows 回退到用户数据目录）。状态文件升级为 `schemaVersion=2`，信号仍为 v1。首次持久化前把 v1 原始字节备份到 `migrations/`，中断任务迁为 suspended，裁剪无效会话归属。未知 schema 或损坏状态拒绝修改，hook 保守放行。锁通过独占创建唯一票据获得，短暂争用按总预算等待重试（hook 内结束事件 700ms，其余 1500ms，低于宿主超时），预算耗尽保守放行；不按年龄抢活锁，只在操作系统确认持有进程已退出（ESRCH）时按该票据自己的唯一名归档。锁释放保留诊断文件。后台学习的数据与配置见[学习协议](../learning.md)。

项目保存 `projectId`、`root`（realpath）、`identity`（目录 dev/ino/birthtime 和 Git 公共目录）、`worktrees`、`knowledgeRoot`、`managedBlockHash`、`enabled`、`coexistenceMode`；可选 `alignment` 见下文“项目对齐”。同名、remote 相同、拷贝入口均不建立绑定。子目录识别遇到独立 `.git` 即停止继承；worktree 必须显式关联且核对公共目录。项目重绑需要显式 enable。0.4.1 起取消知识负责人：同一项目的任何 Lead 会话都可共享写入，并发冲突由 baseline 指纹、写锁和事务恢复处理；旧状态里的 `ownerSessionId`、`leadSessions` 字段保留但不再使用。

任务为项目级稳定 ID，记录 `goal`、`parentTaskId`、`lifecycle`、`repairIssued`、`deliveries`、`candidates`、`permissions`，并用 `updates` 追加记录显式目标/权限变更。任务 ID 只可经 signal 显式绑定；hook 不根据提示词猜任务，不把新用户回合自动视为新任务。任务由 `task-start` 建立，`task-end` 明确结束；完成可有知识待办。同任务需要显式改 `goal` 或权限时用 `task-update`，不靠重发 `task-start`。权限包含 `mode=write|read-only|plan` 和本任务资料相对路径 `allowedPaths`，不允许任意源代码或配置写入。

每个 session 保存 `projectId`、`taskId`、`turnId`、`ticket`、`interruptEpoch`、`revision`、`phase`、`interrupted`。新 `UserPromptSubmit` 的 phase 先置 unknown，票据更新；压缩恢复保留当前身份和预算。新回合与 task-start 必须显式声明任务目标/关联；跨 session 接续需要 task-start 指向既有 taskId，不能跨项目消费回执。

## 信号

两种写法都只输出 `{workflow_signal: payload}`，CLI 不写状态：

- 子命令（推荐）：`signal <action> --session <sessionId> --turn <turnId> --id <signalId> [字段参数]`。CLI 只读当前状态补齐 projectId、ticket、interruptEpoch、expectedRevision；`--task` 缺省用会话当前 taskId。字段参数：task-start 用 `--goal`、`--route`、`--mode`、`--paths a,b`、`--plans a,b`、`--channels worker=x,reviewer=y`、`--parent`；task-update 用 `--goal`、`--mode`、`--paths a,b` 与 `--paths-mode replace|append`；phase 用 `--phase`、`--delivery`；role-claim 用 `--role`、`--package`；task-end 用 `--final-ref`。packages、disposition 及 validation、waivers、change 等结构化字段放进 `--input <JSON 文件>`，该文件不能含身份字段或 taskId（返回 `INPUT`）。会话不存在返回 `IDENTITY`，turnId 不符或会话已中断返回 `STALE`，未知 action 返回 `ACTION`。同一 signalId 重试时 expectedRevision 取首次回执的值，正文不变即命中重放；读与写之间 revision 变化由 hook 以 `REVISION` 拒绝，不自动改成最新值。
- 完整 payload（兼容）：`signal --input <JSON> | --base64 <UTF-8 JSON>`。推荐 `--input`：先用文件工具写 UTF-8 JSON 文件再调用；长 base64 串可能被宿主当作密钥脱敏成占位符，解码后不是有效 JSON。

仅 PostToolUse 在当前 shell 调用确实执行本安装副本的 `signal` 子命令后接受。解析限定 `tool_response` 的已知结构（直接 JSON、文本行、`output`、MCP `content[].text`），最多三层包装；不扫描文档、聊天、transcript 或任意嵌套键。其他插件命名空间不接受。混入多个不同信号拒绝。

所有信号字段：`schemaVersion:1`、`projectId`、`sessionId`、`turnId`、`taskId`、`ticket`、`interruptEpoch`、`expectedRevision`、`signalId`、`action`。新任务的 `taskId` 由 Lead 自拟（入口 identity 中为 null），不能为空。身份/票据/epoch/revision 必须匹配。重复 signalId 仅在同一 session、turn、task 下重放已接受回执；不重放 Stop 的阻断决定。signalId 相同而正文不同拒绝。

| action | 附加字段 | 结果 |
| --- | --- | --- |
| task-start | goal（顶层）；permissions:{mode, allowedPaths}；可选 parentTaskId、route、plans、channels | 建立/显式接续任务；恢复 suspended，保留原 goal 与 permissions。接续回执带 `kept:{goal,permissions}` 与提示；本次附带的 goal/permissions 不生效，需变更时用 task-update。route、plans、channels 只能首次声明或补声明，不可改（plans 改声明返回 `PLAN`，channels 返回 `CHANNEL`）。新任务缺 goal 或 permissions 时回执点名缺项，mode/allowedPaths 写在顶层时指出应放进 permissions |
| task-update | 可选 goal；permissions:{mode?, allowedPaths?}；allowedPaths 配 allowedPathsMode=replace\|append（缺省 replace） | 仅该任务当前有效 Lead 会话可改；显式更新目标/权限，写回 `task.updates`。回执返回有效 `goal`、`permissions`、`change` 与 `hostPermissionMode`。不支持 route/channels/plans/账本（返回 `UNSUPPORTED`）；宿主只读/计划时不能扩大权限（返回 `PERMISSION`）；goal 与 permissions 都未给出返回 `INPUT` |
| phase | phase；delivering 时 deliveryId | 更新明确阶段，可随带 disposition |
| disposition | deliveryId；disposition | 处置当前交付 |
| packages | packages[1-50]；可选 validation、change | 批量 upsert 工作包账本；change 追加到 `task.changes`；回执可带 `repairLimit` |
| role-claim | role=worker\|reviewer；可选 packageId | 委派子会话声明角色；不再计入 Lead，入口改注入对应角色上下文 |
| task-end | 可选 finalRef、validation、waivers | 通过门禁后结束任务；未完知识保留待办 |

`route` 为 `operation-only`、`lead-direct`、`delegated`。task-update 沿用 task-start 的身份、票据、revision 与失败原子回滚：只有绑定该任务的有效 Lead 会话能改；已声明为 worker/reviewer 的会话返回 `ROLE`。`permissions` 可只给 mode 或 allowedPaths；`allowedPathsMode=append` 去重追加，`replace`（缺省）用新集合替换。宿主 `permission_mode` 为 plan/read-only 时，把 mode 提到 write 或追加路径都返回 `PERMISSION`；缩小范围与只改 goal 仍可记录。插件只更新本机任务声明，不改宿主全局配置，也不证明用户授权真实存在。历史回执不改写，旧任务没有 `updates` 视为空；权限收缩不追溯取消已完成产物，后续写入按新范围检查。首版不改 route/channels/计划/历史工作包，也不替代用户授权；直接 Edit/Write 不因此新增拦截。工作包字段：`packageId`、`role`（worker/reviewer）、`status`（dispatched/delivered/consumed/canceled/failed/waived）、`handle`（宿主 task_id）、`channel`（实际通道）、`supersedes`（接替的旧包）、`worktree`、`baseRef`、`deliveredRef`、`dependsOn[]`、`note`；reviewer 包另有 `reviews`（被审 packageId）、`reviewedRef`、`verdict`（PASS/FIX/BLOCKED）。新包必须给 role 与 status，已有包只更新给出的字段。`attempts` 由插件计：已交付或已消费的包重新 dispatched 加一，超过 2 时回执带 `repairLimit:true` 和 `repairLimitPackages`，只提示 Lead 裁决，不拒绝。`consumed` 表示 Lead 已读过结果。`validation` 为 `{ref, evidence[]}`。`change` 为 `{summary, reason, packages[]}`，记录中途细节变更，插件补 `at` 后追加，不覆盖历史。账本存于 `task.packages`、`task.changes`，旧任务没有该字段视为空，状态文件仍为 `schemaVersion=2`。

派工通道（0.6.2）：通道名写作 `codeg:<agent_type>`（Codeg 委派）、`builtin:<类型>`（宿主内置子代理）或 `lead`（Lead 自己实施）。用户指定了各角色用哪个智能体时，task-start 带 `channels:{worker?, reviewer?}`，记入 `task.channels`。工作包的 `channel` 与该角色的声明不一致（含未填），或 delegated 任务的 worker 包 `channel=lead` / `handle=lead-direct`，算偏离：同一 packages 信号的 `change.packages` 必须列出该包，否则返回 `CHANNEL`。只在新建或偏离内容变化时核对，已记过的偏离在后续交付、重新派发时不再要求。不声明 channels、不填 channel 的任务与 0.6.1 相同。

返修链（0.6.2）：换新 packageId 返修时，新包在创建时带 `supersedes:<旧包>`，旧包须同角色、存在且未被接替；新包 attempts 为旧包加一，旧包记 `supersededBy`，在途的旧包改为 canceled，delivered 改为 consumed，已终态不变。被接替的 worker 包不再要求审查，审查缺项落到链上最新的包。supersedes 只能在创建时声明，违反返回 `PACKAGE`。沿用同一 packageId 重新派发的做法不变。

task-end 门禁：父任务有 active 子任务（`parentTaskId`）时列 `child:<id>`。除 `operation-only` 外（含未声明 route 的旧任务）都做 spec 检查（见下文；检查根是入口 `resolveProject` 给出的当前 worktree，不是项目主根），有问题的 spec 各列一条 `spec:<id>`，检查不了时列 `spec-check:<原因>`。仅 `route=delegated` 再核对：每包终态（`terminal:<id>`）；每个未取消/未豁免/未被接替的 worker 包，存在 `reviews` 指向它、`verdict=PASS` 且 `reviewedRef` 等于其 `deliveredRef` 的 reviewer 包（`review:<id>`）；存在 validation，给了 finalRef 时 `validation.ref` 必须相同（`validation`）。`waivers:[{step, reason}]` 的 step 可写完整条目或类别（`review`、`validation`、`terminal`、`child`、`spec-check`），累计记入任务；step 为 `spec` 或 `spec:<id>` 返回 `WAIVER`，已记录的同类旧豁免也不抵扣。本包或它沿 supersedes 接替过的旧包有 reviewer 包给出过 verdict 时（0.6.2；取消、失败而没给结论的审查包不算），其 `review:<id>` 缺项不受任何豁免抵扣，该包也不能改标 waived（返回 `PACKAGE`）：只能让审查对上最终交付版本、用 supersedes 接替，或 canceled 放弃（放弃即不交付该包的改动，由 Lead 在交付说明里写明）；从未审过的包照旧可豁免。被接替的包状态不再可改。缺项返回 `{accepted:false, reason:'GATE', missing:[...], findings?}`，消息附 spec 发现说明，状态整体回滚。未声明 route 的旧任务接受并附 `warning:'route-missing'`；delegated 通过时附 `gate:'declared-records-consistent'`。门禁只核对声明记录的一致性，不证明审查或测试真实发生。`task show --task <id>` 只读查看账本、`changes` 与 `updates` 条数、`gateMissing`、`specFindings`、`plans` 和 `planUnchanged`。

计划软门禁：`plans` 为 1-10 项项目内相对路径（不含 `..`、不能是绝对路径），记入 `task.plans:[{path, digest}]`，digest 取声明时的文件内容摘要（声明与收尾都从入口当前 worktree 读取），文件不存在时为 null。收尾时内容摘要仍与基线相同的计划列为 `planUnchanged`；文件已不存在（按归档或改名处理）、基线为 null 时不列。它不进 `missing`、不需要豁免：task-end 照常接受，回执附 `planUnchanged` 与 `reminder`；Stop 只在已有的那一次阻挡里附上提醒，不新增阻挡。插件不判断计划是否做完，只看有没有回写。

## spec 检查

spec 位于 `.spec/<id>/spec.md`，`<id>` 为目录名，可嵌套，`.spec` 内不得重名。frontmatter 的 `code:` 只列具体文件（不写目录或通配），`related:` 只供阅读；其他字段忽略。格式与 [SpexCode](https://github.com/shuxueshuxue/spexcode) 一致，检测由 workflow 自己实现。

对每个 spec 的每个 `code:` 文件，从检查版本（finalRef，缺省 `HEAD`）往回看：缺省 `HEAD`（含显式 `--ref HEAD`）时看当前 worktree 的文件和未提交改动；显式 `finalRef`/`--ref` 先固定成提交 OID，spec 清单、正文、`code:` 路径和存在性都从该提交读取。

| kind | 条件 |
| --- | --- |
| `drift` | 有修改该文件的提交，既不是任何一版 spec.md 的祖先，也没有被放行；`commits` 列出这些提交 |
| `uncommitted-drift` | 只在检查 `HEAD` 时判断：工作区里该文件有未提交改动而 spec.md 没有 |
| `missing` | 被管辖文件在检查版本中不存在 |
| `duplicate-id` | `.spec` 内两个目录同名 |

放行用提交信息的 `Spec-OK: <id>[, <id>]` trailer，按 id 匹配：写在空提交（单父且树与父提交相同）上覆盖它可达的全部祖先；写在内容提交上只豁免该提交。优先在内容提交上附 Spec-OK；空提交用于追认既有历史。每次从 git 历史现算，不保存哈希。浅克隆返回 `error:'shallow'`，git 不可用或超时（10 秒）返回 `error:'git'`，并在 `detail` 附 git 的第一行报错（例如沙箱用户不是仓库所有者时的 dubious ownership），门禁中显示为 `spec-check:<原因>`；工作区没有 `.spec` 目录时（HEAD 检查）`skipped:'no-spec'`，不报缺项；显式版本先解析 ref，再按目标提交判断，目标提交没有 `.spec` 同样跳过，不混入当前磁盘定义；非 Git 目录或 ref 无效一律 `error:'git'`，不回退到 HEAD。任务门禁对不在 Git 工作树内且没有 `.spec` 的接入项目仍按 `no-spec` 跳过（即使带了 `finalRef`）；在 Git 内 ref 无效、或非 Git 但存在 `.spec` 时照常显示 `spec-check:git`。git 调用不经 shell，参数逐个传入并带 `--literal-pathspecs`。

`spec check --project <root> [--ref <commit>]` 只读输出 `{ok, ref, findings:[{id, spec, code, kind, commits}], error?, detail?, skipped?}`；检查根是命令所在目录对应的当前 worktree（从子目录运行也回到 worktree 根），指定 `--ref` 时 `ref` 为固定后的提交 OID，否则为 `HEAD`；例外是 `--ref HEAD`，它按当前 worktree 检查、`ref` 仍为 `HEAD`。有发现或检查失败时退出码为 1。task-end 自带同一检查，显式命令只用于提前诊断。

role-claim 的 taskId 填工作包所属的 Lead 任务 ID（仅作标识，不绑定任务）；只能在会话没有自己的活动任务时发出，同一会话不能改声明其他角色；声明后该会话的 task-start、packages、task-end 等业务信号返回 `ROLE`。宿主内置子代理的事件带 `agent_id`（Claude Agent 工具、Codex spawn_agent 均实测，`session_id` 与父会话相同），整体放行，不开回合。内置子代理与 Lead 共用会话，没有自己的 workflow 身份：它调用本插件 signal（直接或组合命令）时只回一条说明，信号不记录、状态不变，让它直接完成工作包交回 Lead。

phase 为 `unknown`、`operation-only`、`executing`、`waiting-user`、`delivering`。`operation-only` 无经验回执要求。例行查看、指定提交 push、无冲突快进 pull 在文档中分流，插件不执行业务命令。

disposition（旧接口兼容，不再是 task-end 的前置）：

- `no-new-learning`：非空 reason，可附 evidence；已有资料完整承接时直接使用。
- `updated`：非空 transactionIds；每笔必须与当前项目、任务、会话关联，全部文件成功，且候选已处置。普通编辑不产生可信事务。
- `pending-recovery`：pendingId 与 reason；待办必须已由知识事务或 `pending create` 为本任务创建，可定位候选和失败原因。

packages 的 `handle` 填宿主委派 ID（Codeg task_id）时，委派状态查询的 PostToolUse 会据此给出只读提示：等待集合中账本已终态的包、已结束但未记账的包。Lead 入口在有 dispatched 包时附在途提示。两者都不改变状态。

接受返回 `{accepted:true, revision, taskId, phase}`，可附 `warning`、`gate`、`repairLimit`；task-start 接续另附 `kept` 与提示，task-update 另附有效 `goal`、`permissions`、`change`、`hostPermissionMode` 与说明。拒绝返回 `{accepted:false, reason, message, missing?}`，不改变当前状态。hook 用 additionalContext 回传，命令退出成功不等于接受。

## Stop、中断和恢复

| 输入状态 | 动作 |
| --- | --- |
| 未绑定、缺身份、子角色会话、已中断 | 放行 |
| stop_hook_active=true，或本回合已挡过（`session.stopBlockedTurn` 等于当前 turnId） | 放行 |
| phase 为 waiting-user 或 operation-only | 放行 |
| 计划阶段（`permission_mode=plan` 或活动任务 `permissions.mode=plan`）且尚未 waiting-user | 记录 `stopBlockedTurn`，返回 `{decision:'block', reason}`：提醒交付计划时列出工作包划分并询问用户指定 Worker 与 Reviewer 通道 |
| 绑定任务不是 active，或 route=operation-only | 放行 |
| 有 dispatched 工作包 | 记录 `stopBlockedTurn`，返回 `{decision:'block', reason}`：列出在途包与 handle。在途包全部是 `builtin:` 通道时，说明宿主会在子代理结束时通知本会话，只需向用户说明在等什么；否则要求继续阻塞等待结果（`wait_ms: 0`），或向用户说明暂停原因与接续方式（Codeg 不会在委派结束时唤醒 Lead） |
| 其余（Lead 的活动任务尚未 task-end） | 记录 `stopBlockedTurn`，返回 `{decision:'block', reason}`：有门禁缺项时列出缺项，要求补齐后 task-end 或向用户说明未完成项；无缺项时提醒发 task-end；任务关联的计划未改动时，同一 reason 附回写提醒 |
| Interrupt / StopFailure | 增 interruptEpoch、撤销票据、挂起任务、保存 business-incomplete、释放会话归属；同一任务仍被其他有效 Lead 会话持有时只保存本会话，不挂起任务 |
| SessionEnd | 同中断保存；不把业务标为完成，不续跑业务 |
| PreCompact/PostCompact/compact SessionStart | 保存/恢复既有身份；预算不变 |

Interrupt、StopFailure、SessionEnd 先写一条独立的本机待处理记录（状态根 `lifecycle-events/`，按时间命名，同目录原子替换），再尝试拿状态锁幂等消费。消费只改内存状态，状态提交成功后才归档：已消费移入 `consumed/`；状态写入失败或保存后、归档前进程退出时，事件仍留在扫描范围，下一次入口靠已持久化的 `event_id`/event+回合回执幂等跳过，不重复中断。记录只绑定宿主给出的可信回合（`turn_id` 或 `prompt_id`）；缺失时不推断当前会话回合，按关联不足移入 `deferred/` 并说明，不中断新回合，任务仍 active 时补一条 business-incomplete 待办。`deferred/` 记录会在后续入口重读并按有界重试恢复关联：首次重入立即重试，之后按间隔，超过次数或时限后停止自动重试并升级为诊断；诊断正文先写入状态（`note` 与待写标记），原因文件只是可重建的副本，写入失败或提交后崩溃会在下一次入口重试，写成功前提示直接带出诊断正文，不要求用户去读可能尚不存在的文件。记录绑定写入时的 project/session/task/turn/票据，消费时会话已进入新回合、或事件记录的票据与当前票据不一致（含事件未记录票据）时视为迟到事件：不撤销新票据、不自动继续，只在任务仍 active 时补一条 business-incomplete 待办并说明原因。事件归档与消费回执统一按 event+project+session+turn+宿主事件 ID 去重，不同项目、事件或回合不会被合并；旧状态中只按宿主事件 ID（或 event+回合）记的回执兼容读取，升级后不会重复生效。首次移入 deferred/ 后原因文件写入失败与事件移动失败分开报告：事件已在 deferred/ 时如实说明位置，诊断正文先存状态，下一次入口补写。事件记录落盘与状态锁同时失败时，两件事都如实说明，不宣称已持久化或已应用。

“仍有其他有效 Lead 会话”指同一 project/task、非子角色、未中断、票据未撤销且回合标识存在的其他会话；旧状态缺 `interrupted`/`ticket` 字段时保守按未中断处理，不按 `lastSeenAt` 年龄判定会话死亡。状态锁不使用单独的恢复 guard，也不按固定路径摘锁：每个入口先原子创建 `<prefix>.lock.<pid>.<token>.wait`（pid+随机 token 保证唯一），扫描到其他活跃 `.hold` 或旧格式活锁就等待；无阻塞时把自己的票据原子改名为 `.hold`，改名后再次扫描，看到其他持有者即退回 `.wait`，因此同一时刻至多一个持有者。死者只按它自己的唯一票据名归档到 `retired-locks/`，后来者新建的活跃票据必然是不同的文件名，结构上不存在“读到死锁后按固定路径摘走、误移新持有者”的窗口；归档是单次原子改名，没有中间待复核状态，崩在改名前后都只会留下可再次归档的死票据或已归档文件。旧版固定路径 `<prefix>.lock` 与 `<prefix>.lock.recovery` 只读不移动：新版本遇到活进程会按持有者等待（兼容旧版本），已退出进程忽略并留一份 `.legacy-note.txt` 诊断，绝不按固定路径摘走；旧实现留下的 `.recheck-*` 唯一名文件可安全归档。反向兼容不成立：仍在运行的旧版本进程不认识新票据，升级瞬间无法与新版本互斥，只能等旧进程退出后收敛。pid 只在 `kill(pid,0)` 返回 `ESRCH` 时判死；`EPERM` 或无法判断一律当活。票据身份以文件名中的 pid、token 为准，正文只作旁证：正文缺失或与文件名不一致时按损坏票据保留原文件，宽限期后给 `LOCKED` 诊断，不按正文 pid 判死或归档。PID 复用只会造成保守等待或 `LOCKED`，不会并发持有。

回合结束核对只读：不改任务状态，不替 Lead 发 task-end，不生成经验待办；缺项计算与 task-end 门禁相同，已记录的 waivers 照常抵扣，`spec-check:<原因>` 不计入。核对出错（状态损坏、锁超时等）时放行。宿主把 reason 作为续轮提示注入：Codex 以 `<hook_prompt>` 用户消息、Claude Code 以 Stop hook 反馈续一轮，续轮不触发 UserPromptSubmit，第二次 Stop 带 `stop_hook_active:true`。插件只认已记录的内容：没发 task-start 或未记进工作包的工作查不到，hook 未执行时也不生效。

PostCompact 不输出 additionalContext；压缩恢复上下文由支持该输出的 compact SessionStart 入口承载。同一回合的既有票据、修订号和任务预算保持不变，真实宿主是否触发该入口另行验收。

`repairIssued` 只保留兼容，不驱动 Stop 阻断。用户后续发言只建立新的未知回合，不恢复旧业务；context 最多提示一项知识待办，`pending list` 可查看全部；待办按事务独立保存，其他事务成功不能清除它。恢复业务通过显式 task-start，保持原权限；需要改目标或权限时，接续后再发 task-update。后台复盘另按配置计时、计批次和每日启动次数；业务返修与诊断限制独立。

## 知识事务

`knowledge inspect --project <root> --path <relative>` 输出 `{path,exists,content,fingerprint}`，缺文件 fingerprint=null。`knowledge apply` 输入身份字段与 `changes:[{path,baseline,content,responsibility,reason,evidence,candidateIds}]`、`candidates`。candidate 包含 `id,taskId,workPackage,conditions,finding,recommendation,evidence`。

`knowledge select|explain` 是显式查询，返回 `selected`、完整 `excluded`（含原因）、`criticalOmitted`、`skipped` 以及 `excludedTotal/skippedTotal` 等总数。hook 自动入口只注入 `selected`、重要遗漏摘要和总数；程序化检索的排除清单按条数与字符双预算截断，`excludedOmitted` 说明省略数量。检索逐条解析知识文件：损坏（含元数据字段类型非法）、权限或路径/链接检查失败的条目跳过并记录 `skipped`，其他有效条目继续召回；写路径仍使用严格读取，跳过不等于可写授权。

仅当前有效 write 任务及 allowedPaths 内非敏感 UTF-8 文本可写。禁止绝对路径、`..`、Git/客户端配置、凭据文件、二进制；遇到链接/硬链接拒绝自动写入并要求先核对目标。检查祖先 realpath 防目录链接逃逸。新文件必须有实际正文。非敏感声明和证据由 Lead 核对；插件拒绝常见凭据内容，不复制全仓或完整聊天。

处理顺序：状态锁 → 校验当前身份/修订号 → 每目标文件锁 → 读取基线 → 保存前快照和后内容到本机事务目录并持久化 prepared → 再核指纹 → 同目录临时文件原子替换 → 记录 applied 指纹 → 持久化状态。每个文件独立，部分成功返回 partial；未成功项创建 knowledge-pending。单任务/候选稳定 ID 去重，同候选内容冲突拒绝，重复申请不追加相同经验。

恢复对照 prepared 的前/后指纹：等于后指纹则记已写；等于前指纹则保留未完成；第三种内容记 conflict；不自动重写用户改动。状态或快照持久化失败时不继续文件写入。`knowledge recover --transaction <id>` 只辨认结果并保存待办，续写由 Lead 基于新指纹显式申请，只处理尚未完成的候选。

等待/持有票据在成功释放或放弃等待时按唯一名移到状态根内的 `retired-locks/`；死票据和旧 `.recheck-*` 待复核文件也归档到那里，旧格式固定路径锁保留原文件不自动移动。临时失败产物保留。用户文件和安装副本不自动永久删除；uninstall 撤销自有注册并保留发布副本与记录。

## 项目对齐

对齐不新增 phase、不改 signal schema。`scan` 只读扫描项目并写本机索引，`status` 检查索引；`apply`、`decide`、`suggest` 需要有效身份、write 任务、目标 allowedPaths 与明确 baseline，使用共享写入事务。只读/计划任务即使对齐文件缺失也不能写。一次写入可带 `sources` 列出本次实际重读并确认的来源（可选 `size`/`mtimeMs` 快照，删除项 `deleted: true`），只刷新这些来源的 `files` 基线和相关目录；提交前复核快照，读取后又变化的来源不确认并保持 stale，未列出的来源也不动。

索引保存 `schemaVersion`、`generatedAt`、`docPath`、`docFingerprint`、`files`（`path/size/mtimeMs/kind`）、`directories`（索引文件父目录的 `path/mtimeMs`）、`decisions` 与 `findings`（只存 ID、状态和裁决时间）。扫描收集文档文本和工具链入口，排除 `.git`、`node_modules`、`bin`、`obj`、`dist`、`build`、`work`、`release-staging`、`.workflow`、缓存和临时目录；默认 300 个文件，`--max-files` 最大 300。符号链接、硬链接和目录逃逸不进入索引，在 `skipped` 报告原因。每个文件只取大小和 mtime，不读正文；对齐文档自身不进入索引，避免写回后自判过期。

`apply` 用 `workflow-alignment:begin/end` 标记区维护正文，标记外逐字保留；`decide`、`suggest` 按 `## 已裁决记录`、`## 结构建议` 标题定位小节（到下一个标题或管理区结束标记为止，末节不越过标记），同一 ID 原位替换，首条记录替换“- 暂无”类占位行。写入前核对输入 `baseline`，不一致返回 `CONFLICT` 并保留原文；写入使用同目录临时文件原子替换。首次 `apply`/`decide`/`suggest` 若索引为空，会先补一次只读扫描，保证后续变更检测有效。

`projectContext` 注入 `alignment:{path,exists,docExists,stale,changed,missing,directoryChanged,pendingDecisions,pendingFindings}`。`stale` 只由索引文件大小/mtime 和父目录 mtime 变化得出，不读正文；`changed` 每项附当前 `size`/`mtimeMs`，可作为 `sources` 快照；`pendingDecisions`/`pendingFindings` 以对齐文档表格为准并与索引状态合并，绕过 `decide`/`suggest` 直接写表也不会漏计；`exists=false` 时按未对齐处理。对齐读取失败时改为注入 `alignment:{error:{code}}` 和一句短降级提示，不按未对齐处理，也不回滚已保存的入口身份。hook 不自动写项目文件，只提示 Lead 增量更新或逐条确认待裁决项。

## 安装和版本

`install --agent codex|claude [--user-dir <dir>]` 将发布白名单复制到状态根 `releases/<version>-<digest>`，再把状态根 `current` 目录联接指向该副本；hook 命令固定使用 `current/bin/workflow.mjs`，升级只切换链接目标，配置字符串和宿主信任不变。只合并宿主配置（Codex `hooks.json`、Claude `settings.json`）中 workflow 自有分组；不写信任记录。重装时自有分组放回原来的分组序号：Codex 的信任键按“事件:分组序号”编号，挪动位置会让本插件和相邻插件的信任同时失效（`trust=modified`，hook 不执行）。Codex 记录保留在 `state.install`（兼容旧版），两个宿主另存于 `state.installs`，分别安装与撤销。自有 handler 必须 command 与 args 同时一致才可移除，避免误删共享 Node 路径的其他插件。保存自有分组、配置前后指纹和逆向操作，备份只含自有条目。活动任务或 prepared 事务存在则延期更新。发布副本指纹不符或 `current` 指向与记录不一致时拒绝覆盖/使用，doctor 报告 unavailable。

AGENTS 仅有可携带的短管理区，不含机器绝对路径。disable 仅在管理区指纹一致时撤下，保留其他正文；用户改动时报告 conflict。uninstall 仅撤销与安装记录一致的自有 hooks；用户后来新增配置全部保留。doctor 分别报告 registration/discovery/trust/execution：未观测的宿主状态为 unknown，不能由配置存在推断可信或执行。

官方接口依据：[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[插件包装](https://developers.openai.com/plugins/build/plugins)。Claude Code 侧依据本机 2.1.292 内嵌的 hook schema：`prompt_id` 关联用户回合，`StopFailure` 承担中断保存，`hookSpecificOutput.additionalContext` 仅对 SessionStart、UserPromptSubmit、PostToolUse、Stop 生效。合成 fixture 明确标记 synthetic；宿主是否实际执行仍需在真实会话中核验。

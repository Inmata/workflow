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

首次修改状态会保存 v1 原文备份。旧候选在 `learning enable` 时幂等导入；旧 `applied` 只能证明写入过，不算已验证经验。旧中断任务应为 `suspended`，旧会话不应永久占住负责人或挡住升级。

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

有完整提案的中断运行可用 `learning recover --run <ID>` 恢复，不再调用模型。外部编辑冲突需先核对文件与保存提案。不要删除 inbox、state 或快照来“修好”状态。

验收后再决定是否扩大项目范围、调整默认参数或发布新版本。当前本机材料不自动跨电脑同步，换电脑仍需各自建立绑定；Git 只携带项目配置与正式知识。

## 6. 0.3.0 真实宿主验收

本节验证分流、账本、门禁、角色声明和提问路径。合成测试已覆盖机械行为，以下每项结论分别标注“自动验证 / 真实宿主验证 / 未知”。Claude Code 与 Codex 各作一次 Lead。

先补齐[Codeg 能力表](adapters/codeg.md#宿主能力表)与[Claude 能力表](adapters/claude.md#宿主能力表)中的 unknown 格：用临时 hook 落盘脚本（仅本机、事后删除）记录 `hook_event_name`、`agent_id`、`agent_type`、`tool_name`、`permission_mode`。

| 场景 | 通过条件 |
| --- | --- |
| Codex spawn_agent 子代理 | 子线程事件带 `agent_id`；插件不开回合，`ownerSessionId` 不变 |
| Codeg 委派子会话 | 子会话发 `role-claim` 后 `doctor --project` 的 owner 不被清空；之后入口注入 Worker/Reviewer 上下文 |
| 提问置 waiting-user | Codex 原生、Codex 经 Codeg MCP、Claude `AskUserQuestion`、Claude 经 Codeg MCP 四种组合分别记录 PostToolUse 原文 `tool_name`，确认 phase=waiting-user |
| Codex Plan / Default | 分别记录 hook 上报的 `permission_mode`；Default 且 flag 关闭时通过 Codeg MCP 或文本提问完成一次首次对齐，含跨回合 decide |
| Claude ACP | 在 Codeg 的 Claude ACP 中确认 default 模式能否调用 `AskUserQuestion` |
| 压缩 | 压缩后 compact SessionStart 上下文含 `ledger`，Lead 不重复派工、不重读 consumed 结果 |
| 门禁 | delegated 任务缺审查或验证时 task-end 返回 GATE 与 missing；显式 waivers 后接受 |

2026-10-23 Codex CLI 0.163.0 隔离探针已完成（真实宿主验证）：spawn_agent 子代理事件带 `agent_id`，装入本插件后状态只留父会话；原生提问 `tool_name=request_user_input`，Codeg 同名 MCP 为 `mcp__codeg_mcp__ask_user_question`，两者 PostToolUse 均触发；`permission_mode` 只反映审批策略，Plan 协作模式也报 `default`。详见 [Codeg 能力表](adapters/codeg.md#宿主能力表)。Codeg 委派探针（2026-10-23，临时项目）：Claude 子会话收到 Lead 入口上下文并被计入 Lead 列表，发 `role-claim` 后移出（真实宿主验证）；Codeg Claude ACP 下 Lead 没有 `AskUserQuestion`，只能用 Codeg MCP 提问；Codex 子会话同样收到 Lead 上下文，`role-claim`（`--base64`）回执 accepted，状态中 role=reviewer、leadSessions 为空（真实宿主验证）；该子会话需自行查文档拼出 signal 命令，Lead 上下文已补充命令格式。Claude auto 模式分类器（2026-10-23，真实宿主验证）：CLI 与 Codeg Claude ACP 下 signal（base64/文件两种）、knowledge capture、align scan/apply 均未被拦；发现模型自发写成 `cd … && node … signal` 时信号被静默丢弃，已改为回执提示单独直接调用。压缩、门禁和收益对照仍须实跑。

收益对照：小修改、可拆分功能、强依赖修改三类任务，各在“Lead 直做”和“分工流程”下跑一次，记录交付是否通过、返工次数、Lead 重复读取的结果数和端到端耗时；token 只记可获取数据，不当账单。结果决定下一轮是否值得扩展账本字段，本节不预设。

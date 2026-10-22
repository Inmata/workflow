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

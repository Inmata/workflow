# workflow

简体中文 | [English](README.en.md)

workflow 是一套跨智能体的项目协作与知识维护规则。它解决三件事：**谁做什么**（Lead、Worker、Reviewer 的分工与边界）、**怎么收尾**（任务阶段与待恢复状态）、**怎么积累经验**（短材料持久保存、受限后台复盘、相关经验召回）。

**Lead、Worker、Reviewer 是职责，角色不绑定客户端或模型。** Claude Code 可以担任 Lead，也可以担任 Worker 或 Reviewer；Codex、OpenCode、Pi 等同样按当前授权和实际能力分工。具体安排由用户已确认的角色、可用工具和任务需要决定。

## 角色与接入支持

角色方法共用同一套[公共方法](docs/workflow.md)和[角色指引](docs/roles/lead.md)。同一种智能体也可以用不同的独立会话分别实施和审查。

自动 hook 接入目前支持以下宿主，两者都能作为 Lead 接收项目上下文、提交任务信号和完成知识处置：

| 宿主 | 安装参数 | 用户配置 | 适配说明 |
| --- | --- | --- | --- |
| Claude Code | `--agent claude` | `~/.claude/settings.json` | [Claude Code](docs/adapters/claude.md) |
| Codex / Codeg Codex ACP | `--agent codex` | `~/.codex/hooks.json` | [Codeg ACP](docs/adapters/codeg.md) |

`--agent` 选择 hook 的宿主适配，不指定协作角色。OpenCode、Pi 等可通过宿主已有的委派工具参加协作，角色由工作包指定；它们的原生 hook 自动接入尚未实现，独立运行时不能保证同样的自动收尾。

运行环境为 Windows + Node.js 24+，ESM，无第三方运行时依赖。可选后台学习通过 Windows 计划任务和现有 Codex CLI 运行，消耗现有账户额度；安装不会自动启用它。

## 新用户从这里开始

如果你只想知道“装上之后我该干什么”，按下面四步走。全部命令都在本仓库根目录执行。

### 第 1 步：安装到本机

选择你实际使用的宿主安装，两个入口任选其一，也可以都装。

**Claude Code：**

```powershell
node bin/workflow.mjs install --agent claude
node bin/workflow.mjs doctor --agent claude
```

**Codex / Codeg Codex ACP：**

```powershell
node bin/workflow.mjs install --agent codex
node bin/workflow.mjs doctor --agent codex
```

只用 Claude Code 时，只需安装 Claude 适配。

Claude Code 在 Codeg 中以 auto 模式担任 Lead 时，分类器可能拦截委派。请在权限设置中放行 `mcp__codeg-mcp__delegate_to_agent`、`mcp__codeg-mcp__get_delegation_status`、`mcp__codeg-mcp__cancel_delegation` 和 `mcp__codeg-mcp__check_user_feedback`，或改用逐次确认的权限模式（见 [Codeg 接续](docs/adapters/codeg.md#接续)）。

`install` 会做四件事：把当前源码复制成一份带摘要的发布副本（`releases/<version>-<digest>`）、把固定入口 `current` 指向它、在宿主配置里注册本插件的事件（Codex 写 `hooks.json`，Claude 写 `settings.json`）、记录安装事务。hook 命令只包含 `current` 路径，所以升级后路径不变，宿主信任只需做一次；旧副本保留作回滚。重复执行会核对 `current` 的实际目标：自有入口被删除、断链或错链时只重建或改指链接，不重写配置、不新建副本；`current` 被替换成用户自己的目录或指向安装目录外的链接时保留现场并报告 `conflict` 与路径。两个宿主共用一个 `current`，重复安装只修自己的入口：如果 `current` 已指向另一个已安装宿主登记且完整的发布快照，不会改指，而是返回 `conflict` 并提示先统一升级两个宿主。它**不会**写宿主信任、不会改项目、不会提交 Git。

`doctor` 看的是四项不同的事，不要混为一谈：

| 字段 | 含义 |
| --- | --- |
| `registration` | 宿主配置里有没有本插件的定义 |
| `discovery` / `trust` | 宿主是否发现并信任了当前定义（插件查不到时显示 `unknown`，这是正常的） |
| `execution` | 是否真实收到过回调事件 |
| `integrity` | 发布副本是否与安装记录逐文件一致 |

安装或升级后，在所用宿主的 `/hooks` 中核对 workflow 条目。Codex / Codeg 若显示 `modified`，按宿主提示重新确认信任；Claude Code 核对已加载的 hooks，并处理宿主实际出现的确认提示。然后打开新会话观察回调。插件不替你写信任记录。

### 第 2 步：让项目接入

```powershell
node bin/workflow.mjs project onboard --root "D:/你的项目"
```

`onboard` 分开核对核心接入与可选后台复盘：宿主是否已安装且版本一致、目录和 Git 身份、`AGENTS.md` 里有没有复制来的或残留的管理区，这些核心检查全部通过才写入；任何一项不过都不写入，并一次列出所有问题和可直接复制的修复命令。后台复盘执行器只核对能力、不调用模型，预检问题单独报告，没加 `--enable-learning` 时不阻断核心接入；执行器缺专用配置时给出警告和登记命令。想同时启用后台复盘就加 `--enable-learning`（会按配置真实调用模型并消耗额度，需用户同意；当前会话权限允许时可由代理直接执行，否则在你自己的终端执行），不打算启用时加 `--skip-learning`。显式启用时分别报告接入与学习结果，学习失败不会写成全部成功：核心接入完成但学习未完整生效时返回 `status: partial`，CLI 退出码为 1；未加 `--enable-learning` 时预检问题只提示，退出码仍为 0。已启用后台复盘的项目重复接入时，现有开关与计划任务保持不变，预检失败只报告本次核对结果。

检查通过后，它在项目根目录插入一段很短的 `AGENTS.md` 管理区，建立本机绑定并完成首次对齐扫描，没加 `--enable-learning` 时，最后列出启用后台复盘的完整命令。它保留你原有的 AGENTS 正文，不要求你补 README、spec 或计划，也不会创建空 LESSONS。

接入后，在已安装适配的 Claude Code 或 Codex 中打开**该项目里的新会话**，插件才会给出对应上下文。同一本机目录共用项目绑定，切换这两个宿主无需重复接入。同一项目可同时开多个会话，并发改同一文件时由指纹检查报冲突，不会互相覆盖。

首次会话，Lead 会先做一次[项目对齐](docs/alignment.md)：只读扫描项目文档和工具链，把权威资料、验收入口、项目约定与 workflow 默认的差异写进 `docs/WORKFLOW-ALIGNMENT.md`。项目做法与 workflow 默认不同时**逐条问你**，不擅自按任何一方执行；发现文档过期或结构问题时只报告，你批准后在当回合直接改。之后会话开始和每个用户回合只 stat 索引，文件变了才增量更新，不会重扫整个项目。

对齐可以手动触发：

```powershell
node bin/workflow.mjs project align scan --root "D:/你的项目"
node bin/workflow.mjs project align status --root "D:/你的项目"
```

### 第 3 步：在新会话里正常工作

不需要记命令。你在 Claude Code 主会话里提出需求，就由 Claude Code 承担 Lead；在 Codex 主会话里则由 Codex 承担 Lead。Lead 沿用已确认的角色安排，按任务大小自行分流：

| 你的请求 | 通常怎么处理 |
| --- | --- |
| 看状态、推送指定提交、快进拉取 | Lead 直接做，零 Worker / 零 Reviewer，声明 operation-only |
| 单点文本、低风险小改 | Lead 可直接做 |
| 真实代码修复、关键行为 | 派 Worker 实施，再派独立 Reviewer 审查 |
| 需要等你拍板 | 结构化提问自动记 waiting-user（文本提问先声明），不会猜着往下做 |
| 你中断了 | 只保存状态，不会在你下次进来时偷偷接着干 |

一切写操作只在你明确要求时才发生。插件不会自动 add / commit / push / 发布，也不会替你改版本号。

### 第 4 步：收尾与经验

有明确纠正、失败原因或验证结果时，Lead 保存短材料；没有新材料就直接交付。Stop 不要求补一轮复盘，也不要求每轮提交“无新经验”。材料先写入本机磁盘，换会话仍保留。

启用后台学习后，任务结束会登记一次受限的候选提取：只读取宿主 transcript 中用户与助手的短文本，候选先进本机材料队列，不直接改正式知识，也不阻塞或回滚业务交付。之后按你设置的材料阈值、最久等待时间和检查频率批量复盘。最长执行时间、每日次数、单批大小、模型与推理强度都可设置。正式经验存于 `.workflow/knowledge/`，分别记录成熟度、重要性、状态、范围和证据；新反例会立即阻止旧经验默认召回。当前项目事实仍维护在已有 README、spec 等权威资料中。

配置、命令与文件结构见[项目经验学习](docs/learning.md)，后台复盘的启用、切换执行器与排错见[后台复盘操作手册](docs/background-review.md)。首次真实运行按[另一台电脑验收交接](docs/acceptance.md)进行。

## 一次完整使用的例子

假设你使用 Claude Code 作为 Lead，项目 `D:/my-app` 要修一个登录超时的问题：

1. 你安装 `--agent claude`，执行 `project onboard --root "D:/my-app"`，并在该目录开一个 Claude Code 新会话。
2. 你说"登录 30 秒后超时，帮我查一下并修掉"。
3. Claude Code 作为 Lead 读项目现有资料，确认这是真实代码修复，通过可用且已授权的委派工具派一个 Worker 改实现并自测。
4. Worker 交回差异和测试结果，Lead 派独立 Reviewer 做只读审查。
5. Reviewer 有意见就退给原 Worker 定向修复，没问题就 Lead 集成并跑必要回归。
6. Lead 更新本任务涉及的项目事实，有可复用证据时保存短材料，回复你改了什么、怎么验证的、还剩什么。
7. 任务结束（task-end）。整个过程不需要你手动发信号。

换成 Codex 作为 Lead 时，流程相同，安装选择 `--agent codex`。Worker、Reviewer 的智能体类型按当前安排选择；缺少必要的委派入口时明确报告阻塞，不把交接文本当成已启动的智能体。如果你只想让它看看状态，第 3～5 步都会跳过，Lead 直接回你。

## 什么时候需要自己敲命令

日常使用基本不需要。下面这些是运维动作：

| 目的 | 命令 |
| --- | --- |
| 看 Claude 安装/信任/回调状态 | `node bin/workflow.mjs doctor --agent claude` |
| 看 Codex 安装/信任/回调状态 | `node bin/workflow.mjs doctor --agent codex` |
| 项目接入（预检后一步完成） | `node bin/workflow.mjs project onboard --root "<项目>"` |
| 项目停用 | `node bin/workflow.mjs project disable --root "<项目>"` |
| 彻底解绑（计划任务、管理区、本机记录） | `node bin/workflow.mjs project remove --root "<项目>"` |
| 核对后台复盘执行器（无需项目） | `node bin/workflow.mjs learning doctor --global` |
| 项目对齐扫描 | `node bin/workflow.mjs project align scan --root "<项目>"` |
| 检查对齐是否过期 | `node bin/workflow.mjs project align status --root "<项目>"` |
| 查看角色上下文 | `node bin/workflow.mjs context --role lead --project "<项目>"` |
| 撤销 Codex 注册 | `node bin/workflow.mjs uninstall --agent codex` |
| 撤销 Claude 注册 | `node bin/workflow.mjs uninstall --agent claude` |

`disable` 只停用单个项目，管理区没被手改才撤下；`remove` 在此基础上删除计划任务、本机状态记录和数据目录，项目里的对齐文件与 `.workflow/` 只列出不删除；`uninstall` 只移除该宿主上本插件自己的 handler，其他插件、发布副本、项目资料和经验全部保留。

三个命令都不回退已经做过的工作，下表是各自删什么、留什么：

| 内容 | `disable` | `remove` | `uninstall` |
| --- | --- | --- | --- |
| 任务里改过的项目文件、Git 提交 | 保留 | 保留 | 保留 |
| 正式经验（项目内 `.workflow/knowledge/`） | 保留 | 保留 | 保留 |
| 对齐文件（`docs/WORKFLOW-ALIGNMENT.md`）、`.spec/` | 保留 | 保留 | 保留 |
| `AGENTS.md` 管理区 | 未手改时撤下 | 未手改时撤下 | 保留 |
| 本机还没复盘的材料（数据目录 `inbox/`） | 保留 | **删除** | 保留 |
| 本机绑定、裁决登记、学习开关、计划任务 | 停用，记录保留 | 删除 | 保留 |
| 宿主 hooks 注册 | 保留 | 保留 | 撤销本插件的 |

没复盘的材料只存在本机，不在项目里。要保留就先等后台复盘处理完，或改用 `disable`。插件不会自动执行 `git revert`、`git reset` 或还原文件；要撤销某次任务的改动，用 Git 自己处理。

## 升级

升级不改项目文件，不动已接入项目的绑定、对齐文档、材料和经验。每台电脑各执行一次，先结束正在进行的任务（有活动任务时安装会拒绝升级）。以下命令假设本仓库在 `C:\path\to\workflow`，路径不同时替换成实际目录。

1. 拉取新版本：

```powershell
cd C:\path\to\workflow
git pull
```

本插件没有运行时依赖，不需要 `npm install`。

2. 对已安装的每个宿主分别重新执行 `install`，只装了一个宿主时只运行对应命令：

```powershell
cd C:\path\to\workflow
node bin/workflow.mjs install --agent claude
node bin/workflow.mjs install --agent codex
```

它会先算出新的发布摘要，复制到新的带摘要副本，完整性校验通过后才把 `current` 入口切换到新副本；hooks 命令字符串不变，宿主一般不需要重新信任。旧副本保留不动。两个宿主可以复用同一发布副本和同一入口，但安装命令只更新所选宿主的注册。有活动任务或未辨认事务时会拒绝升级并告诉你原因，等任务结束再来即可。

3. 检查状态：

```powershell
node bin/workflow.mjs doctor --agent claude
node bin/workflow.mjs doctor --agent codex
```

`integrity` 应为 `verified`，`version` 应为新版本号。然后在宿主的 `/hooks` 中核对 workflow 条目，Codex / Codeg 显示 `modified` 时按提示重新确认信任，再开一个新会话观察第一次回调。

已接入的项目不需要重新 `onboard`。后台复盘的计划任务同样经 `current` 入口运行，升级后自动使用新版本，不必重建。另一台电脑上的项目尚未接入时，升级完成后再按[第 2 步](#第-2-步让项目接入)接入。

### 升级后重新对齐

对齐协议随插件走：hook 注入的 `alignmentGuide` 指向 `current` 入口下的 `docs/alignment.md`，升级后新会话读到的就是新协议，不需要重新接入。新协议只影响之后的对齐动作，已有对齐文档不会自动重写；会话里只在资料文件变化时增量更新。

想按新协议整理对齐文档，在项目里开一个新会话，对 Lead 说"重新对齐"。它会按[项目对齐](docs/alignment.md)全量扫描，用新规则重建索引并更新对齐文件。已登记的裁决仍在本机记录里，不需要先删除对齐文档；对齐文件里有你手写的内容时，提醒 Lead 保留。

### 升级后重新接入项目

重新接入只在两种情况下需要：新版本改了 `AGENTS.md` 管理区的文字（版本说明会写明），或者你想用新版的接入预检把项目核对一遍。先完成上面的插件升级，否则接入预检会报宿主版本不一致：

```powershell
cd C:\path\to\workflow
node bin/workflow.mjs project onboard --root "D:/你的项目"
```

重复接入会：

- 重新做全部预检，不过时不写入，列出问题和修复命令；
- 把 `AGENTS.md` 管理区原位替换为新版本内容，管理区外的正文不动；
- 重新扫描对齐索引，用新的扫描规则记录文件清单；
- 保留项目 ID、后台复盘开关、计划任务登记、已裁决和待裁决的对齐记录。学习已启用时不再提示启用，也不必加 `--enable-learning`。

它**不会**改写 `docs/WORKFLOW-ALIGNMENT.md`，也不会动 `.workflow/` 中的材料和经验。

重新接入不会让 Lead 重做对齐，需要时按上一节另说"重新对齐"。

管理区被手改过时预检会报 `AGENTS`，按提示删掉 `<!-- workflow:begin -->` 到 `<!-- workflow:end -->` 之间（含这两行）的内容后重试。项目目录被移动或 Git 仓库被重建时预检会报 `IDENTITY`，按提示先 `project remove` 再接入；`remove` 会清除本机的学习开关、计划任务和裁决登记，项目内的对齐文档和 `.workflow/` 保留。

0.4.2 之前的版本重复接入会丢失学习开关、计划任务登记和对齐裁决。另一台电脑若还是旧版本，先升级再重新接入。

各版本的变化见 GitHub Releases。

## 这些概念的关系

- **Lead**：定范围、定验收、派工、集成、做知识处置。简单任务自己上。
- **Worker**：在给定的允许路径内实施和自测，不递归派工。
- **Reviewer**：只读审查，不改代码；分 Diff、Deep、Escalated 三档。
- **AGENTS.md**：只是短导航，指向项目原有资料，不承载全部正文。
- **项目对齐**：首次会话把项目资料与 workflow 默认的差异写成固定文件；真实差异逐条由你裁决，索引过期时增量更新。
- **知识事务**：写入前存快照，失败留待办，不覆盖你的手改。
- **任务信号**：task-start / phase / task-end 由 hook 与会话身份驱动，正常使用不必手工构造。
- **spec**：`.spec/<id>/spec.md` 记录某个功能现在的行为和验收条件，只写已经实现的部分。计划（如 `docs/plans/` 下的版本计划）写打算怎么改，两者不混用。

### 计划和 spec 怎么配合

还是两步：写计划，你核对后说“执行”，开始实施。spec 不单独核对，并进计划里一起看。

1. 写计划：给出建议分流（`lead-direct` 还是 `delegated`）；需要分工或独立审查时，一次列出分几个工作包、每包的范围、依赖和所用通道。已有明确安排直接沿用，无 Worker 的任务不问 Worker，只有真实新增角色或通道时才问你指定。计划末尾有一节“spec 影响”，列出要新建、修改、删除哪些 spec 条目以及改后的验收句子；不涉及 spec 时写“无”。
2. 你核对计划时把分包、角色指定和“spec 影响”一起确认。说“执行”，这些安排就一起批准。
3. 实施：Lead 按这一节改 spec，作为验收交给 Worker，Reviewer 逐条核对。只有计划没写到的 spec 改动、或要改已批准的验收时，才会再问你。
4. 收尾：spec 和代码在同一任务里提交；漏改 spec 时 task-end 被门禁挡住。Lead 同时在原计划里回写本任务完成了什么、偏离了什么、还剩什么；task-start 声明了 `plans` 而计划没动时，插件会提醒，但不挡结束。
5. 计划全部做完后，Lead 提议归档，你确认后移入归档目录：开头标状态，剩余事项抽成短待办，导航、对齐索引和各处链接一并修好。不转成 spec。

角色方法正文在[公共方法](docs/workflow.md)，三个角色分别在 `docs/roles/lead.md`、`worker.md`、`reviewer.md`。协议字段和状态机见[协议 v1](docs/design/protocol.md)。

## 更多细节

- 安装、接入、任务信号、恢复、撤销的命令细节：[使用说明](docs/usage.md)。
- 教学案例：[独立并行](examples/parallel-change/README.md)、[依赖返修](examples/dependency-and-repair/README.md)、[例行及小任务](examples/routine/README.md)。

## 开发与验证

```powershell
npm test
npm run check
npm run demo
npm run verify
```

`npm run verify` 按 `package.json` 已有脚本依次执行选中的检查，把逐项原始输出和 `summary.json`/`summary.md` 摘要写到系统状态目录（可用 `--out` 指定）；单项失败不掩盖其余结果，任一必需检查失败或未完成时整体退出码非零。测试和 demo 都在系统临时目录下的 `workflow-tests/` 中使用隔离目录、本地 Git 远端和合成事件，不写入仓库，也不碰你的真实项目与全局配置；demo 只是合成 smoke，不代表真实 ACP、模型调用或用户宿主回调。安装器只复制白名单文件；活动任务或未辨认事务会延期升级。按改动选择检查、失败判定与删除边界见[本仓维护的验证场景与命令](docs/acceptance.md#8-本仓维护的验证场景与命令f10)。

## 当前状态与限制

当前版本 0.8.1，包含协作规则、CLI、两种宿主的 hooks 适配、持久材料、分级知识、配置与可选后台复盘，以及分流、工作包账本、完成门禁、角色声明和 spec 漂移检查；真实宿主验收记录见 [0.3.0 验收](docs/acceptance.md#6-030-真实宿主验收)。安装器用内容摘要区分副本。仓库源码另提供 `npm run verify` 组合验证入口，`scripts/` 不随安装副本发布。

0.8.1 的变化：

- 安装、卸载与接入可恢复：`install` 和 `uninstall` 先落盘意图再改 hooks 配置；准备阶段或最终状态保存失败后，重试按配置前后指纹、`current` 原/新目标和绑定意图收敛，遇到第三种用户内容保留现场待核对。`project onboard` 把实际注册缺失、分组 `matcher`、`disableAllHooks` 与配置无法读取列为问题；AGENTS 管理区经同目录临时文件写入并同步，替换前复核全文。对齐只解析管理区内的标题与表格，目录检查也计入完整性。
- 协议与信号：工作包 `role` 登记后不可修改，需要换角色时新建接替包；同一批接替链按合并后的整批目标判断历史 PASS 与已审事实。宿主 `permission_mode` 是当前事件的可信观测，普通工具事件在模式变化时同步；拒绝信号只回滚业务声明，不回滚该观测。多字节进程输出按流解码，跨块字符不再损坏。
- 提取范围固定到任务：`task-start` 记录本任务起点，`task-end` 固定 transcript 前缀的大小、SHA-256 与消息边界；登记后继续追加不会进入旧作业，替换、截断、起点不可确认或旧作业缺少范围时跳过，不回退读取会话全文。学习被禁止的任务也推进边界；重放 `task-end` 只查询原任务已有作业，不为当前新任务提前登记。
- 同时修正的边界：对齐读取失败或超出检查上限时给出“不完整”提示并保留可读部分的进度；项目停用可重试且不覆盖用户手改的 AGENTS。

升级后重装宿主即可；两个宿主共用 `current`，安装命令只更新所选宿主的注册。AGENTS 管理区未变，不需要重新接入。以上行为由本仓测试与合成 smoke 覆盖，发布说明不把它们当作真实宿主验收；真实回调、模型调用和超大仓库下的 4 秒 Git 预检预算表现仍需另行验收。

0.8.0 的变化：

- 新任务显式分流：`task-start` 和完整 payload 都必须声明 `route`（`operation-only` / `lead-direct` / `delegated`）；新任务漏填或值非法返回 `ROUTE`，不建立任务。已存在任务续接可省略；旧版本留下、记录中没有 `route` 的历史任务照常续接，可在续接时补声明一次，声明后不可改。任务门禁对历史无 `route` 任务照常做 spec 检查。
- spec 检查锁外预检：`task-end` 与 Stop 在状态锁外按当前 worktree 和 `finalRef`（缺省 HEAD）检查 spec，整次检查按开始时刻的绝对截止时间给 Git 调用共用 4 秒预算：同步的文件快照读取不能强制中断，但耗时同样消耗截止时间、减少后续 Git 剩余时长，4 秒不保证预检或 Hook 总时长；锁内最终 ref 复核另有独立预算。慢 Git 不再占用其他会话需要的状态锁；预检把提交 OID、受管文件摘要、spec 清单和索引快照绑定成 `binding`，锁内只重解析一次 ref 并比对快照，不重跑 status/log/rev-list。提交、工作区、索引或会话/任务快照变化后，旧报告按 `spec-check:stale` 作废，且不可豁免，只能重试；Stop 在无法确认时明确提示“spec 检查无法确认”，不报“门禁无缺项”。
- 接入预检顺序与 PowerShell 参数：核心接入检查未通过时，`project onboard` 不读取也不执行个人或项目配置指定的执行器。生成给用户和代理的命令改用 PowerShell 单引号字面量；含空格、单引号、`$`、反引号、分号或 `$(...)` 的路径与参数按原值传递，不再被展开执行。PowerShell 5.1 无法原样传递的双引号和空参数改用 `workflow-arg64:` 标记，并只在生成命令带 `--workflow-arg64-transport` 开关时还原。
- 维护验证入口：新增 `npm run verify`，按 `package.json` 的 `check`、`test`、`demo` 顺序组合执行选中的检查，保留逐项原始输出与 `summary.json`/`summary.md` 摘要；任一必需检查失败或未完成时整体退出码非零，demo 固定标为合成 smoke。
- 同时修正的边界：对齐检查遇到权限、占用等读取失败时进入 `errors` 并把索引标为过期/不完整，不再当成文件已删除；`task-end` 拒绝时的整体回滚由生产 Hook 的事务边界保证，直接调用协议函数的新调用方需要自己提供同等边界。

升级后重装宿主即可；两个宿主共用 `current`，安装命令只更新所选宿主的注册。AGENTS 管理区未变，不需要重新接入。以上行为由本仓测试与合成 smoke 覆盖，发布说明不把它们当作真实宿主验收；真实回调、模型调用和超大仓库下的 4 秒 Git 预检预算表现仍需另行验收。

0.7.0 的变化：

- 锁争用与生命周期：短暂锁争用时在有界预算内排队重试（普通 hook 1.5 秒，Interrupt/SessionEnd 等生命周期事件 0.7 秒，均低于宿主 hook 超时），不再直接失败；预算耗尽按 `LOCKED` 保守放行并给一次恢复提示。Interrupt、StopFailure、SessionEnd 先独立落盘，拿到锁后幂等消费，迟到的旧事件不打断新回合；两个 Lead 会话共用任务时结束其中一个不再挂起另一方。锁改为每个持有者一份票据文件，已退出进程遗留的锁自动归档。实测 400 ms 持锁下入口成功率 0/5→5/5，代价是等待时中位数约 210→457 ms。
- 坏知识不再拖垮入口：入口先保存身份与回合，再在锁外读取对齐与知识；知识逐条解析，损坏条目跳过并给一句降级提示，有效条目照常召回。自动入口只附命中与遗漏总数，完整诊断用 `knowledge select|explain`。
- 后台复盘延期与冲突出口：BUSY 或只读暂缓时保存已有提案，后续 tick 只重试提交、不再调用模型，不必再手动 `learning recover`；内容冲突时用 `learning resolve --run <ID> --keep|--discard` 保留或作废提案；锁争用不再推迟整个检查周期。
- 增量对齐：`apply`/`decide`/`suggest` 可带 `sources` 只确认本次重读的来源，按 `size`/`mtimeMs` 快照复核后只刷新这些来源的基线，增量确认从 2 条命令减为 1 条，不再重复提问。
- spec 检查对象：显式非 HEAD 的 `--ref` 从该提交树读取 spec 与代码；门禁、`task show`、Stop 改用 hook 解析出的 worktree 根。代码改动不影响 spec 时推荐在内容提交上附 `Spec-OK`，空提交只用于追认既有历史。
- 安装与接入：重复 `install` 会修复自有 `current` 入口的断链或错链（不重写宿主配置），用户自己的目录或另一宿主登记的有效快照保留并报告 `conflict`；`onboard` 把核心接入与后台复盘预检分开，未加 `--enable-learning` 时预检问题只提示，显式启用失败返回 `status: partial`、退出码 1。
- 同任务改目标或权限：新增 `signal task-update`，绑定该任务的 Lead 可改 goal 与 `permissions.mode/allowedPaths`（`--paths-mode replace|append`），宿主处于只读或计划模式时只允许收窄。
- 返修计数：一轮返修对应一个交付轮次，`supersedes` 链继承计数；从未产出的启动失败重派不再虚增返修。
- 结构化提问与计划交付：宿主原生与 Codeg 的结构化提问工具自动记 waiting-user，文本提问仍需先声明。Lead 交付计划时一次列明工作包划分和各包所用通道；已声明的通道或你已指定的安排直接沿用，Lead 直接执行的任务不问 Worker，只有真实新增的角色或通道才请你确认。仅本回合显式进入计划交付阶段才核对，计划模式下的普通讨论不再单独被挡；计划交付与在途包同时成立时合并为一次提醒。
- 高频载荷一次调用：`signal packages` 可用 `--package`、`--status`、`--role`、`--channel`、`--handle`、`--ref`、`--depends-on`、`--supersedes`、`--verdict`、`--reviews` 等便捷参数记录单个工作包的派发、消费与审查结论；`task-end` 用 `--validation-ref` 和可重复的 `--evidence` 提交验证；`knowledge capture` 可用少量字段保存短材料（`--incident` 必填）。同批多个包、`change`、`waivers` 等继续用 `--input` 附业务 JSON，旧语义不变。单 Worker + 单 Reviewer 无返修流程的总工具调用从 9 次降到 6 次。
- 每轮入口降耗：未接入目录不再读取和哈希发布副本，入口约 15–23 ms→0.6 ms；知识召回的目录链校验改为每目录一次，300 条知识无变化回合入口约 573→104 ms，直接召回约 519→72 ms。

升级后两个宿主都重装（锁文件格式已变，两个宿主共用 `current`，避免新旧版本混跑）；AGENTS 管理区未变，不需要重新接入。

0.6.3 的变化：

- 规则与入口减负：`docs/roles/lead.md` 收敛为要点加场景导航表，协作、spec 与计划、UI 设计拆到 `docs/references/` 按需读取（简单任务首读减少 43%）；同一会话普通后续回合改为短入口，`SessionStart`（含压缩恢复）、角色变更与版本升级恢复完整入口。
- 一次调用信号：新增 `signal <action> --session --turn --id [字段]` 子命令，CLI 只读补齐票据与 `expectedRevision`，`lead-direct` 任务只需 `task-start` 与 `task-end` 两条命令，不必先写身份临时文件；`packages` 等结构化字段通过 `--input` 附业务 JSON，旧完整 payload 保持兼容。
- 计划交付分包与选人：Lead 交付计划时列出工作包划分（几包、每包范围与依赖，或说明免拆包理由），并按提问路径请你指定 Worker 与 Reviewer 通道；处于计划阶段但未提问就收尾时，Stop 挡一次提醒补齐。
- 分支本地 commit 与阻塞等待：非默认分支上按 `allowedPaths` 创建本地交付/检查点 commit 默认允许，直接用 Git commit OID 对齐版本（向默认分支直提、`git push`、改版本、打 tag 与发 Release 仍须显式授权）；Codeg 委派改为 `wait_ms: 0` 批量阻塞等待，不再按 60s 轮询涨上下文。
- hook 与 CLI 降耗：消除锁内外重复 `git rev-parse`、Stop 重复落盘与低频模块静态加载，实测子进程入口与 Stop 中位数耗时降低约 62%。

升级后重装宿主即可，AGENTS 管理区未变，不需要重新接入。

0.6.2 的变化：

- 派工通道：你指定了各角色用哪个智能体时，Lead 在 task-start 用 `channels` 记下，每个工作包填实际 `channel`。中途改用宿主内置子代理，或分工任务的 worker 包改由 Lead 自己实施，必须先告诉你并在账本附 `change`，否则信号被拒；不再能静默换路。
- 返修换新包号时用 `supersedes` 接上旧包：轮次照样累计（两轮上限数得到），旧包自动收尾，审查只看链上最新的包。
- 当前账本仍有审查结论的 worker 包（PASS/FIX/BLOCKED；包括它用 supersedes 接替过的旧包），审查对不上最终版本时不能再用豁免或改标 waived 通过，只能重新送审最终版本。waived 预校验同时看批前当前结论与本批合并后的最终结论，同一批改指审查对象不会立即洗掉旧 FIX/BLOCKED；重指须在单独信号成功落盘后，后续信号才不再保留旧结论。历史只有 PASS 会保留，并跨信号沿 supersedes 链单调保留。从没审过的小包仍可豁免。取消只按 PASS 判断：曾有 PASS 的包不能改 canceled（即使审查后来改成 FIX/BLOCKED）；只有 FIX/BLOCKED 而没有 PASS 的包仍可取消。同一批新建 worker 包并直接标 canceled 时，若同批 PASS 指向它或 supersedes 链上有 PASS，整批拒绝。判定细节见[协议](docs/design/protocol.md#信号)。
- 在途包全由宿主内置子代理执行时，Stop 不再要求 Codeg 式等待，只要求说明在等什么；内置子代理误发 signal 时会收到“没有 workflow 身份、不记录”的说明。

> 当前行为提示（截至 2026-10-30 的源码）：上面第 3 条关于审查豁免、waived 预校验和取消的句子混入了 0.6.2 之后的源码收紧，不是 0.6.2 发布时的行为。现行源码要求曾有 PASS 的 worker 包不能改 canceled；waived 预校验取批前当前结论、本批合并后的最终结论与单调 PASS 历史的并集，判定与数组顺序无关。以[现行协议](docs/design/protocol.md#信号)为准，上面的历史发布说明保留原样。

升级后重装宿主即可，不需要重新接入；不用这些新字段的任务行为与 0.6.1 相同。

0.6.1 的变化：

- 计划做完后的文档更新写进规则：Lead 在 task-end 前回写原计划（完成条目、偏离、剩余）；计划全部完成时提议归档，你确认后按固定步骤移入归档目录、标状态、抽出剩余待办、修好导航和链接（见[计划和 spec 怎么配合](#计划和-spec-怎么配合)）。
- 计划软门禁：task-start 可带 `plans` 声明关联计划；收尾时计划仍未改动，Stop 和 task-end 回执提醒回写，不阻止结束（见[使用说明](docs/usage.md#任务与回执)）。
- Worker 的“文档影响”扩到 README、使用说明等用户可见文档，Reviewer 一并核对。

升级后重装宿主即可，AGENTS 管理区未变，不需要重新接入；不带 `plans` 的任务行为与 0.6.0 相同。

0.6.0 的变化：

- Lead 派完工作包后不再自行结束：有在途包时 Stop 挡一次，要求在同一回合用有界等待（`get_delegation_status` 批量、`wait_ms` 60000，轮间 `check_user_feedback`）收结果，或向用户说明为什么暂停（Codeg 不会在子任务结束时唤醒主会话）。
- 信号推荐先写 UTF-8 JSON 文件再 `signal --input`；`--base64` 仅作兼容，长串可能被宿主脱敏而失效。`task-start` 缺 goal、permissions 或把 mode/allowedPaths 写在顶层时，回执点名缺项。
- spec 只写已实现的行为；计划“spec 影响”里的改后验收句子随工作包下发，实施期间以包内验收为准，集成时再改 spec。事后补写的“spec 影响”需先经你确认。
- UI 流程改为：派工前先和你确认思路和选用的本机设计技能；然后按“基准截图 → HTML 线框（每个局部 2～3 种布局）→ 高保真”逐步确认。高保真优先用项目自身界面技术（如 WPF 临时窗口套现有主题），做不了时用 HTML；生图只用于从零设计或换风格的方向探索；每步限时，换介质或方法要先确认。
- 工作包新增“相关技能”字段；Lead 报告“已满足”时注明是核实过还是推断；计划或参照资料只在未提交改动里时，派工前提示先提交。

升级后重装宿主即可，AGENTS 管理区未变，不需要重新接入。

0.5.1 的变化：只改规则文档，代码行为不变。计划末尾加“spec 影响”一节，你说“执行”即同时批准其中的 spec 改动，流程仍是“计划 → 执行”两步（见[计划和 spec 怎么配合](#计划和-spec-怎么配合)）。升级后重装宿主即可，不需要重新接入。

0.5.0 的变化：重要功能可以在 `.spec/<id>/spec.md` 写长期说明并用 `code:` 列出管辖文件；`task-end` 时插件从 git 历史检查“管辖文件改了、spec 没跟着更新”，未处理不能结束（更新 spec，或做 `Spec-OK` 空提交放行，见[使用说明](docs/usage.md#spec-检查)），`spec check` 的 git 失败附带原因。Lead 没发 `task-end` 就结束回合时，Stop 会挡一次并列出缺项。Worker 交付多一行“文档影响”，Reviewer 对照 spec 核对。说“重新对齐”即触发完整对齐，含补 spec 清单，跑完 scan 不算完成。README 写明 `disable`/`remove`/`uninstall` 删什么、留什么。项目没有 `.spec` 时行为与 0.4.2 相同，只多了 Stop 的提醒；AGENTS 管理区未变，不需要重新接入。

宿主是否实际执行 hook、压缩后的上下文行为以及外部编码代理的具体接续能力，会随 Codex / Codeg / Claude Code 版本变化。`doctor --agent <宿主>` 能核对对应注册与副本完整性；以 `/hooks` 和真实会话回调确认宿主侧状态。

Claude Code 侧的字段差异（`prompt_id` 回合、`StopFailure` 中断、stdout 回执）见 [Claude Code 适配](docs/adapters/claude.md)。

任务可声明分流（`operation-only` / `lead-direct` / `delegated`）。分工任务用批量 `packages` 信号记录工作包账本，`task-end` 时核对必要包终态、审查版本与交付版本一致、验证绑定最终版本；缺项可显式豁免。门禁只核对 Lead 声明记录的一致性，不证明审查或测试真实发生。委派子会话用 `role-claim` 声明角色，避免被计为第二个 Lead。宿主能力（子会话区分、各模式提问工具）记录在适配文档的能力表中，未实测的格子标 unknown。

workflow 管项目开发知识；[document-learning](https://github.com/Inmata/document-learning) 独立管理个人文档经验。两者不共享库或信号。跨会话持久保存限同一电脑；项目配置与正式知识可随 Git 走，本机材料不自动跨电脑同步。

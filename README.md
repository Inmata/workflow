# workflow

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

`install` 会做四件事：把当前源码复制成一份带摘要的发布副本（`releases/<version>-<digest>`）、把固定入口 `current` 指向它、在宿主配置里注册本插件的事件（Codex 写 `hooks.json`，Claude 写 `settings.json`）、记录安装事务。hook 命令只包含 `current` 路径，所以升级后路径不变，宿主信任只需做一次；旧副本保留作回滚。它**不会**写宿主信任、不会改项目、不会提交 Git。

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

`onboard` 先把所有检查做完再写入：宿主是否已安装且版本一致、目录和 Git 身份、`AGENTS.md` 里有没有复制来的或残留的管理区、后台复盘执行器能否启动（只核对能力，不调用模型）。任何一项不过都不写入，并一次列出所有问题和可直接复制的修复命令；执行器缺专用配置时给出警告和登记命令。想同时启用后台复盘就加 `--enable-learning`（在你自己的终端执行；代理执行会被宿主自动审批拦截），不打算启用时加 `--skip-learning`。

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
| 需要等你拍板 | 先标 waiting-user，不会猜着往下做 |
| 你中断了 | 只保存状态，不会在你下次进来时偷偷接着干 |

一切写操作只在你明确要求时才发生。插件不会自动 add / commit / push / 发布，也不会替你改版本号。

### 第 4 步：收尾与经验

有明确纠正、失败原因或验证结果时，Lead 保存短材料；没有新材料就直接交付。Stop 不要求补一轮复盘，也不要求每轮提交“无新经验”。材料先写入本机磁盘，换会话仍保留。

启用后台学习后，按你设置的材料阈值、最久等待时间和检查频率批量复盘。最长执行时间、每日次数、单批大小、模型与推理强度都可设置。正式经验存于 `.workflow/knowledge/`，分别记录成熟度、重要性、状态、范围和证据；新反例会立即阻止旧经验默认召回。当前项目事实仍维护在已有 README、spec 等权威资料中。

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

## 升级

升级不改项目文件，不动已接入项目的绑定、对齐文档、材料和经验。每台电脑各执行一次，先结束正在进行的任务（有活动任务时安装会拒绝升级）。以下命令假设本仓库在 `D:\git-repo\workflow`，路径不同时替换成实际目录。

1. 拉取新版本：

```powershell
cd D:\git-repo\workflow
git pull
```

本插件没有运行时依赖，不需要 `npm install`。

2. 对已安装的每个宿主分别重新执行 `install`，只装了一个宿主时只运行对应命令：

```powershell
cd D:\git-repo\workflow
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

### 升级后重新接入项目

新版本改了管理区内容、对齐协议或接入检查时，可以对已接入的项目重新执行一次接入。先完成上面的插件升级，否则接入预检会报宿主版本不一致：

```powershell
cd D:\git-repo\workflow
node bin/workflow.mjs project onboard --root "D:/你的项目"
```

重复接入会：

- 重新做全部预检，不过时不写入，列出问题和修复命令；
- 把 `AGENTS.md` 管理区原位替换为新版本内容，管理区外的正文不动；
- 重新扫描对齐索引，用新的扫描规则记录文件清单；
- 保留项目 ID、后台复盘开关、计划任务登记、已裁决和待裁决的对齐记录。学习已启用时不再提示启用，也不必加 `--enable-learning`。

它**不会**改写 `docs/WORKFLOW-ALIGNMENT.md`，也不会动 `.workflow/` 中的材料和经验。

管理区被手改过时预检会报 `AGENTS`，按提示删掉 `<!-- workflow:begin -->` 到 `<!-- workflow:end -->` 之间（含这两行）的内容后重试。项目目录被移动或 Git 仓库被重建时预检会报 `IDENTITY`，按提示先 `project remove` 再接入；`remove` 会清除本机的学习开关、计划任务和裁决登记，项目内的对齐文档和 `.workflow/` 保留。

重新接入不会让 Lead 自动重做对齐：之后的会话仍只在资料文件变化时增量更新。想按新的对齐协议重新整理对齐文档，接入后在项目里开一个新会话，对 Lead 说"重新对齐"，它会按[项目对齐](docs/alignment.md)全量扫描并更新对齐文件。已登记的裁决仍在本机记录里，不需要先删除对齐文档；对齐文件里有你手写的内容时，提醒 Lead 保留。

各版本的变化见 GitHub Releases。

## 这些概念的关系

- **Lead**：定范围、定验收、派工、集成、做知识处置。简单任务自己上。
- **Worker**：在给定的允许路径内实施和自测，不递归派工。
- **Reviewer**：只读审查，不改代码；分 Diff、Deep、Escalated 三档。
- **AGENTS.md**：只是短导航，指向项目原有资料，不承载全部正文。
- **项目对齐**：首次会话把项目资料与 workflow 默认的差异写成固定文件；真实差异逐条由你裁决，索引过期时增量更新。
- **知识事务**：写入前存快照，失败留待办，不覆盖你的手改。
- **任务信号**：task-start / phase / task-end 由 hook 与会话身份驱动，正常使用不必手工构造。

角色方法正文在[公共方法](docs/workflow.md)，三个角色分别在 `docs/roles/lead.md`、`worker.md`、`reviewer.md`。协议字段和状态机见[协议 v1](docs/design/protocol.md)。

## 更多细节

- 安装、接入、任务信号、恢复、撤销的命令细节：[使用说明](docs/usage.md)。
- 教学案例：[独立并行](examples/parallel-change/README.md)、[依赖返修](examples/dependency-and-repair/README.md)、[例行及小任务](examples/routine/README.md)。

## 开发与验证

```powershell
npm test
npm run check
npm run demo
```

测试和 demo 都在系统临时目录下的 `workflow-tests/` 中使用隔离目录、本地 Git 远端和合成事件，不写入仓库，也不碰你的真实项目与全局配置。安装器只复制白名单文件；活动任务或未辨认事务会延期升级。

## 当前状态与限制

当前版本 0.4.1，包含协作规则、CLI、两种宿主的 hooks 适配、持久材料、分级知识、配置与可选后台复盘，以及分流、工作包账本、完成门禁和角色声明；真实宿主验收记录见 [0.3.0 验收](docs/acceptance.md#6-030-真实宿主验收)。安装器用内容摘要区分副本。

宿主是否实际执行 hook、压缩后的上下文行为以及外部编码代理的具体接续能力，会随 Codex / Codeg / Claude Code 版本变化。`doctor --agent <宿主>` 能核对对应注册与副本完整性；以 `/hooks` 和真实会话回调确认宿主侧状态。

Claude Code 侧的字段差异（`prompt_id` 回合、`StopFailure` 中断、stdout 回执）见 [Claude Code 适配](docs/adapters/claude.md)。

任务可声明分流（`operation-only` / `lead-direct` / `delegated`）。分工任务用批量 `packages` 信号记录工作包账本，`task-end` 时核对必要包终态、审查版本与交付版本一致、验证绑定最终版本；缺项可显式豁免。门禁只核对 Lead 声明记录的一致性，不证明审查或测试真实发生。委派子会话用 `role-claim` 声明角色，避免被计为第二个 Lead。宿主能力（子会话区分、各模式提问工具）记录在适配文档的能力表中，未实测的格子标 unknown。

workflow 管项目开发知识；document-learning 独立管理个人文档经验。两者不共享库或信号。跨会话持久保存限同一电脑；项目配置与正式知识可随 Git 走，本机材料不自动跨电脑同步。

# workflow

workflow 是一套跨智能体的项目协作与知识维护规则。它解决三件事：**谁做什么**（Lead、Worker、Reviewer 的分工与边界）、**怎么收尾**（任务阶段、知识处置、待恢复状态）、**怎么留下经验**（写回项目原有资料）。

**Lead、Worker、Reviewer 是职责，角色不绑定客户端或模型。** Claude Code 可以担任 Lead，也可以担任 Worker 或 Reviewer；Codex、OpenCode、Pi 等同样按当前授权和实际能力分工。具体安排由用户已确认的角色、可用工具和任务需要决定。

## 角色与接入支持

角色方法共用同一套[公共方法](docs/workflow.md)和[角色指引](docs/roles/lead.md)。同一种智能体也可以用不同的独立会话分别实施和审查。

自动 hook 接入目前支持以下宿主，两者都能作为 Lead 接收项目上下文、提交任务信号和完成知识处置：

| 宿主 | 安装参数 | 用户配置 | 适配说明 |
| --- | --- | --- | --- |
| Claude Code | `--agent claude` | `~/.claude/settings.json` | [Claude Code](docs/adapters/claude.md) |
| Codex / Codeg Codex ACP | `--agent codex` | `~/.codex/hooks.json` | [Codeg ACP](docs/adapters/codeg.md) |

`--agent` 选择 hook 的宿主适配，不指定协作角色。OpenCode、Pi 等可通过宿主已有的委派工具参加协作，角色由工作包指定；它们的原生 hook 自动接入尚未实现，独立运行时不能保证同样的自动收尾。

运行环境为 Windows + Node.js 24+，ESM，无第三方运行时依赖，无常驻服务，不新增付费模型调用。

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

`install` 会做四件事：把当前源码复制成一份固定发布副本、在宿主配置里注册本插件的事件（Codex 写 `hooks.json`，Claude 写 `settings.json`）、记录安装事务、保留旧副本。它**不会**写宿主信任、不会改项目、不会提交 Git。

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
node bin/workflow.mjs project enable --root "D:/你的项目"
```

这一步是在项目根目录插入一段很短的 `AGENTS.md` 管理区，并建立本机绑定。它保留你原有的 AGENTS 正文，不要求你补 README、spec 或计划，也不会创建空 LESSONS。

接入后，在已安装适配的 Claude Code 或 Codex 中打开**该项目里的新会话**，插件才会给出对应上下文。同一本机目录共用项目绑定，切换这两个宿主无需重复 `project enable`。多个独立 Lead 并行时，共享资料的写入需明确[知识负责人](docs/usage.md#安装与首次接入)。

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

任务结束时 Lead 会做一次知识处置，三选一：

- `no-new-learning`：这次没有值得沉淀的东西。
- `updated`：已经写回项目原有资料，并附真实事务 ID。
- `pending-recovery`：资料没写完或证据不足，留下待办。

经验写回**项目原有的** README、spec、实现说明或计划，名称和路径都不改。只有确实存在独立的失败经验才建 LESSONS，不批量生成空文件。

## 一次完整使用的例子

假设你使用 Claude Code 作为 Lead，项目 `D:/my-app` 要修一个登录超时的问题：

1. 你安装 `--agent claude`，执行 `project enable --root "D:/my-app"`，并在该目录开一个 Claude Code 新会话。
2. 你说"登录 30 秒后超时，帮我查一下并修掉"。
3. Claude Code 作为 Lead 读项目现有资料，确认这是真实代码修复，通过可用且已授权的委派工具派一个 Worker 改实现并自测。
4. Worker 交回差异和测试结果，Lead 派独立 Reviewer 做只读审查。
5. Reviewer 有意见就退给原 Worker 定向修复，没问题就 Lead 集成并跑必要回归。
6. Lead 把可复用的结论写回项目原有文档，回复你改了什么、怎么验证的、还剩什么。
7. 任务结束（task-end）。整个过程不需要你手动发信号。

换成 Codex 作为 Lead 时，流程相同，安装选择 `--agent codex`。Worker、Reviewer 的智能体类型按当前安排选择；缺少必要的委派入口时明确报告阻塞，不把交接文本当成已启动的智能体。如果你只想让它看看状态，第 3～5 步都会跳过，Lead 直接回你。

## 什么时候需要自己敲命令

日常使用基本不需要。下面这些是运维动作：

| 目的 | 命令 |
| --- | --- |
| 看 Claude 安装/信任/回调状态 | `node bin/workflow.mjs doctor --agent claude` |
| 看 Codex 安装/信任/回调状态 | `node bin/workflow.mjs doctor --agent codex` |
| 项目接入 | `node bin/workflow.mjs project enable --root "<项目>"` |
| 项目停用 | `node bin/workflow.mjs project disable --root "<项目>"` |
| 查看角色上下文 | `node bin/workflow.mjs context --role lead --project "<项目>"` |
| 撤销 Codex 注册 | `node bin/workflow.mjs uninstall --agent codex` |
| 撤销 Claude 注册 | `node bin/workflow.mjs uninstall --agent claude` |

`disable` 只停用单个项目，管理区没被手改才撤下；`uninstall` 只移除该宿主上本插件自己的 handler，其他插件、发布副本、项目资料和经验全部保留。

## 升级

修好代码或文档后，对已安装的每个宿主分别重新执行 `install`；只装了一个宿主时，只运行对应命令：

```powershell
node bin/workflow.mjs install --agent claude
node bin/workflow.mjs install --agent codex
```

它会先算出新的发布摘要，复制到新的固定副本，完整性校验通过后才切换该宿主的 hooks 命令，旧副本保留不动。两个宿主可以复用同一发布副本，但安装命令只更新所选宿主的注册。有活动任务或未辨认事务时会拒绝升级并告诉你原因，等任务结束再来即可。

切换后按对应宿主核对 `/hooks` 与确认提示，然后开一个新会话观察第一次回调。

## 这些概念的关系

- **Lead**：定范围、定验收、派工、集成、做知识处置。简单任务自己上。
- **Worker**：在给定的允许路径内实施和自测，不递归派工。
- **Reviewer**：只读审查，不改代码；分 Diff、Deep、Escalated 三档。
- **AGENTS.md**：只是短导航，指向项目原有资料，不承载全部正文。
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

0.2.0 已实现协作规则、CLI、两种宿主的 hooks 适配、隔离安装和知识维护。角色分配与模型无关，自动收尾依赖实际宿主适配和回调。

宿主是否实际执行 hook、压缩后的上下文行为以及外部编码代理的具体接续能力，会随 Codex / Codeg / Claude Code 版本变化。`doctor --agent <宿主>` 能核对对应注册与副本完整性；以 `/hooks` 和真实会话回调确认宿主侧状态。

Claude Code 侧的字段差异（`prompt_id` 回合、`StopFailure` 中断、stdout 回执）见 [Claude Code 适配](docs/adapters/claude.md)。

workflow 管项目开发知识；document-learning 独立管理个人文档经验。两者不共享库、信号或补偿预算。

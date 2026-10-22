# workflow

给 Codex / Codeg 用的一套项目协作与知识维护规则。它解决三件事：**谁做什么**（Lead、Worker、Reviewer 的分工与边界）、**怎么收尾**（任务阶段、知识处置、待恢复状态）、**怎么留下经验**（写回项目原有资料，而不是另建一套空文档）。

首版面向 Windows + Node.js 24+ + Codeg Codex ACP，ESM，无第三方运行时依赖，无常驻服务，不新增付费模型调用。

## 新用户从这里开始

如果你只想知道“装上之后我该干什么”，按下面四步走。全部命令都在本仓库根目录执行。

### 第 1 步：安装到本机

```powershell
node bin/workflow.mjs install --agent codex
node bin/workflow.mjs doctor
```

`install` 会做四件事：把当前源码复制成一份固定发布副本、在 `hooks.json` 里注册八个事件、记录安装事务、保留旧副本。它**不会**写宿主信任、不会改项目、不会提交 Git。

`doctor` 看的是四项不同的事，不要混为一谈：

| 字段 | 含义 |
| --- | --- |
| `registration` | hooks.json 里有没有本插件的定义 |
| `discovery` / `trust` | 宿主是否发现并信任了当前定义（插件查不到时显示 `unknown`，这是正常的） |
| `execution` | 是否真实收到过回调事件 |
| `integrity` | 发布副本是否与安装记录逐文件一致 |

安装或升级后，信任状态会变成 `modified`。这时在 Codex/Codeg 里执行 `/hooks`，逐项确认本插件的八个条目为 trusted。插件不替你写信任记录。

### 第 2 步：让项目接入

```powershell
node bin/workflow.mjs project enable --root "D:/你的项目"
```

这一步是在项目根目录插入一段很短的 `AGENTS.md` 管理区，并建立本机绑定。它保留你原有的 AGENTS 正文，不要求你补 README、spec 或计划，也不会创建空 LESSONS。

接入后打开**该项目里的新会话**，插件才会给出对应上下文。

### 第 3 步：在新会话里正常工作

不需要记命令。你在项目会话里正常提需求，Lead 会按任务大小自行分流：

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

假设项目 `D:/my-app` 要修一个登录超时的问题：

1. 你执行 `project enable --root "D:/my-app"`，并在该目录开新会话。
2. 你说"登录 30 秒后超时，帮我查一下并修掉"。
3. Lead 读项目现有资料，确认这是真实代码修复，派一个 Worker 改实现并自测。
4. Worker 交回差异和测试结果，Lead 派独立 Reviewer 做只读审查。
5. Reviewer 有意见就退给原 Worker 定向修复，没问题就 Lead 集成并跑必要回归。
6. Lead 把可复用的结论写回项目原有文档，回复你改了什么、怎么验证的、还剩什么。
7. 任务结束（task-end）。整个过程不需要你手动发信号。

如果你只想让它看看状态，第 3～5 步都会跳过，Lead 直接回你。

## 什么时候需要自己敲命令

日常使用基本不需要。下面这些是运维动作：

| 目的 | 命令 |
| --- | --- |
| 看安装/信任/回调状态 | `node bin/workflow.mjs doctor` |
| 项目接入 | `node bin/workflow.mjs project enable --root "<项目>"` |
| 项目停用 | `node bin/workflow.mjs project disable --root "<项目>"` |
| 查看角色上下文 | `node bin/workflow.mjs context --role lead --project "<项目>"` |
| 撤销全局注册 | `node bin/workflow.mjs uninstall --agent codex` |

`disable` 只停用单个项目，管理区没被手改才撤下；`uninstall` 只移除本插件自己的八个 handler，其他插件、发布副本、项目资料和经验全部保留。

## 升级

修好代码或文档后，重新执行一次 `install`：

```powershell
node bin/workflow.mjs install --agent codex
```

它会先算出新的发布摘要，复制到新的固定副本，完整性校验通过后才切换 hooks 命令，旧副本保留不动。有活动任务或未辨认事务时会拒绝升级并告诉你原因，等任务结束再来即可。

切换后同样要到 `/hooks` 确认八个条目重新 trusted，然后开一个新会话观察第一次回调。

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

0.1.0 的核心、CLI、hooks、隔离安装、代码合流、压缩与恢复均已实现。首次安装及每次升级后的 `/hooks` 信任确认由用户完成，插件不代写。

宿主是否实际执行 hook、压缩后的上下文行为以及外部编码代理的具体接续能力，会随 Codex / Codeg 版本变化。`doctor` 能核对本机注册与副本完整性；以 `/hooks` 和真实会话回调确认宿主侧状态。

workflow 管项目开发知识；document-learning 独立管理个人文档经验。两者不共享库、信号或补偿预算。

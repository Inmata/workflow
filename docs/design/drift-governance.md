# 漂移治理设计

状态：已实施（0.5.0）。基线：0.4.2（main 5f00949）。协议部分已并入[协议](protocol.md#spec-检查)，角色规则并入 [Lead](../roles/lead.md)、[Worker](../roles/worker.md)、[Reviewer](../roles/reviewer.md)；本文件保留设计依据，不进入发布白名单。

## 要解决的问题

| 漂移 | 现象 | 现有缺口 |
| --- | --- | --- |
| 意图漂移 | 做出来的东西偏离用户要的 | 需求只在聊天和简报里，审查没有可对照的长期依据 |
| 文档漂移 | 文档描述的已不是代码现状 | 对齐只比较索引文件的大小和 mtime（[协议](protocol.md#项目对齐)），不知道哪份文档对应哪段代码 |
| 交接漂移 | 子会话只看到简报，漏掉约束 | [Worker 交付模板](../roles/worker.md#交接)没有“文档影响”；简报不指向长期说明 |

## 总体思路

1. 只给重要功能写长期说明（spec），写清要做到什么、为什么、怎么算完成，并用 `code:` 列出它管辖的代码文件。
2. 派工时简报列出相关 spec，Worker 先读；交付时申报文档影响；Reviewer 对照 spec 逐条核对。
3. Lead 发 `task-end` 时，插件用 git 历史检查“管辖文件改了、spec 没跟着更新”，未处理就不能结束。
4. 合并后满足触发条件时做一次整体结构检查；中途变更按大小分流；UI 工作按四种场景走固定流程。

## 与 SpexCode 的关系

沿用 [SpexCode](https://github.com/shuxueshuxue/spexcode)（0.7.0，HEAD 408cb72）的 spec 格式和放行规则，检测由 workflow 自己实现，不安装、不依赖它的程序。原因：

- 它的检测命令在原生 Windows 报 ENOENT：项目目录编码只替换 `/` 和 `.`，`C:` 原样进入目录名，`SPEXCODE_HOME` 无法绕过。
- 完整 init 会装 6 个 git hook，其中 main-guard 禁止直接在 main 提交，与当前工作方式冲突。

格式一致，以后需要函数级检测或它修复 Windows 问题时，可以直接换用它的工具，已有 spec 不用改。本设计比它多一条限制：spec 目录名在 `.spec` 内唯一，因此 id 总是目录名，在两边算出的结果相同。

## spec 格式

位置统一为 `.spec/<id>/spec.md`，`<id>` 即目录名，可嵌套，但整个 `.spec` 内不得重名。

```markdown
---
title: 搜索
status: active
desc: 一句话说明这个功能
code:
  - src/search.mjs
  - src/ui/search-box.mjs
related:
  - docs/usage.md
---
# 搜索

## 目标
用户能感知的行为。

## 原因
为什么要这样做，排除过哪些做法。

## 验收
可逐条核对的条件。

## 边界
不做什么；与其他 spec 的分工。
```

- `code:` 只写具体文件，不写目录或通配。同一文件可被多个 spec 管辖，各自独立检查。
- `related:` 只供阅读和覆盖统计，不参与检查。
- 其他 SpexCode 字段（`hue`、`order` 等）允许存在，插件忽略。
- 长期设计说明固定为 `.spec/design/spec.md`，记录样式变量（颜色、字号、间距、圆角等）和组件规则，`code:` 写样式变量文件，与其他 spec 同样检查。
- 架构说明可选，放 `.spec/architecture/spec.md`；不强制每个项目都写。

**哪些功能要建 spec**：满足任一条，Lead 就提议留档，用户确认后建立：

- 有用户能感知的行为和验收条件；
- 预计跨多个会话开发；
- 已经发生过漂移。

小修改、一次性脚本不建。这与[公共方法](../workflow.md#知识)“不创建必填文档套件”一致。

**接入**：首次接入或重新接入时，Lead 在项目对齐中扫描现有资料，提出 `.spec` 条目清单（id、来源文档、`code:`），用户确认后写入。原文档保留原位，可在 spec 的 `related:` 中引用。

## 文件级过期检查

### 规则

对每个 spec 的每个 `code:` 文件，从检查版本（`finalRef`，缺省为 `HEAD`）往回看：

| 结果 | 条件 |
| --- | --- |
| `drift` | 存在修改该文件的提交，它既不是任何一版 spec 的祖先，也没有被放行 |
| `uncommitted-drift` | 只在检查 `HEAD` 时判断：工作区里该文件有未提交改动，而 spec 没有 |
| `missing` | 被管辖文件不存在（改名或删除后没同步 `code:`） |
| `duplicate-id` | `.spec` 内有两个同名目录 |

放行规则与 SpexCode 一致，用提交信息里的 `Spec-OK: <id>` trailer：

- 写在内容提交上：只豁免这一个提交（优先方式）。
- 写在空提交上（树与父提交相同）：覆盖它所有可达的祖先；只在需要追认既有历史时使用。
- 一个 trailer 可写多个 id，用逗号分隔；只对列出的 id 生效。

放行命令示例，理由写在提交正文里：

```text
git commit -m "refactor: search 无需更新" -m "重命名内部变量，行为不变。" --trailer "Spec-OK: search"
```

漂移每次从 git 历史现算，不保存哈希，因此 rebase、cherry-pick 和合并后结果仍然正确。

### 检查不了时

- 浅克隆：提交历史不完整，无法判断哪些提交没被 spec 见过。返回 `spec-check:shallow`。
- git 不可用或超时：返回 `spec-check:git`。
- 项目没有 `.spec` 目录：跳过，不报缺项。非 Git 的接入项目即使 task-end 带了 `finalRef` 也按此处理；非 Git 但存在 `.spec` 时仍报 `spec-check:git`。

前两种是“没法检查”，不是漂移。Lead 写明理由后可以用 waiver 跳过（step 写 `spec-check` 或完整条目），跳过记入任务。

### 可靠性依据

原型在原生 Windows 上跑了 14 个场景，全部符合预期：

1. 初始状态通过；
2. 改代码不改 spec，报漂移；
3. 更新 spec 后通过；
4. 内容提交带 Spec-OK，通过；
5. 之后连改两次代码，报漂移并列出这 2 个提交；
6. 空提交放行后通过；
7. 放行后再改代码，报漂移；
8. 只放行另一个节点，仍报漂移；
9. 共享文件只放行其中一个节点，另一个节点报漂移；
10. 两个节点都处理后通过；
11. 有未提交改动，报 `uncommitted-drift`；
12. 分支上改代码、主干上改 spec 后合并，报漂移；
13. 被管辖文件改名，报 `missing`；
14. 浅克隆，拒绝检查。

原型修过的问题：

- `^<commit>` 写在了 `--` 之后，被当成路径；
- trim 吃掉了 porcelain 输出首行的前导空格；
- Spec-OK 起初按路径匹配，已改为按 id。

实施时这三点都要写成回归测试。

**局限**：只能判断“改没改”，不能判断 spec 内容对不对；在 spec 里随便改一个字也能通过。spec 内容是否正确由 Reviewer 核对补上（见下文）。第一期在文件级就阻断，比 SpexCode 只给 warn 更严，打扰会更多；按函数判断推到后续阶段。

### 命令

新增只读命令 `workflow spec check --project <root> [--ref <commit>]`，输出：

```json
{"ok": false, "ref": "HEAD", "findings": [{"id": "search", "spec": ".spec/search/spec.md", "code": "src/search.mjs", "kind": "drift", "commits": ["a1b2c3d"]}]}
```

Lead 和 Worker 都可以在交付前运行它。指定 `--ref` 时先固定成提交 OID，spec 清单、正文、`code:` 路径和文件存在性都从该提交读取；输出里的 `ref` 也是该 OID。未指定时（以及指定 `--ref HEAD` 时）检查当前 worktree 的 `HEAD` 与未提交改动。检查根是命令所在目录对应的当前 worktree，从子目录运行也回到 worktree 根。task-end 自带同一检查，显式命令只用于提前诊断。git 调用沿用 `src/projects.mjs` 的 `spawnSync` 方式：设超时，不经 shell，参数逐个传入。

## 接入 task-end 门禁

门禁的 `missing` 新增 `spec:<id>`，每个有问题的 spec 列一条，消息里附 findings。规则：

- 对 `delegated` 和 `lead-direct` 两种路线都生效；`operation-only` 不检查。未声明 route 的旧任务同样检查。
- 只能靠两种方式消除：更新 spec，或在内容提交上附 `Spec-OK`；需要追认既有历史时才用空提交。`waivers` 中 `spec` 类别和 `spec:<id>` 条目都不接受，回执返回 `WAIVER`。这样每次“代码改了但 spec 不用改”的判断都留在 git 历史里。`spec-check:<原因>` 不受此限。
- 放行权限：Lead 写明理由后可以放行纯重构；修改 spec 的目标、原因、验收、边界正文，必须先经用户同意。只同步 `code:` 路径（文件改名或删除时，在同一提交里修改）不算改动需求原文，Lead 可以直接处理。
- 检查在 `acceptSignal` 内同步执行，失败时与其他缺项一样整体回滚，不留下部分状态。

`task show --task <id>` 的“当前缺项”同时显示 spec 检查结果。

## 回合结束核对

门禁只在 Lead 发 `task-end` 时运行。Lead 没发就宣布完成，门禁不会运行。为此在 Stop 时补一次核对。

触发条件（同时满足）：

- 当前会话角色是 Lead，绑定的任务仍为 active，route 不是 `operation-only`；
- phase 不是 `waiting-user`；
- `stop_hook_active` 不为 true，且本回合还没挡过。

计划模式的计划交付核对只在本回合显式 `task-start`/`phase`（`session.phase` 不跨回合继承）或活动任务已声明 `plans` 时触发；仅有 `mode=plan` 的普通解释放行，不扫描自然语言或文件名猜意图。

有 dispatched 工作包时（0.6.0 起）：返回 `{decision: 'block', reason}`，列出在途包和 handle，要求 Lead 继续有界等待结果，或向用户说明暂停原因。Codeg 不会在委派结束时唤醒父会话，0.5.x 在此放行，Lead 结束回合后就收不到子任务结果。

没有在途包时的动作：按 `task-end` 门禁计算全部缺项（`child`、`terminal`、`review`、`validation`、`spec`，已记入任务的 waivers 照常抵扣）。有缺项时返回 `{decision: 'block', reason}`，`reason` 列出缺项，要求 Lead 二选一：补齐后发 `task-end`，或者向用户说明哪些还没完成。没有缺项但任务仍未结束时，同样挡一次，提醒发 `task-end`。

约束：

- 核对只读：不改任务状态，不替 Lead 发 `task-end`，不计入返修次数。在 session 上记录“本回合已挡”，与宿主的 `stop_hook_active` 互为保险，同一回合最多挡一次。
- 状态损坏、锁超时、git 失败时放行，与现有 hook 的保守策略一致；git 失败只是不算 `spec` 一项，其余照常核对。
- 宿主支持：Codex 文档写明 Stop 返回 `decision: "block"` 会以 `reason` 续一轮，并提供 `stop_hook_active`（[Codex hooks](https://learn.chatgpt.com/docs/hooks)）；Claude Code 同构。workflow 0.1 到 0.2 在两个宿主上用过同一机制（`63f0cd8` 去掉）。2026-10-25 用探针实测，Claude Code CLI 2.1.310、Codeg 中的 Claude Code 和 Codeg 中的 Codex（codex-acp 0.160.1）都通过：第一次 Stop 挡下后续一轮，第二次 Stop 带 `stop_hook_active: true`，续轮不触发 `UserPromptSubmit`，`turn_id`/`prompt_id` 不变。Codex 把 `reason` 作为一条 `<hook_prompt>` 用户消息注入。
- Codeg 中的 Codex 没有执行项目级 `.codex/hooks.json`（目录已信任、哈希已确认），用户级 hook 正常执行。workflow 本来就注册在用户级，不受影响。

防不住的情况：

- Lead 从没发过 `task-start`，或某项工作从未记进工作包。插件只知道已记录的内容。
- hook 没有执行（宿主信任失效等）。

误挡：非计划模式下，Lead 用普通文字中途汇报但任务仍为 active、未发 `task-end` 时也会被挡一次，代价是多一轮简短回复，不影响之后的 `task-end`。计划模式的普通讨论不再单独触发。

远端 CI 加分支保护能强制阻止带漂移的代码进入 main，但只能看到 git 里的内容（审查与验证记录在本机），而且需要改成走 PR 合并。第一期不提供，需要时 `spec check` 可以直接在 CI 里运行。

## 角色规则改动

**Lead**（[lead.md](../roles/lead.md)）

- 协调第 1 条的每包字段新增“相关 spec：路径列表；无则写无”。
- 协调第 5 条：派 Reviewer 时附同一组 spec 路径。
- 协调第 7 条：集成后发 `task-end`，由它做权威 spec 检查并逐条处理结果；需要提前定位时再运行 `spec check`。
- 新增“整体结构检查”和“中途变更”两段，内容见下文。
- “设计”段改写为四种 UI 场景流程。

**Worker**（[worker.md](../roles/worker.md)）

- 开工前读简报列出的 spec。简报与 spec 冲突时，受影响部分暂停并问 Lead，独立部分继续。
- 交付模板在“测试”之后加一行：

```text
文档影响：<spec id>：已更新 | 未更新（原因）；无影响写“无：理由”
```

**Reviewer**（[reviewer.md](../roles/reviewer.md)）

- 对照同一组 spec 逐条核对“验收”，未满足的条目按 FIX 报告。
- 核实“文档影响”申报：行为变了而 spec 没改，或申报“无”却改了管辖文件，都按 FIX 报告。
- 审查报告的“验收”栏按 spec 条目列出已证实和未证实项。

**Lead 直接实施**（`lead-direct`）同样要申报文档影响并通过检查，由 Lead 在交付说明中写明。

## 整体结构检查

满足任一条件，Lead 在集成后、`task-end` 前安排一个 Reviewer 包做整体结构检查：

1. 同一任务有 2 个及以上 Worker 包改到同一模块或共享接口；
2. 新增顶层模块或目录；
3. 新增、删除或升级运行时依赖；
4. 对外接口签名变化。

都不满足时只做单包审查。

检查依据：项目有 `.spec/architecture/spec.md` 时对照它；没有时对照集成前代码的模块边界和依赖方向，并在结果里建议是否补写架构说明。检查只看边界和依赖是否被打乱、重复实现、接口是否一致，不重审单包已通过的内容。触发条件需要语义判断，由 Lead 决定，插件不自动识别；结构检查包像其他 Reviewer 包一样记账，受“终态”门禁约束。

## 中途变更

- **重大变更**：改变已确认的目标、验收、架构边界、视觉方向，或需要修改 spec 正文。Lead 暂停受影响的包，向用户确认后，以新基准和用户原话重新派发（沿用现有中途纠正流程）。
- **细节变更**：不影响上述内容的实现取舍。Lead 直接处理，同步给受影响的包，并写进任务记录。

任务记录的承载方式：`packages` 信号新增可选字段 `change: {summary, reason, packages[]}`，追加到 `task.changes`，不覆盖历史；`task show` 和挂起续接时的账本摘要显示条数。状态文件仍为 `schemaVersion=2`，旧任务没有该字段时视为空。

## UI/UX 场景流程

| 场景 | 流程 | 需要用户确认 |
| --- | --- | --- |
| 从零设计 | 先给出方向和一个样板页，选定后扩展；同时建立 `.spec/design` | 方向、样板页 |
| 现有设计加功能 | 沿用 `.spec/design` 和现有组件 | 需要新组件或新布局方式时先确认样稿 |
| 换风格、大改版 | 冻结功能，确认样板页后逐页迁移，每页附改前改后截图 | 样板页；迁移中出现功能变化时再确认 |
| 交互与局部 | 流程变化先确认；纯视觉微调直接做 | 流程变化 |

所有 UI 交付都附截图。样式变量改动会触发 `.spec/design` 的过期检查。原“用户要求先选图片时单独安排设计确认”的规则保留，作为从零设计和大改版中样板页环节的一种做法。

## 第一期范围

包括：

1. spec 格式与建立规则；
2. Worker 申报文档影响；
3. 完成前文件级过期检查和放行记录，以及回合结束核对；
4. 中途变更规则；
5. 四种 UI 场景流程；
6. 整体结构检查触发条件。

延后：

- 按函数判断的检测（`path#symbol`）；
- 切换到 SpexCode 工具；
- 远端 CI 检查。

## 实施清单

| 文件 | 改动 |
| --- | --- |
| `src/spec.mjs`（新） | 收集 spec、解析 frontmatter、检查 id 重名、计算漂移 |
| `src/protocol.mjs` | `gateMissing` 加 `spec:<id>` 与 `spec-check:<原因>`；`waiverInput` 拒绝 `spec` 类别；`packages` 接受 `change`；`stop` 改为回合结束核对 |
| `bin/workflow.mjs` | `spec check` 子命令；`task show` 显示 spec 缺项和变更条数 |
| `test/spec.test.mjs`（新） | 原型 14 个场景、id 重名、原型修过的三个问题 |
| `test/gate.test.mjs` | spec 缺项、不可 waive、`spec-check` 可 waive、两种路线、无 `.spec` 跳过、回滚 |
| `test/hooks.test.mjs`、`test/claude.test.mjs` | Stop 核对：有缺项挡一次；在途包挡一次要求继续等待（0.6.0）；waiting-user、`stop_hook_active`、已挡过时放行；状态损坏时放行；不改任务状态 |
| `docs/roles/*.md`、`docs/workflow.md` | 按上文改写 |
| `docs/design/protocol.md` | 并入门禁、信号字段和命令说明 |
| `docs/alignment.md` | 接入时提出 `.spec` 清单 |
| `docs/acceptance.md` | 新增真实宿主验收：Codex 与 Claude 各一次（含 Codeg ACP），覆盖漂移阻断、空提交放行、Worker 申报、Reviewer 核对、Stop 挡一次后续轮 |
| `package.json` | 建议版本 0.5.0，发布另行授权 |

验证：`npm test`、`npm run check`，在原生 Windows 上运行。

## 已知局限

- 门禁和回合结束核对都只认已记录的内容；没发 `task-start`、没记进工作包的工作查不到。
- hook 自身出错（锁超时、读写失败）或宿主未执行 hook 时保守放行，这一次核对不生效，只给出提示。
- 文件级检查不能判断 spec 内容是否正确，这部分依赖 Reviewer。

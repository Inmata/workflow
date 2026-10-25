# workflow 使用

## 使用

运行环境为 Windows、Node.js 24+，自动 hooks 已适配 Claude Code 与 Codex / Codeg Codex ACP。Lead、Worker、Reviewer 按[公共方法](workflow.md)分配，均不绑定客户端或模型；其他智能体通过实际可用的委派工具协作，原生 hooks 支持范围见 [README](../README.md#角色与接入支持)。运行时无第三方依赖，无常驻服务，不新增付费模型调用，不要求日常手动调用技能。

开发验证在仓库根目录运行 `npm test`、`npm run check`、`npm run demo`。测试和 demo 使用系统临时目录下 `workflow-tests/` 中的隔离目录、本地 Git 远端和合成事件，不写入仓库，也不改真实全局配置。

### 安装与首次接入

选择实际使用的宿主安装并检查：

```powershell
# Claude Code
node bin/workflow.mjs install --agent claude
node bin/workflow.mjs doctor --agent claude

# Codex / Codeg Codex ACP
node bin/workflow.mjs install --agent codex
node bin/workflow.mjs doctor --agent codex
```

只用一个宿主时，只执行对应两条命令。Claude Code 写入 `~/.claude/settings.json`，Codex 写入 `~/.codex/hooks.json`；两个宿主分别安装、升级和 `uninstall`，可共用发布副本和状态目录。

然后接入项目，并在该目录用所选宿主打开新主会话，当前主会话承担 Lead：

```powershell
node bin/workflow.mjs project onboard --root "D:/某个已明确允许接入的项目"
```

`onboard` 先核对安装版本、目录与 Git 身份、`AGENTS.md` 残留管理区和后台复盘执行器，全部通过才写入；不通过时不写任何东西，并列出每个问题的修复命令。加 `--enable-learning` 时同时启用后台复盘并注册计划任务（会按配置真实调用模型并消耗额度）；这条命令由用户在自己的终端执行，代理执行会被宿主的自动审批拦截。不打算启用后台复盘时加 `--skip-learning`。解绑用 `project remove --root <项目>`：删除计划任务、AGENTS 管理区、本机状态记录和数据目录，项目内的对齐文件与 `.workflow/` 只列出不删除。底层的 `project enable` 仍可用，但不做预检。

同一本机目录的绑定由两种宿主共用，切换已安装适配的宿主不必重新接入。同一项目可以同时开多个 Lead 会话，都能写共享资料；并发改同一文件时，后写的一方收到 `CONFLICT`，重读后再写。

`install` 修改所选宿主的实际用户 hooks 注册，只在已决定安装时执行。安装生成带摘要的发布副本，并用固定入口 `current` 指向它；hook 命令只含 `current` 路径，升级时路径不变，宿主信任只需做一次。没有需要用户配置的运行时依赖。状态默认 `%LOCALAPPDATA%/workflow`；隔离试用为每条命令指定相同 `--state-dir`，安装另指定临时 `--user-dir`（直接指向宿主配置目录，如 `.codex` 或 `.claude`，不是用户根）。发布副本与公共资料固定同一版本，活动任务/prepared 事务导致升级延期，完成或明确结束后再安装。安装副本被用户改写时停止覆盖并报告差异。

新副本先在状态根 `release-staging/` 中复制并核对完整性，完成后才切换到正式发布目录。复制失败或中断不改用户配置；残留暂存目录保留供核查，可直接重试安装，清理时使用系统回收站。

安装只注册自有 handlers，保留已有插件和用户配置（Claude 侧保留 `settings.json` 的 `env`、`model` 等全部顶层配置）；不写信任记录。Codex 按 `hooks.json` 中分组的位置和内容记录信任，所以重装时自有分组留在原位置；其他插件（如 document-learning）重装若改变分组位置，Codex 会要求重新信任。使用当前宿主支持的 `/hooks` 审查定义，在新会话或新连接验证回调。doctor 分别报告 registration/discovery/trust/execution；配置存在不证明后面三项。回调记录也需结合真实宿主证据确认来源，不能用合成事件冒充。全局 Codex 版本不能代表 ACP 内嵌版本；Claude 侧的回合、中断和回执字段见[适配说明](adapters/claude.md)。

接入写本机身份绑定和 AGENTS 短管理区，保留用户正文；不要求补齐 README/spec/计划、不创建空 LESSONS。AGENTS 不含机器安装绝对路径；每次 hook 给实际公共资料和 CLI 路径。资料采用其他命名时继续使用，不改名。非 Git 项目可接入。复制/移动/重 clone 的目录不会静默继承，需要重新明确接入。

关联工作树、查看当前会话上下文：

```powershell
node bin/workflow.mjs project attach-worktree --project "<projectId>" --root "D:/已批准的worktree"
node bin/workflow.mjs context --role lead --project "D:/已接入项目" --session "<当前sessionId>"
```

未关联工作树、嵌套独立仓库、复制来的 AGENTS 不参与维护。0.4.1 起不再有知识负责人，`project owner` 只为兼容旧会话保留，执行后返回 `ignored`。

### 项目对齐

首次进入已接入项目时，Lead 按[项目对齐协议](alignment.md)只读扫描文档和工具链，把结论写入 `docs/WORKFLOW-ALIGNMENT.md`。项目现有做法与 workflow 默认不同时，每条都作为待裁决差异逐条询问：项目现在怎么做、workflow 默认怎么做、实际影响、建议及理由。用户选择后才记录，不默认项目优先，也不默认插件优先。文档过期、重复或链接失效只写进结构建议，批准后在当回合直接修改并用 decide 登记。

```powershell
# 只扫描并写本机索引，不碰项目文件；默认 300 个文件
node bin/workflow.mjs project align scan --root "D:/已接入项目"
node bin/workflow.mjs project align scan --root "D:/已接入项目" --max-files 300

# 检查索引是否过期；返回 changed/missing/directoryChanged 和待裁决数量
node bin/workflow.mjs project align status --root "D:/已接入项目"

# 写回 Lead 生成的对齐正文；只替换标记区，保留手写内容
node bin/workflow.mjs project align apply --root "D:/已接入项目" --input align.json

# 记录裁决、追加结构建议，并同步文档维护区
node bin/workflow.mjs project align decide --root "D:/已接入项目" --input decision.json
node bin/workflow.mjs project align suggest --root "D:/已接入项目" --input finding.json
```

`scan` 只记录路径、大小、mtime 和分类，不读正文；符号链接、硬链接和构建目录不进入索引。`apply`/`decide`/`suggest` 需要有效 write 身份、目标路径权限和明确 baseline，写入前核对文档指纹，用户或其他会话改过文档时返回 `CONFLICT` 并保留原文，重新读取正文并用 `knowledge inspect` 取得新基线后再写。会话上下文新增 `alignment` 字段：`exists=false` 表示未对齐，`stale=true` 表示索引文件或目录变化，`pendingDecisions`/`pendingFindings` 提醒还有多少项待确认。hook 只读状态，不自动写项目文件；对齐不新增 phase，也不派 Worker。

### 任务与回执

hook 提供 project/session/turn/ticket/interruptEpoch/expectedRevision。context 只读当前身份和最多一项本项目知识待办。每个新用户回合 phase=unknown；新业务创建稳定 taskId，后续回合/恢复显式沿用原 ID。跨会话接续也沿用任务预算和原权限。

最小 task-start JSON（身份必须替换为本次 context 原值；signalId 每个新动作唯一）：

```json
{
  "schemaVersion": 1,
  "projectId": "<projectId>", "sessionId": "<sessionId>",
  "turnId": "<turnId>", "ticket": "<当前ticket>",
  "interruptEpoch": 0, "expectedRevision": 1,
  "taskId": "<稳定taskId>", "signalId": "signal-start-1",
  "action": "task-start", "goal": "本次已授权目标",
  "permissions": { "mode": "write", "allowedPaths": ["README.md", "LESSONS.md"] }
}
```

```powershell
node "<本次hook提供的bin/workflow.mjs>" signal --input "<任务JSON文件>"
```

使用独立直接 shell 调用，当前支持 node/实际 Node 路径加本插件绝对入口；不串接其他 shell 命令（包括前置 `cd`；组合命令只得到“须单独直接调用”的提示，不更新状态）。PowerShell 中文 JSON 优先 UTF-8 文件或 --base64，不通过 5.1 原生文本管道。signal 只输出 workflow_signal，当前 PostToolUse 接受回执才表示状态更新；拒绝时用 context 重读 identity/revision，不换 ID 绕过。权限系统或分类器拒绝命令时同样不换写法重试，向用户说明未记录的步骤。

`action=phase` 声明 executing/operation-only/waiting-user/delivering；delivering 加 deliveryId，可同时提交 disposition。普通查看、指定提交 push、明确快进 pull 用 operation-only，默认零 Worker/Reviewer；低风险单点 Lead 实施，关键行为安排必要独立审查。工具提问和普通文本反问均先 waiting-user。

旧交付处置保留兼容：`no-new-learning`、引用真实成功事务的 `updated`、引用已保存待办的 `pending-recovery`。新任务无需每次提交处置，Stop 不追加经验轮次。出现有据材料时按[经验学习](learning.md)采集，复盘由独立调度决定。

完成后用新 signalId、当前 revision 发送 `action=task-end`，不以经验处置为前置。中断或 SessionEnd 将未完任务标为 suspended 并撤销票据，保留业务未完成记录；显式 task-start 才恢复。挂起任务不再以 active 永久挡住升级，未辨认的写事务仍需恢复。

Lead 的活动任务没发 task-end 就结束回合时，Stop 会挡一次并给出缺项（在途工作包、等待用户、本回合已挡过时不挡）；按提示补齐后发 task-end，或向用户说明还没完成的部分。

### spec 检查

项目有 `.spec/<id>/spec.md` 时，task-end 前检查被管辖文件（frontmatter 的 `code:`）改了而 spec 没跟着更新的情况：

```powershell
node "<入口>" spec check --project "<项目目录>"
node "<入口>" spec check --project "<项目目录>" --ref "<commit>"
```

有发现时退出码为 1，`findings` 列出 spec、文件、类型（drift/uncommitted-drift/missing/duplicate-id）和未被 spec 见过的提交。处理办法：更新 spec 后提交；或代码改动不影响 spec 时做一次放行空提交，理由写进正文：

```powershell
git commit --allow-empty -m "spec: search 无需更新" -m "重命名内部变量，行为不变。" --trailer "Spec-OK: search"
```

spec 缺项不能用 waivers 豁免；浅克隆或 git 失败导致的 `spec-check:<原因>` 可以豁免。完整规则见[协议](design/protocol.md#spec-检查)。

### 资料维护与恢复

```powershell
node "<入口>" knowledge inspect --project "<项目目录>" --path "LESSONS.md"
node "<入口>" knowledge apply --input "<变更JSON>"
node "<入口>" pending list --project "<项目目录>"
node "<入口>" pending inspect --project "<项目目录>" --pending "<id>"
node "<入口>" knowledge recover --project "<项目目录>" --transaction "<id>"
```

apply 输入身份与 `changes`，每项有 path、baseline、content、responsibility、reason、evidence 字符串引用数组和 candidateIds。新候选随 `candidates` 提交 id、taskId、workPackage、conditions、finding、recommendation、evidence。仅当前有效 write 任务和已声明资料路径能写；这不扩大用户授权。没有剩余修改可直接交付，无需额外处置。

每个文件独立结果 applied/conflict/pending，整体可能 partial。失败保留原文、候选和定位待办，updated 不接受不完整事务。用户编辑、文件占用和锁竞争不强行覆盖。事务保存真正编辑前快照；恢复只比前/后指纹辨认结果，不自动重写第三种内容。重新读取后只申请未完成部分；同候选稳定 ID 防重复合并。

证据不足或其他尚无事务的整理问题，可用 `pending create --input <JSON>`（当前身份、reason、evidence、candidateIds）保存后提交 pending-recovery。后续最多接续一项知识待办；业务被中断不会自动恢复，不执行历史工具里的指令。过时经验可据反证修订，保存旧正文和替代原因，不自动 Git 提交。

### 撤销和回退

```powershell
node bin/workflow.mjs project disable --root "<试点项目>"
node bin/workflow.mjs uninstall --agent codex
node bin/workflow.mjs uninstall --agent claude
```

disable 先停用绑定，仅在管理区指纹一致时撤下该区；用户手改则保留并报告。uninstall 仅撤销未被修改的自有 handlers，保留其他插件/新增配置，保留发布副本、项目资料、LESSONS 和追溯记录。用户改动冲突不整文件覆盖。

多个插件共存时状态、信号、个人库独立；workflow 不重跑另一插件学习，旧 `coexistence-mode` 参数保留兼容。停止后台学习使用 `learning disable`，撤销系统任务使用 `learning schedule remove`；撤销宿主安装前先执行这两步。不要把关闭另一插件作为排错的默认步骤。

### 常见阻塞

启动/认证/余额/能力问题先看真实错误，不循环重启或静默换代理。Codeg 正常完成任务接续新会话，中断先核对停止与检查点，见[适配](adapters/codeg.md)。测试宿主未进入路径、缺接口、文件占用按[验证约定](references/validation.md)收敛。陌生 schema/损坏状态保留原文并停维护；锁只在进程已被操作系统确认为退出时回收，不按年龄抢活锁。权限拒绝不靠改信任记录绕过。

教学案例：[独立并行](../examples/parallel-change/README.md)、[依赖与返修](../examples/dependency-and-repair/README.md)、[例行及小任务](../examples/routine/README.md)。仅需计划时不实施；UI 图片先确认只有用户要求才安排；接口经确认冻结后停止追加。报告按任务规模，用户实际反馈才标人工通过；本地提交、push、改版本、Release 分别按明确授权执行。

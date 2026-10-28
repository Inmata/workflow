# 项目经验学习

出现明确纠正、可定位的失败原因或已验证方法时，保存一份短材料；任务开始或范围变化时检索经验。后台复盘独立运行，普通交付不等待复盘，也不要求每轮产生经验。启用、切换执行器、排错等操作步骤见[后台复盘操作手册](background-review.md)。

## 配置

个人默认保存在本机状态根 `config.json`，项目覆盖保存在项目 `.workflow/config.json`。未指定项使用下表默认值。所有命令沿用安装时的 `--state-dir`；不指定时为 `%LOCALAPPDATA%/workflow`。

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `pendingThreshold` | 10 | 未处理材料达到多少份触发 |
| `maxPendingAgeHours` | 24 | 最旧材料达到多少小时也触发 |
| `checkIntervalMinutes` | 15 | 系统定时检查间隔，只查本机状态 |
| `maxRunMinutes` | 30 | 一次模型进程的最长时间，超时终止进程树 |
| `maxBatchItems` | 10 | 单次最多处理多少份 |
| `maxRunsPerDay` | 1 | 单项目每天最多启动多少次模型，失败也计入 |
| `maxInputChars` | 24000 | 本批材料与相关旧知识的 JSON 字符预算 |
| `retrievalLimit` / `retrievalChars` | 5 / 2500 | 默认召回条数和摘要字符预算 |
| `executor` | `codex` | 后台复盘用的 CLI：`codex` 或 `claude`；可按项目分别设置 |
| `model` / `reasoningEffort` / `profile` | `null` | 推荐 Codex 设 `profile` 为专用 profile（如 `workflow-learning`），后台复盘用自己的 provider 和模型；`null` 表示明确选择继承所选 CLI 的主配置。Claude 的 `reasoningEffort` 对应 `--effort`；`profile` 只对 Codex 生效 |
| `executorPath` | `codex` | Codex CLI 命令名或绝对路径 |
| `claudePath` | `claude` | Claude Code CLI 命令名或绝对路径；建议填 `claude.exe` 绝对路径 |
| `claudeSettings` | `null` | 后台复盘专用的 Claude 设置文件绝对路径，Claude 执行器推荐设置；`null` 表示明确选择继承 `~/.claude/settings.json` |
| `timeZone` | 当前系统时区 | 每日额度采用的时区 |

数量与年龄条件满足任一项即可；明确用户纠正或已验证反例可以提前触发，但仍受每日额度、权限与并发限制。当天只有 9 份就结束工作，材料仍在磁盘；第二天新会话和下次检查都能找到。电脑关机或用户未登录时不会运行，恢复后再检查，不承诺固定时刻完成。

在 UTF-8 文件 `learning-config.json` 中写需要修改的字段，例如：

```json
{
  "pendingThreshold": 12,
  "maxPendingAgeHours": 24,
  "checkIntervalMinutes": 30,
  "maxRunMinutes": 60,
  "maxBatchItems": 12,
  "maxRunsPerDay": 2,
  "model": null,
  "reasoningEffort": null,
  "profile": null
}
```

```powershell
node bin/workflow.mjs learning config set --root "D:/项目" --input learning-config.json
node bin/workflow.mjs learning config get --root "D:/项目"
# 修改个人默认：加 --global；项目覆盖仍优先
node bin/workflow.mjs learning config set --global --input learning-config.json
```

`get` 同时返回每项来源。无效值会拒绝，旧配置保留。CLI 修改后同步已登记调度；直接改 JSON 时下次旧间隔检查才同步。运行中的作业沿用启动配置。`model` 填你当前账户或自定义路由支持的模型 ID，`reasoningEffort` 填该模型支持的值；插件不猜测模型可用性。设为 `null` 表示明确选择继承前台配置，插件不复制登录凭据、不新增 API Key；未设专用配置时 `learning doctor` 和 `project onboard` 会给出警告与登记命令。真实调用仍消耗现有账户额度。

### 切换执行器

执行器在每次复盘启动时读取，切换无需重新注册计划任务；正在运行的那次沿用启动时的执行器。两种 CLI 的路径各自保存，来回切换只改 `executor`：

```json
{ "executor": "claude", "claudePath": "C:/Users/<你>/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe", "model": "group/hardworker", "profile": null }
```

两种 CLI 的模型名、effort 取值不一定通用，切换时一并核对。Claude Code 以 `-p --bare --strict-mcp-config --tools "" --no-session-persistence` 运行：设了 `claudeSettings` 时用 `--setting-sources "" --settings <文件>`，只由专用文件决定认证与路由；明确选择继承时用 `--setting-sources user`，读取 `~/.claude/settings.json` 的 `env`（如 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`）。两种方式都跳过 hooks、插件、MCP 与 CLAUDE.md，不提供任何工具，结果经 `--json-schema` 结构化返回。`--bare` 只认 API Key 或 `apiKeyHelper`，不读 OAuth 登录；用订阅登录的账户需改用 API Key 或本地网关。预检不调用模型，运行时再核对初始化事件和 hook 事件，出现工具、MCP 或 hook 回调即不采用结果。

#### Claude 专用模型配置

推荐的默认做法：后台复盘不沿用前台 Claude Code 的网关、密钥和模型，另建一个专用设置文件，例如 `%LOCALAPPDATA%/workflow/claude-learning.json`：

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:3425", "ANTHROPIC_API_KEY": "<密钥>" }, "model": "group/hardworker" }
```

再在个人配置里设 `"claudeSettings": "C:/Users/<你>/AppData/Local/workflow/claude-learning.json"`。设置后执行器改用 `--setting-sources "" --settings <文件>`，不再读 `~/.claude/settings.json`，并去掉宿主进程中 `ANTHROPIC_*`、`CLAUDE_CODE_*` 环境变量，认证、网关、模型只由该文件决定；配置里的 `model` 仍优先于文件中的 `model`。文件含 `hooks`、`enabledPlugins` 或 `mcpServers` 时预检拒绝。密钥只放在这个文件里，不要放进项目 `.workflow/config.json`，也不要提交到 Git。

`maxInputChars` 是材料预算，不是精确 token 或费用上限；提示词、schema、模型输出另有开销。每次运行保存可获取的 `usage`，拿不到记 `null`。没有真实运行证据时不估称节省了多少 token。

## 数据放在哪里

```text
项目根/
  AGENTS.md                       # 原有正文 + 短入口
  .workflow/
    config.json                   # 可共享的项目配置覆盖
    knowledge/
      K-<稳定ID>.md                # 正式知识：结论、范围、证据、修订历史
  docs/WORKFLOW-ALIGNMENT.md       # docs 不存在时放根目录

本机状态根/                        # 不进入项目 Git
  config.json                     # 个人默认，不放凭据
  state.json                      # 本机绑定、任务、权限、事务、即时反例
  current/                        # 当前安装副本的固定入口
  releases/                       # 可恢复的旧安装副本
  migrations/                     # v1 状态原始备份
  transactions/                   # 写前、拟写快照
  projects/<projectId>/
    inbox/<材料ID>.json            # pending / waiting / processed
    runs/<运行ID>.json             # 启动配置、提案、结果、用量
    feedback/                     # shown / adopted，不能当成成功
    knowledge-index.json          # 可重建的检索索引
    work/<运行ID>/                # 隔离执行目录、schema、模型结果
    scheduler.xml                 # 显式注册时才生成
```

知识文件含 JSON 元数据和可读正文。项目配置与正式知识可随 Git 走；原始材料、临时反例和运行记录只在采集的电脑上。换会话不会丢材料，换电脑不会自动同步原始材料。本版本不实现跨电脑合并本机状态，也不自动提交知识变更。

## 会话内采集与检索

1. 先按[任务协议](usage.md#任务与回执)建立任务。新任务或范围变化执行 `knowledge select`，读取相关摘要，必要时再读条目。当前用户要求始终优先。
2. 确有新证据时，在 `task-end` 前执行 `knowledge capture`。材料使用稳定 `id` 和 `incidentId`；同一问题的重复摘要、同一事件的不同会话仍用同一个事件 ID。
3. `saved:true` 表示材料已经写盘。相同 ID、相同正文重试幂等；正文不同报冲突。没有材料就正常结束，无需提交“无新经验”声明。

```powershell
node "<hook 给出的入口>" knowledge select --root "D:/项目" --query "修复登录请求超时" --path "src/login.mjs"
node "<hook 给出的入口>" knowledge explain --root "D:/项目" --query "修复登录请求超时" --path "src/login.mjs"
node "<hook 给出的入口>" knowledge capture --input observation.json
```

采集输入示例，身份取本次 `context.identity`，不得猜测或复制历史票据：

```json
{
  "schemaVersion": 1,
  "projectId": "<当前projectId>", "sessionId": "<当前sessionId>",
  "taskId": "<当前taskId>", "turnId": "<当前turnId>",
  "ticket": "<当前ticket>", "interruptEpoch": 0, "expectedRevision": 1,
  "observation": {
    "id": "login-cancel-1", "incidentId": "login-cancel-incident",
    "kind": "success", "summary": "取消旧登录请求后，迟到响应不再覆盖新结果",
    "conditions": "当前版本的异步登录接口",
    "evidence": ["test:登录取消用例", "commit:<已验证的版本>"],
    "paths": ["src/login.mjs"], "verified": true, "explicit": false,
    "knowledgeId": null
  }
}
```

`id` 使用字母或数字开头、字母数字下划线连字符组成的稳定标识，最多 128 字符，不用 Windows 设备名。`kind` 可为 `correction/failure/success/method/preference`；`legacy` 供旧候选导入。`verified` 只有实际证据支持时才设为 true，`explicit` 只用于用户明确表达。纠正或已验证失败应引用被反驳的 `knowledgeId`，这样旧经验立即停止默认召回，无需等待批量复盘。未能定位旧条目时先检索，不能声称已停用特定知识。任务设置 `permissions.learning=false` 禁止采集。

检索先筛状态、适用路径与版本，再按内容相关度、重要性、成熟度排序。限定版本的知识需传 `--version` 才匹配。检索逐条解析：损坏、权限或路径/链接检查失败的条目跳过并保留诊断，其余有效条目照常召回；写路径仍按严格校验，跳过不构成可写授权。`select` 与 `explain` 是显式查询，返回选中项、全部排除原因和跳过诊断；hook 自动入口只附命中、重要遗漏摘要与总数，排除清单受条数与字符预算，截断时保留总数。知识目录缺失与读取故障给不同降级提示，修复文件后下一次检索会重新解析，不永久缓存失败。这是本地词项匹配，语义召回效果需要试点验证。hook 仅在活动任务上下文变化时重复注入摘要。

`knowledge feedback --input feedback.json` 的公共字段为当前身份、`knowledgeId`、`outcome`。`shown/adopted` 另给事件 `id`，仅记展示或采纳；`success/failure/correction` 另给上述 `observation`，必须有具体证据，不因“用了”就晋升。

## 分级、冲突与手动管理

| 维度 | 值与用途 |
| --- | --- |
| 成熟度 `maturity` | `unverified` 待验证；`verified` 有可核对成功；`stable` 至少 3 个有成功证据的独立事件、跨 2 个日期，且没有未解决反例 |
| 重要性 `importance` | `normal/important/critical`，用于相关条目的排序，不等于真实性 |
| 状态 `status` | `active/disputed/superseded/retired`，后三种不默认召回 |
| 范围 `scope` | 相对路径、版本及正文中的适用条件；不同场景可同时成立 |
| 类型 `type` | `method/fact/preference`；偏好需要用户明确表达，不套成功次数门槛 |

模型提出整理方案，程序核对范围、材料归属和证据门槛。数量只能作为门槛，事件是否独立、证据是否可信仍需采集者与复盘判断。旧结论被反例推翻时可以修订、降级或替代；即使用户曾提高重要性也允许有证据的降级，保留原因和旧记录，并在下次 Lead 入口提示一次。改了结论、条件或类型会重置该结论的证据代际，旧成功不能直接晋升新结论。

手动提高重要性：先 `knowledge inspect` 获取当前指纹，在业务任务结束后执行 `knowledge revise`：

```powershell
node bin/workflow.mjs knowledge inspect --root "D:/项目" --path ".workflow/knowledge/K-login-cancel-1.md"
node bin/workflow.mjs knowledge revise --root "D:/项目" --input revision.json
```

```json
{"id":"K-login-cancel-1","baseline":"<inspect 返回的 fingerprint>","importance":"critical","reason":"用户要求优先考虑此项"}
```

`revise` 也可设置 `status` 为 `active/disputed/retired`，但不会清除即时反例或提高成熟度。结论修订走带证据的采集与复盘。避免只编辑可读正文而不更新元数据；两者不一致时检索停止并报错，保留原文供核对。

## 启用与运行

首次试点按照[另一台电脑验收清单](acceptance.md)进行。安装和项目接入不会自动授权后台维护。显式启用后才授予 `.workflow/knowledge/` 写入权限。项目接入后 Lead 会在会话入口收到提示，经用户同意后请用户在终端执行 `project onboard --root <项目> --enable-learning`，一次完成启用与注册（代理执行会被宿主的自动审批拦截）。也可以用下面的分步命令；用户不需要时执行 `learning disable` 记下决定，提示不再出现：

```powershell
node bin/workflow.mjs learning doctor --root "D:/项目"
node bin/workflow.mjs learning enable --root "D:/项目"
node bin/workflow.mjs learning status --root "D:/项目"
node bin/workflow.mjs learning schedule preview --root "D:/项目"
node bin/workflow.mjs learning schedule install --root "D:/项目"
```

Windows 计划任务只在当前用户登录时运行，无常驻插件服务。定时检查本身不调用模型；达到条件、没有活动业务任务或只读/计划会话、没有未恢复作业且额度足够才启动。所有项目共用一个复盘锁，单项目每日限额分别计算。

任务经 `conhost.exe --headless` 直接启动 Node（需 Windows 10 1809+），运行时不弹终端窗口、不抢焦点，也不受 PowerShell 执行策略限制。登录触发器限定为当前用户；不限定时 Windows 视为“任意用户登录”，普通权限注册会报拒绝访问。0.3.0 及更早版本登记的任务经 PowerShell 脚本启动，在执行策略为 `Restricted` 的电脑上根本不会运行；0.3.0 的登录触发器也未限定用户，注册会失败。升级后请重新执行一次 `learning schedule install`。旧任务若能正常运行，也会在下一次定时检查时自动按新定义重新注册。

执行器为 Codex CLI 或 Claude Code（见[切换执行器](#切换执行器)），前台宿主可以是任一种。执行器继承原有认证与路由，前置检查禁用 hooks、MCP、工具、联网搜索与递归代理；无法核实隔离时停止。分析在项目外临时目录中进行，只收结构化提案。正式文件由程序核对指纹、保存快照后写入；模型没有直接改项目的职责。`doctor` 只检查能力，不能证明真实模型、额度或认证可用。

```powershell
# 这条会真实调用模型；--now 仅跳过数量/年龄门槛，不绕过每日限额
node bin/workflow.mjs learning review --root "D:/项目" --now
# 崩溃后恢复已保存提案，不再次调用模型
node bin/workflow.mjs learning recover --root "D:/项目" --run "<运行ID>"
# 查看通知历史，按需确认
node bin/workflow.mjs learning acknowledge --root "D:/项目"
```

超时、模型失败、结果不完整不消费原始材料。写后崩溃以指纹恢复，未完成批次的知识暂不召回。与用户新编辑冲突时保留原文和提案，不自动覆盖；先人工核对冲突再恢复。等待更多证据的材料标为 `waiting`，相同知识 ID 或适用条件出现新材料后重新进入队列，避免每天重读同一材料。

停用或撤销：先 `learning disable` 停止维护，再 `learning schedule remove` 移除自有计划任务，最后按需撤销宿主安装。本机材料、正式知识、旧副本和迁移备份均保留。回退旧代码前恢复匹配的 v1 状态备份，不能让旧程序直接写 v2 状态。

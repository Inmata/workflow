# 后台复盘操作手册

后台复盘把会话里采集的经验材料批量整理成项目知识，由 Windows 计划任务定时检查、按条件调用模型。本手册只讲怎么操作；配置项含义、数据结构和分级规则见[项目经验学习](learning.md)。

下文命令以 `node bin/workflow.mjs` 表示，在会话中改用 hook 给出的入口。每条命令都要带同一个 `--root "<项目>"`；安装时用过 `--state-dir` 的，这里也要一样带上。

## 1. 首次启用

1. 按需调整额度，选执行器并写好模型配置，见[第 2 节](#2-配置额度执行器与模型)。
2. 只做检查，不调用模型：

   ```powershell
   node bin/workflow.mjs learning doctor --root "D:/项目"
   node bin/workflow.mjs learning schedule preview --root "D:/项目"
   ```

   `doctor` 应返回 `capabilities-verified`，并显示实际使用的 `executor`、`model`、`profile` 或 `claudeSettings`。
3. 启用并注册计划任务：

   ```powershell
   node bin/workflow.mjs learning enable --root "D:/项目"
   node bin/workflow.mjs learning schedule install --root "D:/项目"
   node bin/workflow.mjs learning status --root "D:/项目"
   ```

   `install` 返回 `registered` 和任务名 `workflow-learning-<编号>`，可在“任务计划程序”里找到。
4. 可选：材料落盘后立即真实跑一次，确认模型能调通：

   ```powershell
   node bin/workflow.mjs learning review --root "D:/项目" --now
   ```

项目接入后，Lead 会在会话入口提示你做第 3 步。不需要后台复盘时执行 `learning disable`，提示不再出现。

## 2. 配置：额度、执行器与模型

配置分两层：个人默认在 `<状态根>/config.json`（默认 `%LOCALAPPDATA%/workflow/config.json`），项目覆盖在项目的 `.workflow/config.json`，项目层优先。

### 用命令修改

只写要改的字段，没写的保持原值。在 PowerShell 里可以直接把 JSON 用管道传进去：

```powershell
# 个人默认（所有项目）
'{"maxRunsPerDay":2,"maxBatchItems":15}' | node "$env:LOCALAPPDATA/workflow/current/bin/workflow.mjs" learning config set --global
# 只改某个项目
'{"maxRunsPerDay":3}' | node "$env:LOCALAPPDATA/workflow/current/bin/workflow.mjs" learning config set --root "D:/项目"
# 查看最终值和每项来源
node "$env:LOCALAPPDATA/workflow/current/bin/workflow.mjs" learning config get --root "D:/项目"
```

这些配置命令可以用管道和变量；`signal` 不行，它必须是一条单独的直接调用，格式以会话入口给出的 `signal.command` 为准。

字段多时也可以写进 UTF-8 文件，用 `--input learning-config.json` 传入。`get` 的 `values` 是最终生效值，`sources` 标明每项来自 `project`（项目）、`personal`（个人）还是 `default`（内置默认）。

- 取值会先校验，超出范围直接拒绝，原配置不变。
- 已注册计划任务的项目，`set` 后会按新间隔自动重新注册。直接手改 JSON 也可以，下次复盘就读新值，只是检查间隔要等下一次旧间隔检查才同步。
- 恢复默认：`model`、`profile`、`reasoningEffort`、`claudeSettings` 设为 `null` 表示明确选择继承前台 CLI 配置（不推荐，`learning doctor` 会给出警告）；数字字段不能设 `null`，填回默认值。
- 安装副本版本较旧时，新字段（如 `executor`、`claudeSettings`）会被当成未知配置项拒绝，先重新执行 `install`。

### 额度与频率

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `maxRunsPerDay` | 1 | 每个项目每天最多调用几次复盘模型，失败也计入 |
| `maxCaptureRunsPerDay` | 1 | 每个项目每天最多启动几次会话候选提取；与复盘额度分开，已开始作业的重试只受尝试次数约束 |
| `maxBatchItems` | 10 | 一次最多处理几份材料 |
| `pendingThreshold` | 10 | 攒到几份材料触发 |
| `maxPendingAgeHours` | 24 | 最旧材料放了多少小时也触发 |
| `checkIntervalMinutes` | 15 | 计划任务多久检查一次（检查本身不调用模型） |
| `maxRunMinutes` | 30 | 单次复盘最长时间，超时终止 |
| `maxInputChars` | 24000 | 每批材料的字符预算 |

完整取值范围见[配置](learning.md#配置)。

密钥和网关地址只放在个人配置或 CLI 自己的配置文件里，不要写进项目 `.workflow/config.json`，后者会随 Git 提交。

### Codex CLI

```json
{ "executor": "codex", "executorPath": "C:/.../codex.exe", "profile": "workflow-learning", "model": "group/hardworker" }
```

`profile` 指向 `~/.codex/<名称>.config.toml`，用来给复盘单独指定 provider 和模型，例如：

```toml
# ~/.codex/workflow-learning.config.toml
model_provider = "magpie"
model = "group/hardworker"
```

profile 叠加在 `~/.codex/config.toml` 之上：provider 的地址和认证在主配置的 `[model_providers.<名称>]` 中定义，profile 里没写的项沿用主配置。主配置中的 MCP、插件和 hooks 由预检逐项关闭，不会进入复盘。如果希望后台和前台完全独立，在主配置中另定义一个专用 provider，让 profile 引用它。

### Claude Code

```json
{ "executor": "claude", "claudePath": "C:/Users/<你>/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe", "claudeSettings": "C:/Users/<你>/AppData/Local/workflow/claude-learning.json", "model": "group/hardworker" }
```

`claudePath` 建议填 `claude.exe` 的绝对路径；填命令名时会经 PowerShell 转启动。

`claudeSettings` 指向复盘专用的设置文件：

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:3425", "ANTHROPIC_API_KEY": "<密钥>" }, "model": "group/hardworker" }
```

- 设了 `claudeSettings`：不读 `~/.claude/settings.json`，也不继承宿主进程的 `ANTHROPIC_*`、`CLAUDE_CODE_*` 变量，网关、密钥和模型只由这个文件决定。文件里不能有 `hooks`、`enabledPlugins`、`mcpServers`。
- 设为 `null`：明确选择继承 `~/.claude/settings.json` 的 `env`，和前台 Claude Code 用同一套认证与路由。不推荐，`learning doctor` 会给出警告。
- Claude 执行器以 `--bare` 运行，只认 API Key 或 `apiKeyHelper`，不读订阅登录（OAuth）。订阅账户需改用 API Key 或本地网关。

学习配置里的 `model` 和 `reasoningEffort` 优先于 CLI 配置；设为 `null` 时沿用 profile 或设置文件里的值。Claude 的 `reasoningEffort` 对应 `--effort`，`profile` 只对 Codex 生效。

### 切换执行器

执行器在每次复盘启动时读取，切换只需改 `executor` 并写入配置，不用重新注册计划任务。两种 CLI 的路径和专用配置各自保存，可以来回切换。切换后：

1. 执行 `learning doctor`，确认返回的 `executor` 和模型是你要的。
2. 核对模型名和 effort 取值，两种 CLI 不一定通用。
3. 正在运行的那次复盘沿用启动时的执行器。

## 3. 日常查看

```powershell
node bin/workflow.mjs learning status --root "D:/项目"
```

关注这些字段：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 是否已启用 |
| `materials` | 材料总数与 `pending/waiting/processed`；顶层 `pending/waiting` 仍保留 |
| `due` | 当前是否满足触发条件：`count`（数量）、`age`（年龄）、`counterevidence`（明确纠正或已验证失败），不满足为 `null` |
| `limits` | 复盘与提取各自的当日启动数和额度，两者分开 |
| `evidence` | 按 `success/failure/correction` 统计的材料数，展示次数不计入 |
| `feedback` | `shown/adopted/total`；没有记录时 `note` 写“无记录”，不推断效果为零 |
| `runs` / `runSummary` | 最近 10 次运行的状态、时间、`usage`、失败原因，以及 `partial` 运行每项被拒决定的材料、代码和说明；`unhandled` 是模型未处置、仍待下次复盘的材料 |
| `knowledge` | 知识总数、活跃数、创建/修订/已替代次数；读取失败时 `available:false` 并给错误码 |
| `capture` | task-end 提取作业的总数、各状态、当日启动数、`usage`、被拒候选数和最近作业；当日启动数按项目累计（`todayStartedScope: project`），不随查询过滤缩小；`skippedFiles` 是损坏的作业文件数 |
| `scope` | 材料、反馈和提取作业的过滤范围；复盘运行与知识文件按项目统计并标注 `project`，不与过滤结果混算；指定会话时 `unattributed` 标明任务级或未知归属的计数 |
| `at` | 本报告的统计时点 |
| `notices` | 给 Lead 的通知，例如有知识被降级 |

材料、反馈和提取作业可用 `learning status --root "D:/项目" --session <sessionId> --task <taskId>` 按会话/任务过滤；不传时是项目范围。指定会话时只统计带同一 `sessionId` 的记录，同任务其他会话不混入；缺少 `sessionId` 的记录单列在 `unattributed.taskLevel/unknown`，不计入会话结果。`limits` 与 `capture.todayStarted` 按项目实际累计并标注 `project`。`knowledge select` 只是查询，不算 `adopted`。

task-end 被接受后，已启用学习的项目会登记一次幂等的候选提取作业。它使用宿主 transcript 中用户与助手的短文本，剔除工具输出；只接受绝对路径普通文件，拒绝相对路径、符号链接和真实路径不一致；Claude 消息必须逐条带当前 `sessionId`，Codex 必须有匹配的 `session_meta`。读取失败、格式错误、身份不足、超时或无效输出只影响该作业（`skipped`/`failed`/`timeout`），不阻塞任务结束，也不会直接产生正式知识。同一任务结束重放、Stop 或普通 Hook 不会重复登记。自动候选引用已有 `knowledgeId` 时，只有明确纠正或已验证失败才与人工采集一样登记反例；候选仍会唤醒同知识或同条件的 `waiting` 材料，引用不存在的知识则会被拒绝。完成、跳过与用量在 `capture` 中单独展示。

确认通知：`learning acknowledge --root "D:/项目"`。

每次运行的完整记录在 `<状态根>/projects/<projectId>/runs/<运行ID>.json`，包含启动时的配置、提案和结果。

## 4. 手动运行与恢复

```powershell
# 真实调用模型；--now 只跳过数量和年龄门槛，不绕过每日限额和并发锁
node bin/workflow.mjs learning review --root "D:/项目" --now
# 有完整提案的中断运行，按保存的提案恢复，不再调用模型
node bin/workflow.mjs learning recover --root "D:/项目" --run "<运行ID>"
# 内容冲突时选择保留提案（核对后仍可手动 recover）或作废并重新排队材料（仅限本运行尚未写入知识）
node bin/workflow.mjs learning resolve --root "D:/项目" --run "<运行ID>" --keep
node bin/workflow.mjs learning resolve --root "D:/项目" --run "<运行ID>" --discard
```

`review` 可能返回的状态：

| 状态 | 含义与处理 |
| --- | --- |
| `completed` | 已写入知识，材料标为已处理 |
| `partial` | 部分决定无效：合法决定与材料已在同一事务提交，被拒决定的材料保持 `pending` 并记录原因；这是终态，`recover` 只返回原状态，不会重复消费 |
| `not-due` | 未达到触发条件；需要立即跑就加 `--now` |
| `daily-limit` | 今天的复盘额度已用完，第二天自动继续；也可调大 `maxRunsPerDay` |
| `no-fit` | 没有材料，或单份材料超出 `maxInputChars` |
| `timeout` | 超过 `maxRunMinutes` 被终止；材料保留，占用当日额度 |
| `failed` | 模型失败、结果无效或全部决定都无效，`reason` 说明原因；材料保留。全部决定无效时不写任何知识 |
| `deferred` | 业务任务、只读会话或复盘锁竞争导致暂缓；提案已保存，条件允许后由下次检查先重试提交，不再调用模型 |
| `conflict` | 提案与人工编辑冲突，未覆盖任何文件；用 `learning resolve --keep` 保留，或在本运行的知识文件均未偏离写入前快照时用 `--discard` 作废 |
| `kept` | 已选择保留冲突提案；核对后用 `learning recover` 手动应用，处理前不自动重试 |
| `recovery` | 写入事务未完整结束；提案保留，按既有事务恢复语义处理，不会把未完成事务当成 pending |
| `recovery-required` | 有未完成的运行需要辨认；有提案的会在条件允许时自动接续，其余用 `learning recover` 处理 |

错误码 `BUSY` 表示项目还有活动的业务任务，等业务结束后再跑。`LOCKED` 表示另一个复盘正在运行，所有项目共用一个复盘锁。这两类短延期不推进正常检查周期，也不会再次调用模型：计划任务仍按 `checkIntervalMinutes` 触发，下一次触发（或手动/其他 tick）一定会先补提交已保存的提案；`nextCheckAt` 只是给 tick 判断用的有界退避，不会自行在 30 秒后重试。

复盘按决定逐项校验。合法决定在同一事务中提交；非法决定只留下自身原因，材料保持 `pending` 并写入 `lastRejected`（运行 ID、代码、说明），可原样重试，不影响同批其他决定。同一材料被多项决定引用、跨批引用或同一知识被多项决定修改时，提交图无法安全确定，相关决定会以 `DUPLICATE`/`CONFLICT`/`RESULT` 保守拒绝。改变旧结论、降级、替代、偏好证据和范围校验的门槛没有放宽。模型完全没处置的材料不算拒绝，仍留在 `pending`，运行记录的 `unhandled` 会列出它们。

内容冲突不会反复按旧 baseline 自动提交。`--keep` 保留提案和待写隔离，人工核对冲突后可再执行 `learning recover`。`--discard` 仅在本运行的知识文件均未偏离写入前快照时可用：作废旧提案、撤销本批隔离，并把本运行已标记的材料恢复为待处理，人工编辑不被覆盖，下一次新模型调用仍按正常额度计算。若任一知识文件已偏离写入前快照（例如替代提案只写入了新知识、写入后又被人工编辑，或原有文件被删除），作废会留下新旧知识并存且材料仍待处理，因此会被拒绝；此时先 `--keep` 保留提案，人工核对后用 `learning recover` 完成，或按事务快照还原后再作废。

## 5. 计划任务管理

```powershell
node bin/workflow.mjs learning schedule preview --root "D:/项目"   # 查看将注册的 XML 和命令，不注册
node bin/workflow.mjs learning schedule install --root "D:/项目"   # 注册或按新定义覆盖
node bin/workflow.mjs learning schedule remove --root "D:/项目"    # 只删除本插件登记的任务
```

- 任务只在当前用户登录时运行，经 `conhost.exe --headless` 启动 Node，不弹窗口。电脑关机或未登录时不运行，恢复后再检查。
- 定时检查本身不调用模型，只有达到条件、没有活动业务任务、额度足够时才启动复盘。
- 锁竞争、业务任务或只读会话造成的延期不推进正常检查周期：计划任务仍按 `checkIntervalMinutes` 触发，下一次触发（或手动/其他 tick）会先补提交已保存的提案，不重新调用模型。`nextCheckAt` 只是有界退避，供 tick 判断，不是自动定时重试。
- 用 `learning config set` 修改 `checkIntervalMinutes` 等配置时，会同步更新已注册的任务。直接手改 JSON 的，要等下一次检查才同步，或手动再执行一次 `install`。
- 升级插件后，旧定义的任务会在下一次检查时自动按新定义重新注册。0.3.0 及更早版本注册的任务可能根本不会运行，升级后请手动执行一次 `install`。

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `schedule install` 报“拒绝访问” | 旧版本的登录触发器没有限定当前用户，升级后重新 `install` |
| 计划任务从不运行 | 0.3.0 及更早版本经 PowerShell 脚本启动，执行策略为 `Restricted` 时不会运行；升级后重新 `install` |
| `doctor` 报 `EXECUTOR` | `executorPath` 或 `claudePath` 指错了程序，例如把 codex 路径填给了 Claude |
| `doctor` 报 `ISOLATION` | CLI 版本缺少隔离所需能力，或 `claudeSettings` 文件里有 hooks、插件、MCP |
| `doctor` 报 `CONFIG` | `claudeSettings` 不是绝对路径、文件不存在或不是有效 JSON |
| `doctor` 通过但复盘 `failed` | `doctor` 不调用模型，不能证明认证和额度可用；看 `runs` 里的 `reason`，并单独验证网关和密钥 |
| 复盘一直 `timeout` | 网关不可达或模型太慢；先检查网关地址，再考虑调大 `maxRunMinutes` |
| Claude 复盘报认证失败 | `--bare` 不读 OAuth 登录，在设置文件里改用 `ANTHROPIC_API_KEY` |

不要删除 inbox、state 或快照来“修好”状态，也不要手动改运行记录。

## 7. 停用与撤销

```powershell
node bin/workflow.mjs learning disable --root "D:/项目"           # 停止后台维护
node bin/workflow.mjs learning schedule remove --root "D:/项目"   # 删除计划任务
```

撤销宿主安装前先做这两步。本机材料、正式知识、旧安装副本和迁移备份都会保留，重新 `enable` 和 `install` 即可恢复。

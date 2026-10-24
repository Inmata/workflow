# 项目对齐

项目对齐把 workflow 的默认方法与项目已有的文档、约定和工具链放到同一张表里：哪些资料权威、哪些做法不同、哪些差异需要用户裁决、哪些文档结构该改。结论写入项目内的 `docs/WORKFLOW-ALIGNMENT.md`，而不是只留在聊天里。

对齐只在 Lead 首次进入项目时做一次；之后会话开始和每个用户回合只检查索引是否过期，不重复全量阅读。插件负责确定性部分（文件清单、大小、mtime、指纹、命令入口），Lead 负责语义部分（哪份文档权威、什么算冲突、结构问题怎么改）。

## Lead 提示词（v2）

把下面内容放进项目 `AGENTS.md` 正文，或由 Lead 在首次会话按此执行。它与 CLI 的 `project align` 命令配合使用，不依赖命令也能工作。

```text
## 项目对齐（每次会话开始先做）

目标：让 workflow 方法与项目已有文档和约定对齐，结果持久化，
分歧逐条与我确认，不擅自按任何一方执行。

### 1. 读取已有对齐文件
读 `docs/WORKFLOW-ALIGNMENT.md`（没有则项目根 `WORKFLOW-ALIGNMENT.md`）。
- 不存在 → 跳到第 2 步。
- 存在 → 执行第 1.1 步的变更检查，然后直接按文件执行，不重新全量扫描。

#### 1.1 变更检查（只 stat，不读正文）
对齐文件"对齐依据"段记录了已扫描文件的路径、大小、mtime。
逐个 stat 这些文件，比较大小和 mtime：
- 全部一致 → 直接复用，跳过第 2 步。
- 有变化 / 文件消失 → 只重读变化的文件和新增的索引类文档，更新对齐文件。
- 用户明确要求重新对齐 → 全量扫描。
不要因为一个文件变化就重扫整个 docs。

### 2. 首次对齐（只读分析 + 只写对齐文件）

读取上限：最多 15 个文件、总计 3000 行。按优先级，够了就停：
1. 根 AGENTS.md 正文、CLAUDE.md
2. README.md、CONTRIBUTING.md
3. docs/ 下的索引类文档（README/ARCHITECTURE/PRODUCT/CONVENTIONS/DESIGN），
   先看文件名和一级标题再决定读哪几篇
4. 工具链：package.json scripts、根目录和 scripts/ 下的 *.ps1/*.sh、
   Makefile、pyproject.toml、Cargo.toml、go.mod

禁止读取：node_modules、.git、build/dist/obj/bin、缓存、
docs/plans 或 docs/archive 下的历史计划（当前任务直接相关除外）。

### 3. 写入 docs/WORKFLOW-ALIGNMENT.md

固定结构：

# 项目对齐
## 对齐依据
- 生成时间、已扫描文件清单（路径、大小、mtime）、未找到的预期资料
## 文档索引
| 资料 | 职责 | 何时必读 |
## 全量文档清单
| 路径 | 分类（产品/使用/发布/计划/归档）| 是否已读 |
（未读的也要列出，标注"存在但未读，按需查阅"）
## 验收入口
| 用途 | 命令 | 环境要求 |
## 目录与命名
## 术语
## 待裁决差异
| ID | 项目现行做法 | workflow 默认 | 影响 | 我的建议 | 状态 |
（状态：pending / accepted-project / accepted-workflow / accepted-change / rejected）
## 结构建议
| ID | 问题 | 位置 | 建议改法 | 状态 |
（状态：pending / accepted-change / rejected）
## 已裁决记录
- 日期、ID、双方理由、决定、复核条件

### 4. 冲突处理（必须逐条询问）
发现项目做法与 workflow 默认不同，一律写成"待裁决差异"，
不要自行选择任何一方，也不要默默按项目优先。

按[提问路径](workflow.md#提问路径)询问我（宿主结构化提问可用时优先，
否则 Codeg MCP ask_user_question，再否则文本编号问题），每次最多 4 条，每条给出：
- 项目现在怎么做（引用文件位置）
- workflow 默认怎么做
- 两种做法的实际影响
- 你的建议及理由

我选择后，用 `project align decide` 登记（它同时更新表格状态和"已裁决记录"），不要手改表格里的状态列。
待裁决项已保存在表格里，可以跨回合回答：本回合没问完或我没回答，
下一回合继续问或 decide，不要求一个回合内处理完。
计划模式下只扫描、提问和起草，不写文件；回到可写模式后再 apply/decide。Codex 的 Plan 协作模式不在 hook 中报 plan，插件按活动任务声明的 `permissions.mode=plan` 提示，Lead 须如实声明。
后续会话不再重复询问已裁决项，除非我要求复核。

注意：项目原有做法未必更好。如果证据表明项目做法已经过时
（例如文档写的版本号与代码常量不一致），在建议里明确指出，
但仍由我决定是否改项目。

### 5. 结构建议（只报告，不改）
发现文档过期、重复、职责重叠、缺索引、链接失效时，
写进"结构建议"，不要直接修改、重命名或移动任何文件。
我批准后，在当回合建立包含相应路径的 write 任务直接执行修改，完成后用 decide 把状态登记为 accepted-change（拒绝为 rejected）；我没批准的不动。结构建议不能用 accepted-project / accepted-workflow，decide 会拒绝并列出合法值。

### 6. 写作规则
- 只写能从文件确认的事实；找不到写「未找到」，不推断。
- 只写这一个对齐文件；不创建空文档，不改其他文件。
- 文件已存在时保留用户手写内容，只更新你自己维护的段落。
- 不写机器绝对路径、凭据、个人目录。

### 7. 完成后
- 聊天里只回 5 行以内摘要 + 文件路径 + 待裁决条目数，并写明后台复盘现状（入口上下文已给出：已启用及计划任务名，或待用户在终端执行的命令）。
- 所有用户可见文字用简体中文，包括进度说明和思考摘要。
- 不派 Worker，不进入实施。
```

## 确定性命令

`scan` 只扫描并写本机状态，不碰项目文件；`status` 只 stat 索引文件；`apply`、`decide`、`suggest` 才写对齐文档。

```powershell
# 首次或用户要求全量重扫
node bin/workflow.mjs project align scan --root "D:/项目"
node bin/workflow.mjs project align scan --root "D:/项目" --max-files 300

# 新会话检查是否过期；同时返回待裁决/待处理数量
node bin/workflow.mjs project align status --root "D:/项目"

# 写入 Lead 生成的对齐正文
node bin/workflow.mjs project align apply --root "D:/项目" --input align.json

# 记录一条或多条裁决
node bin/workflow.mjs project align decide --root "D:/项目" --input decision.json

# 追加结构建议
node bin/workflow.mjs project align suggest --root "D:/项目" --input finding.json
```

输入示例：

```json
{
  "content": "# 项目对齐\n## 对齐依据\n...",
  "decisions": [{ "id": "D1", "status": "accepted-project", "reason": "项目已有约定" }],
  "findings": [{ "id": "F1", "problem": "版本号陈旧", "location": "CONTRIBUTING.md", "recommendation": "与代码常量对齐" }]
}
```

以上只展示业务字段。三个写命令还必须带[当前身份](usage.md#任务与回执)和明确的 `baseline`：用 `knowledge inspect --path <对齐文件>` 获取编辑前指纹，不存在时传 `null`。先声明包含对齐文件路径的 write 任务；同一项目的任何 Lead 会话都可写，计划或只读任务不能写对齐文件。写入共用快照、指纹检查与事务恢复：别的会话或用户先改过文档时返回 `CONFLICT`，重新 inspect 取新指纹后再写。首次没有索引时补只读扫描。

`apply` 写进表格但从未登记的行：状态为 `pending` 的自动登记为待裁决（等同于 suggest），返回结果的 `registered` 列出这些 ID；已写成其他状态的行拒绝写入并给出 decide 命令，因为裁决必须经 decide 留痕。

扫描规则：

- 收集 `*.md`、`*.txt`、`*.rst`、`*.adoc`，以及 `package.json`、`Makefile`、`*.ps1`、`*.sh`、`pyproject.toml`、`Cargo.toml`、`go.mod`。
- 排除 `.git`、`node_modules`、`bin`、`obj`、`dist`、`build`、`work`、`release-staging`、`coverage`、`target`、缓存和临时目录。
- 每个文件只记录 `size` 与 `mtimeMs`，不读正文；默认上限 300 个文件，`--max-files` 最大 300。
- 分类为 `product`、`usage`、`release`、`plan`、`archive`、`other`。分类只用于索引，不决定权威性。
- 符号链接、硬链接和目录逃逸不进入索引，在 `skipped` 中报告原因。
- 对齐文档自身不进入索引，避免写回后把自己判成过期。

## 文档维护区

`docs/WORKFLOW-ALIGNMENT.md` 中只有下面标记区由命令维护，标记外的用户手写内容逐字保留：

```markdown
<!-- workflow-alignment:begin -->
（Lead 生成的对齐正文）
<!-- workflow-alignment:end -->
```

`decide` 和 `suggest` 按标题定位小节；同一 ID 原位替换，不重复追加。`decide` 同时更新待裁决表状态，已裁决项不会继续计为 pending。写入前核对明确基线；用户或另一个会话改过文档时保留原文，重新读取后带新基线提交。

## 会话上下文

hook 在 SessionStart 和 UserPromptSubmit 返回的 context 中包含：

```json
"alignment": {
  "path": "docs/WORKFLOW-ALIGNMENT.md",
  "exists": true,
  "docExists": true,
  "stale": false,
  "changed": [],
  "missing": [],
  "directoryChanged": [],
  "pendingDecisions": 2,
  "pendingFindings": 1,
  "mismatch": []
}
```

Lead 还会得到 `alignmentGuide` 路径。`exists=false` 表示尚未对齐；`stale=true` 表示索引中的文件大小、mtime 或所在目录变化，需要只重读变化文件和新增资料；待裁决数量提醒 Lead 不要遗忘未决差异。`pendingDecisions`/`pendingFindings` 以对齐文档中的表格为准（Lead 直接写表格也算），再与本机索引状态合并，因此绕过 `decide`/`suggest` 也不会漏掉待办。`mismatch` 列出表格状态与 decide 登记值不一致的行（`document` 是表格里的值，`index` 是登记值，`invalid: true` 表示表格里的值不是合法状态），多半是手改了表格：按用户的裁决重新 decide，decide 会把表格状态纠正为登记值。目录 mtime 变化时会重新列目录，只有出现未收录的候选资料（文档、脚本、工具链文件）才计入 `directoryChanged`；新增图片等其他文件或目录被删除不算。旧项目没有索引字段时按未对齐处理，不报错。hook 只读状态和对齐文档，不自动写项目文件。

## 边界

- 不新增 phase，不改 signal schema；只读扫描是准备工作，写对齐文件必须建立有相应路径权限的任务。
- 不派 Worker；结构建议只有用户批准后才执行，批准后在当回合直接修改并用 decide 登记。
- 项目原有做法不自动服从，也不自动推翻；每条真实差异都要用户裁决并留痕。
- 不读构建产物、缓存和历史计划正文；未读文件仍列入全量清单并标注"存在但未读"。
- 索引只保存 ID、状态和裁决时间；理由与建议正文以项目内文档为权威。

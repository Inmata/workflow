---
title: 安装与项目接入
status: active
desc: 分别安装宿主并接入项目；核心检查通过后才预检执行器，生成命令按字面值传参
code:
  - src/onboard.mjs
  - src/projects.mjs
  - src/install.mjs
  - src/entry.mjs
  - src/learning-config.mjs
  - src/runner.mjs
related:
  - docs/usage.md
  - docs/learning.md
---
# 安装与项目接入

## 目标

- `install --agent codex|claude` 与 `project onboard --root <目录>` 分别显式执行：安装只登记宿主 hooks，接入只绑定项目并写 AGENTS 管理区。
- `project onboard` 先核对核心接入（宿主安装与版本、目录与 Git 身份、AGENTS 残留管理区）；全部通过才写入，不通过时返回 `status: blocked`、`written: false`，一次列出全部问题及修复命令。
- 核心检查未通过时不读取也不执行个人 `config.json` 或项目 `.workflow/config.json` 指定的执行器；学习报告为 `status: not-run`、`reason: core-blocked`。加 `--skip-learning` 时仍为 `status: skipped`。
- 核心检查通过且未加 `--skip-learning` 时才运行执行器能力预检（不调用模型）。执行器与各执行器路径可在个人配置和项目配置中设置，项目值覆盖个人值。
- 正常接入、重复接入、显式 `--enable-learning` 和 `--skip-learning` 维持既有语义：重复接入保留已有学习开关、计划任务和对齐裁决；显式请求学习而未完整生效时返回 `status: partial`，CLI 退出码为 1。
- 给用户或代理的 CLI 命令由 `command()` 生成，可直接粘贴到 Windows PowerShell 5.1 或 PowerShell 7；入口路径和特殊参数使用单引号字面量，空格、单引号、`$`、反引号、分号和 `$(...)` 按原值传入 CLI。5.1 无法原样传递的双引号与空参数改用 `workflow-arg64:` 编码标记，并由生成命令追加 `--workflow-arg64-transport` 开关；CLI 只在带开关时还原，直接手写的同名文本保持字面值。

## 原因

- 旧顺序在汇总核心问题并返回 `blocked` 之前就运行学习预检，项目配置里的 `executorPath` 会在核心接入未获批的情况下被执行。
- 旧命令生成用可展开的双引号包裹特殊参数，`$(...)` 会被 PowerShell 当作子表达式解释。
- context 的 signalUsage 也曾用双引号拼接入口路径；安装路径含 `$HOME` 或 `$(...)` 时，用户照抄提示就会触发展开或执行，现统一改用单引号字面量。
- 传输标记缺少生成侧开关时无法与用户直接输入的同名文本区分；改为只在 command() 实际编码时追加开关，导入入口模块不再改写调用者的 argv。
- Windows PowerShell 5.1 调用原生程序时不转义参数里的双引号并丢弃空参数；单引号字面量只保证 PowerShell 解析层安全，到原生命令行这一步仍会失真，所以这类值需要编码传输。
- 旧安装修复命令手工用双引号拼接插件路径，路径含 `$` 或 `$(...)` 时会被展开甚至执行。

## 验收

- 核心接入失败（如未安装宿主、AGENTS 管理区冲突）时，执行器调用次数为零；显式学习请求只记录 `requested`。
- 正常接入、重复接入、显式学习启用和 `--skip-learning` 的既有行为与测试通过。
- 真实 `powershell.exe` 5.1 与 `pwsh.exe`（实际可用时分别验证）子进程中，空格、单引号、双引号、美元符号、反引号、子表达式字符、空参数和普通路径按原值往返，不被额外执行；普通路径的生成命令可直接执行。
- 未安装时的安装修复命令由 `command()` 生成；插件路径含 `$`、`$(...)` 或空格时，在真实 shell 中按字面值执行，修复命令里的子表达式不执行。
- 入口路径含 `$HOME`、`$(...)` 或空格时，`command()` 生成的 signal 命令在真实 PowerShell 5.1/7 中按原值执行，并由真实 PostToolUse Hook 识别、接受回执；双引号或未引用位置的 `$`、额外命令、管道和伪造入口仍被拒绝。

## 边界

- 不改变执行器可信范围：仍使用个人配置，项目 `.workflow/config.json` 可覆盖；只是必须等核心检查通过才预检。不新增自动运行项目命令的权限。
- 不合并 `src/install.mjs`、`src/runner.mjs` 已有的转义写法，也不建立通用命令框架。
- 预检只核对能力，不调用模型。安装副本完整性、宿主 hook 信任和后台复盘的模型调用细节不在本 spec 范围内。

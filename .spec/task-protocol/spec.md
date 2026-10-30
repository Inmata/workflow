---
title: 任务协议与信号接收
status: active
desc: 新任务显式声明分流，历史任务按记录识别续接；信号只在真实入口读取并由协议原子接受
code:
  - src/protocol.mjs
  - src/signal.mjs
  - src/hooks.mjs
  - src/spec.mjs
related:
  - docs/design/protocol.md
  - docs/usage.md
---
# 任务协议与信号接收

## 目标

- 新任务必须显式声明合法的 `route`（`operation-only`、`lead-direct`、`delegated`）；漏填或值非法返回 `ROUTE`，不建立任务。三种分流的原有契约不变：`operation-only` 跳过 spec 与 delegated 门禁，`lead-direct` 只做 spec 检查，`delegated` 另核对包终态、审查与 validation。
- 历史任务按任务记录自身识别：记录不存在即新任务；记录存在但没有 `route` 字段时视为旧版本任务，允许续接，可在续接时补声明一次，声明后不可更改。不引入迁移字段，也不改写历史数据。
- `task-start` 接续保留原 `goal` 与 `permissions`；新任务缺 `goal`、`permissions` 或 `route` 时回执点名缺项。
- 信号只在当前 shell 确实直接执行本安装副本的 `signal` 子命令后由 PostToolUse 接受；完整 payload 与便捷子命令走同一协议校验。拒绝时状态整体回滚。
- spec 检查对非 `operation-only` 任务生效：`lead-direct`、`delegated` 与历史无 `route` 任务都检查，历史任务声明 `operation-only` 后不检查。
- 生产 Hook 的 spec 检查在状态锁外预检，整次检查的 Git 调用共用 4 秒总预算（文件快照读取与锁内复核不计入）；预检把检查对象固定进 `binding`：显式 ref 与 HEAD 都固定成提交 OID，HEAD 另含受管文件摘要、spec 清单与索引快照；索引快照取在只读 `status` 之前，`status` 用 `--no-optional-locks` 不自行刷新索引，检查期间索引被改写同样按过期处理。同时绑定 worktree、ref、项目、任务与（task-end 与 Stop 的）会话回合/票据/修订。复用前只重解析一次 ref 并比对文件快照，不重跑 status/log/rev-list。项目、任务或会话标识缺失、不匹配，提交移动或工作区变化都按 `spec-check:stale` 处理，不把过期结果当成通过，也不在锁内补跑慢 Git。`spec-check:stale` 不可豁免，只能重试；直接调用协议函数且未提供预检结果时，仍在调用内同步检查。

## 原因

- `route` 原先只是可选字段，新任务漏填会静默跳过 delegated 门禁，直到 `task-end` 才得到 `route-missing` 警告，门禁已经被绕过。
- 新旧任务不需要额外迁移：新任务的 taskId 在状态里没有记录，历史任务则有记录；以记录缺失与 `route` 字段缺失区分两种情况，既不改历史数据也不新增 schema 字段。
- 只在 CLI 便捷参数层校验不足以覆盖 `signal --input` 的完整 payload；协议是唯一校验点，避免两条入口行为不一致。

## 验收

- 三种合法 `route` 的新任务均被接受并记录到任务；`route` 缺失、`null`、空串或未知值返回 `ROUTE`，状态中不留下任务。
- 历史无 `route` 任务续接被接受并返回 `kept`；补声明后记录生效，再次声明其他分流返回 `ROUTE`；补声明 `delegated` 后 `task-end` 按 delegated 门禁列出缺项。
- 未声明的历史任务 `task-end` 接受并附 `warning:'route-missing'`，spec 漂移仍被检查。
- 经真实 PostToolUse 的便捷子命令与完整 payload 得到相同的接受/拒绝行为；伪造输出、组合命令和非本插件入口不被接收。
- 慢 Git 预检期间其他会话能用短预算取得状态锁；卡住的 Git 在总预算内返回拒绝回执，而不是让多次 10 秒超时累计吞掉宿主回执；root、ref、任务或会话快照变化时列出 `spec-check:stale`，不复用旧结果。干净预检后受管代码被改动、HEAD 或分支等可移动 ref 移动、会话/任务快照变化或索引快照被改写时，旧报告同样作废；`spec-check:stale` 不接受 `spec`、`spec:<id>`、`spec-check` 或完整条目的豁免。锁内复核只做一次有界 ref 解析与文件快照比对，不新增 status/log/rev-list 调用。
- Stop 在预检过期或检查失败时不报“门禁无缺项”，而是明确列出 `spec 检查无法确认（spec-check:<原因>）` 并提示重试；其余缺项照常列出。
- Stop 检查当前 worktree 的 HEAD，task-end 使用显式 `finalRef`；非 Git 且没有 `.spec` 的项目仍按 `no-spec` 跳过。
- 既有协议、门禁、信号、hooks 测试保持通过，状态文件 schema 版本不变。

## 边界

- 不为历史任务自动补写 `route`，不把缺字段改写成默认值，也不提供迁移命令。
- 不改变三种分流的契约与门禁缺项内容；`route` 一旦声明不可中途切换。
- 校验只放在协议层，不在 `signal.mjs` 复制一套规则；接收仍只认 PostToolUse 中可核对的直接调用。
- 不覆盖宿主权限真实性的证明，也不代替用户授权；spec 的 Git 调用与预算留在 `src/spec.mjs`，协议只消费生产 Hook 预检的内部结果。`binding` 只随当次预检在内存中传递，不写状态、不做持久缓存；锁内复核的重解析上限独立于 4 秒预检预算，超时按过期处理。
- 4 秒总预算与 10 秒单次上限只约束 Git 子进程；文件系统读取、宿主自身超时和真实超大仓库的耗时不做承诺。不为慢检查新增调度器、持久缓存或 schema 字段。

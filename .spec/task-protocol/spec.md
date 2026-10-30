---
title: 任务协议与信号接收
status: active
desc: 新任务显式声明分流与通道，历史任务按记录识别续接；信号只在真实入口读取并由协议原子接受，审查、取消与只读诊断按声明核对
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

- 新任务必须显式声明合法的 `route`（`operation-only`、`lead-direct`、`delegated`）；漏填或值非法返回 `ROUTE`，不建立任务。三种分流的原有契约不变：`operation-only` 跳过 spec 与 delegated 门禁，`lead-direct` 只做 spec 检查，`delegated` 另核对包终态、审查与 validation。`route` 只决定门禁与检查范围，不是任务复杂度认证；用户明确要求 Worker/Reviewer 时，Lead 不得借 `operation-only` 或 `lead-direct` 消除已要求的分工。用户指定 `channels` 后，工作包通道偏离（含漏填，或 delegated 的 worker 包由 Lead 实施）必须在同一 `packages` 信号用 `change.packages` 记录并先取得用户同意，否则返回 `CHANNEL`；不能先声明错误通道再以实际执行与声明一致为由通过。
- 历史任务按任务记录自身识别：记录不存在即新任务；记录存在但没有 `route` 字段时视为旧版本任务，允许续接，可在续接时补声明一次，声明后不可更改。不引入迁移字段，也不改写历史数据。
- `task-start` 接续保留原 `goal` 与 `permissions`；新任务缺 `goal`、`permissions` 或 `route` 时回执点名缺项。
- 信号只在当前 shell 确实直接执行本安装副本的 `signal` 子命令后由 PostToolUse 接受；完整 payload 与便捷子命令走同一协议校验。拒绝时状态整体回滚。
- spec 检查对非 `operation-only` 任务生效：`lead-direct`、`delegated` 与历史无 `route` 任务都检查，历史任务声明 `operation-only` 后不检查。
- 生产 Hook 的 spec 检查在状态锁外预检，整次检查按开始时刻的绝对截止时间给 Git 调用共用 4 秒总预算：同步文件读取不能强制中断，但耗时同样消耗截止时间、减少后续 Git 剩余时长，4 秒不保证预检或 Hook 总时长；锁内复核另有独立预算；预检把检查对象固定进 `binding`：显式 ref 与 HEAD 都固定成提交 OID，HEAD 另含受管文件摘要、spec 清单与索引快照；索引快照取在只读 `status` 之前，`status` 用 `--no-optional-locks` 不自行刷新索引，检查期间索引被改写同样按过期处理。同时绑定 worktree、ref、项目、任务与（task-end 与 Stop 的）会话回合/票据/修订。复用前只重解析一次 ref 并比对文件快照，不重跑 status/log/rev-list。项目、任务或会话标识缺失、不匹配，提交移动或工作区变化都按 `spec-check:stale` 处理，不把过期结果当成通过，也不在锁内补跑慢 Git。`spec-check:stale` 不可豁免，只能重试；直接调用协议函数且未提供预检结果时，仍在调用内同步检查。

## 原因

- `route` 原先只是可选字段，新任务漏填会静默跳过 delegated 门禁，直到 `task-end` 才得到 `route-missing` 警告，门禁已经被绕过。
- 新旧任务不需要额外迁移：新任务的 taskId 在状态里没有记录，历史任务则有记录；以记录缺失与 `route` 字段缺失区分两种情况，既不改历史数据也不新增 schema 字段。
- 只在 CLI 便捷参数层校验不足以覆盖 `signal --input` 的完整 payload；协议是唯一校验点，避免两条入口行为不一致。

## 验收

- 三种合法 `route` 的新任务均被接受并记录到任务；`route` 缺失、`null`、空串或未知值返回 `ROUTE`，状态中不留下任务。
- 历史无 `route` 任务续接被接受并返回 `kept`；补声明后记录生效，再次声明其他分流返回 `ROUTE`；补声明 `delegated` 后 `task-end` 按 delegated 门禁列出缺项。
- 未声明的历史任务 `task-end` 接受并附 `warning:'route-missing'`，spec 漂移仍被检查。
- 经真实 PostToolUse 的便捷子命令与完整 payload 得到相同的接受/拒绝行为；伪造输出、组合命令和非本插件入口不被接收。
- 用户指定分工后，`operation-only`/`lead-direct` 不能消除用户要求的 Worker/Reviewer 分工；`route` 只决定门禁范围，不认证任务复杂度。通道偏离必须在同一 `packages` 信号附 `change.packages`，先声明错误通道再“实际执行与声明一致”不能绕过；未声明通道或未指定角色的旧行为不变。
- 已通过 PASS 审查的 worker 包改 `canceled` 返回 `PACKAGE`，原账本不变；从未审查的包可合法取消，已合法 `waived` 的语义保持不变。同包返修后旧 `reviewedRef` 不再匹配新 `deliveredRef`，必须重新送审；换新包只能在创建时声明 `supersedes`，接替包需要自己的 PASS，继承的旧结论不能直接抵扣。历史上已被标成 `canceled` 但链路有 PASS 的包仍列入 `review:<id>`。
- 只读诊断免审只能在首次创建 worker 包时用 `diagnostic:{purpose, scope[], reason}` 声明：只允许 `dispatched`、不带 `deliveredRef`、不接替已有包；用途与理由非空，`scope` 为 1-50 项项目内相对路径。合法声明记入包记录，`gateReport` 的 `diagnostic` 列出这些包，免去 `review:<id>`。交付时必须在 `note` 写可定位结论与证据；缺结论列 `diagnostic:<id>` 且不能用 waiver 抵扣。实现包、审查包、事后补声明或修改声明、空理由、空/绝对/越界范围、接替已审包都返回 `PACKAGE`。历史未声明包仍要求审查。
- 拒绝信号在真实 PostToolUse 回执中给出可定位原因：PASS 缺 `reviewedRef`、`reviews` 指向未登记包或非 worker 包、包状态/角色错误、审查版本与最终交付不匹配等；修正声明后重发被接受。同 `signalId` 同正文重试保持幂等并标记重放，同 ID 改正文返回 `SIGNAL_ID`；组合命令不被接收，同一 payload 改为独立直接调用后接受。CLI 退出成功不等于 `accepted`；未落盘的失败信号不猜测内容、不自动重放，只依据当前宿主回执与幂等重发恢复。
- 慢 Git 预检期间其他会话能用短预算取得状态锁；卡住的 Git 在总预算内返回拒绝回执，而不是让多次 10 秒超时累计吞掉宿主回执；root、ref、任务或会话快照变化时列出 `spec-check:stale`，不复用旧结果。干净预检后受管代码被改动、HEAD 或分支等可移动 ref 移动、会话/任务快照变化或索引快照被改写时，旧报告同样作废；`spec-check:stale` 不接受 `spec`、`spec:<id>`、`spec-check` 或完整条目的豁免。锁内复核只做一次有界 ref 解析与文件快照比对，不新增 status/log/rev-list 调用。
- Stop 在预检过期或检查失败时不报“门禁无缺项”，而是明确列出 `spec 检查无法确认（spec-check:<原因>）` 并提示重试；其余缺项照常列出。
- Stop 检查当前 worktree 的 HEAD，task-end 使用显式 `finalRef`；非 Git 且没有 `.spec` 的项目仍按 `no-spec` 跳过。
- 既有协议、门禁、信号、hooks 测试保持通过，状态文件 schema 版本不变。

## 边界

- 不为历史任务自动补写 `route`，不把缺字段改写成默认值，也不提供迁移命令。
- 不改变三种分流的契约与门禁缺项内容；`route` 一旦声明不可中途切换。`route` 与 `channel` 只是声明和门禁契约，不认证实际任务复杂度、只读事实、真实委派或代码是否集成；不增加自然语言分类器推断该用哪种分流，也不因文件数自动拆包。
- `canceled` 只表示放弃该包改动，不证明代码已从最终 ref 消失；插件不伪造代码级集成证明，Lead 仍对集成结果负责。诊断包的 `scope`、`reason` 与交付 `note` 只是声明与可定位文本，插件不验证进程实际未写、不提供沙箱，也不检查结论真实性；历史未声明包不回写、不自动补豁免，状态文件 schema 版本不变。
- 回执消费是宿主/模型行为边界：插件只保证拒绝原因可见、未落盘失败可安全幂等重发，不能保证模型一定阅读回执，也不自动猜测或重放失败信号。
- 校验只放在协议层，不在 `signal.mjs` 复制一套规则；接收仍只认 PostToolUse 中可核对的直接调用。不覆盖宿主权限真实性的证明，也不代替用户授权；spec 的 Git 调用与预算留在 `src/spec.mjs`，协议只消费生产 Hook 预检的内部结果。`binding` 只随当次预检在内存中传递，不写状态、不做持久缓存；锁内复核的重解析上限独立于 4 秒预检预算，超时按过期处理。
- 4 秒总预算与 10 秒单次上限只约束 Git 子进程；同步文件读取不检查也无法中断截止时间，其耗时仍会消耗绝对剩余量、缩短后续 Git 可用时间，因此 4 秒不保证整次预检或 Hook 的总时长；宿主自身超时和真实超大仓库的耗时同样不做承诺。不为慢检查新增调度器、持久缓存或 schema 字段。

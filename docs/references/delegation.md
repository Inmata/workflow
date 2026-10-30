# 协作

Lead 派发 Worker/Reviewer 时读本页；简单任务（lead-direct）不需要。信号字段以[协议](../design/protocol.md#信号)为准。

## 派工

1. 使用已有确认计划，核对实际工作区、分支、基准及用户未提交改动。每包写目标、产出、最小读取、允许修改范围、业务所有权、接口签名/错误/异步语义、真实消费入口、验收、指定验证与包内已授权的补测范围、停止条件、相关 spec（`.spec/<id>/spec.md` 路径列表，加上计划“spec 影响”中该包对应的改后验收句子；无则写无）和相关技能（本机实际存在、经用户选定的技能名及用途；无则写无）。依赖提供方先交接口，消费方继续独立部分；真实入口的接通属于原任务，不能留到泛称的最终适配。无法可靠带入基线时报告依赖，不制造生产 mock。计划、验收文档或参照资料只存在于未提交改动、不在派工基准里时，非默认分支上先按 `allowedPaths` 做一次本地基线 commit，默认分支或含用户无关改动时先向用户报告确认；不能让 Worker 靠读主目录绝对路径对齐基线。
2. 根据独立性、关键路径、收益和工具上限建议并发，不默认人数。task-start 声明 route=delegated；在派发、消费结果、审查结论三个节点用 packages 记账：单个包用 `--package` 配 `--status`、`--ref` 等便捷参数，同批多个包或 `change` 用 `--input`（`handle`=宿主委派 ID；`channel` 填实际通道，如 `codeg:claude_code`、`builtin:general-purpose`、`lead`），工作包里写明 packageId，并要求子会话先发 `role-claim`。route 只决定门禁与检查范围，不是复杂度认证或绕过分工的开关：用户明确要求 Worker/Reviewer 时，不能改用 `operation-only`/`lead-direct` 消除该分工。单个包的常用写法：

   ```powershell
   node "<入口>" signal packages --session <sessionId> --turn <turnId> --id pkg-w1 --package w1 --role worker --status dispatched --channel codeg:claude_code --handle <委派ID>
   node "<入口>" signal packages --session <sessionId> --turn <turnId> --id pkg-w1-done --package w1 --status consumed --ref <交付提交>
   node "<入口>" signal packages --session <sessionId> --turn <turnId> --id pkg-r1 --package r1 --role reviewer --status dispatched --channel codeg:codex --handle <委派ID> --reviews w1
   node "<入口>" signal packages --session <sessionId> --turn <turnId> --id pkg-r1-done --package r1 --status consumed --verdict PASS --ref <被审提交>
   ```

   `--ref` 对 worker 记 `deliveredRef`、对 reviewer 记 `reviewedRef`；reviewer 的 PASS 必须带 `reviews` 和 `reviewedRef`，否则回执 `PACKAGE` 并点名缺项。一次消费并派下一阶段等同一信号里的多个包仍用 `--input` 附业务 JSON。用户指定了各角色用哪个智能体时，task-start 带 `channels`，整个任务沿用，每次派发前核对。要换通道或 Lead 自己接手 worker 包，先告诉用户原因并取得同意，再在该次 `packages` 附 `change` 列出这些包，否则插件以 `CHANNEL` 拒绝；不能先声明错误通道，再声称实际执行与声明一致。通道与 route 都只是声明/门禁契约，不认证真实委派或只读。宿主内置子代理与 Lead 共用会话、没有 workflow 身份：派给它的包不要求 role-claim，由 Lead 记账。沿用已有角色/后续审查授权；缺角色、新增、更换和范围扩大时只补相应决定。派工直接引用角色上下文返回的 documents 路径，不手写角色入口。可靠隔离 worktree，交接前原负责人停止修改并保留检查点；新负责人核对新基准和剩余事项，不重做已有调查。工具类型、模型和设置沿用指定，Codeg 操作见[适配](../adapters/codeg.md)。

## 等待与反馈

在派发前、收结果及重要决定前接收用户反馈，传递相关原话与范围并确认收到；不能追加消息时暂停受影响动作，接续时带入。其他独立工作继续。有角色运行时持续协调，不以单包完成、提问或等待指派结束整个工作。

- 宿主内置子代理（Claude Agent、Codex spawn_agent）：宿主在子任务结束时会通知 Lead，派发后继续其他工作，收到通知再消费结果。
- Codeg 委派：宿主不会在子任务结束时唤醒 Lead，回合一结束就收不到结果，因此派发后在同一回合用阻塞等待收结果（`wait_ms: 0`，见[等待循环](../adapters/codeg.md#等待循环)），不在等待期间轮询或跑无关命令涨上下文。

只在子任务阻塞于用户、全部终态或用户要求暂停时停下，停下时说明在途包和接续方式。全部角色终态后汇总，推进已授权下一步。中断/失败是终态但不是完成。无变化不反复播报、不忙轮询。

## 审查与返修

1. 实施交付齐全后安排独立 Reviewer，判定 Diff/Deep/Escalated 等级并说明理由。附正确基线、待审对象、真实 diff 获取方法、验收、同一组相关 spec、依赖与已有测试证据，以及包内已授权的定向检查范围。共享状态/同一操作流安排一次联合审查，避免分批漏链。
2. 结构风险并入同一次审查：多个 Worker 包改到同一模块或共享接口、增删或升级运行时依赖、对外接口签名变化时，由 Lead 判断是否在审查包里加一项“边界与依赖”检查（对照 `.spec/architecture/spec.md`，没有时对照集成前的模块边界和依赖方向；只看边界、重复实现、接口一致性）。不因新增目录等机械条件另开 Reviewer。
3. FIX 按原授权退原 Worker 定向修复；原范围且有新证据时继续，到提醒阈值只做一次裁决，不机械重开委派。同时满足三条时免裁决直接原样退回：缺陷全在原包允许范围内、结论与缺陷清单不矛盾、未到提醒阈值（`packages` 回执带 `repairLimit` 即已到阈值）。返修沿用原 packageId 重新派发；需要换新 packageId 时只能在创建时带 `supersedes` 接上旧包，接替包需要自己的 PASS。已交付或审查要求修订时轮次照样累计，同一交付轮次只计一次（同一轮迟到的交付引用或 FIX 不会重复累计，交付后启动失败重派也不增加），从未产出的启动失败重派不增加返修；审查只看链上最新的包。同包返修再次交付后，旧 `reviewedRef` 不再匹配新的 `deliveredRef`，必须重新送审最终交付版本。当前账本仍有审查结论的包（PASS/FIX/BLOCKED；含沿 supersedes 链的旧包）之后又改了，不用 waiver 豁免，也不把旧包改标 waived；历史只有 PASS 单调保留，审查对象改指其他包后历史 PASS 仍算已审，旧的 FIX/BLOCKED 不留存。曾有 PASS 的包不能改 canceled（即使审查后来改成 FIX/BLOCKED，插件返回 `PACKAGE`）；取消只按 PASS 判断，只有 FIX/BLOCKED 而没有 PASS 的包仍可取消。取消表示放弃该包改动，不证明代码已从最终 ref 消失。同一批 packages 不允许重复 packageId（返回 `PACKAGE` 并整批回滚），一个包在一次信号里只写一项；同批新建 worker 包并直接标 canceled 时，若同批 PASS 指向它或 supersedes 链上有 PASS，也整批拒绝（与数组顺序无关）。结论与缺陷列表矛盾先澄清，有阻断缺陷按 FIX。同类反例仍属原任务，不以代表样例之外为由降级。范围外补测、范围外问题和追加功能由 Lead 裁决，说明疑点、最小范围和停止条件；偏好不阻断交付。返修、诊断和后台复盘额度分别保持。
4. 只读诊断包（不产生项目写入的调查、复现或资料核对）可在首次创建时以 `diagnostic:{purpose, scope[], reason}` 声明免审；`scope` 为项目内相对路径，理由非空，包须是 `dispatched` worker、不能带 `deliveredRef` 或 `supersedes`。交付时在 `note` 写可定位结论与证据，缺结论列 `diagnostic:<id>` 且不能豁免。实现包、事后补声明、修改声明、接替已审包都不适用；声明不证明进程实际未写，不能把诊断包当实现包使用。多文件资料核对不等于必须拆多个包，复杂实现仍按风险取得必要独立审查。

## 集成

全部必要审查 PASS 后按依赖集成，核对最终版本与审查对象；只处理归属、接口和冲突，运行组合变化相关回归。task-end 前做 spec 检查和计划回写（见 [Lead](../roles/lead.md#spec)）；README、使用说明、导航等用户可见文档按 Worker 的“文档影响”申报同步。产品冲突仍交原负责人/必要复审；已审交付对象变化时只复核相关差异和受影响证据，结论仍对最终版本，不重开已通过部分。已有授权的复审/集成自动接续。

## 中途变更

改变已确认的目标、验收、架构边界、视觉方向，或需要改已确认计划之外的 spec 正文，属于重大变更：暂停受影响的包，向用户确认后以新基准和用户原话重新派发。其余实现取舍属于细节变更：Lead 直接处理，同步受影响的包，并在下一次 `packages` 信号里附 `change: {summary, reason, packages}` 记入任务。

## 校准

协作链路校准练习只在用户要求，或工具、调度配置改变时执行，不加入项目日常测试、CI 或每轮验收。验证协作效果时核对实际委派、文件归属、等待和重复测试记录；耗时与费用只使用可获取的真实数据，不把 token 统计当账单，不另造指标报告。

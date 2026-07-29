---
status: accepted
---

# Message 与 PI 编排遵循唯一端到端权威路径

ADR-0062 至 ADR-0068 已分别冻结 PI authority、Task lifecycle、子 Task 合同与 Offer、失败改派、系统活动可见性、Command registry 以及 legacy migration。本决策用十二个完整场景验证这些合同可以组合成唯一解释，并补齐 Simple agent request 升级时旧执行权与新 root Task 之间的原子 handoff。实施阶段不得为同一输入重新选择另一套 trigger、ownership、状态、可见性、恢复或兼容语义。

## 跨层不变量

- Message delivery 只原子提交 `Message + InboxItem`；notice、evaluator、PI 或 daemon 失败不能回滚消息事实，也不能把 delivered 当作 read。
- 只有结构化 human trigger、合法 Agent orchestration escalation、确定性 Team promotion policy 或合法 proposal accept 可以经唯一 Promotion gate 创建 root Task；自然语言与模型判断永远至多产生 clarification 或 proposal。
- Server 持有 Message、Inbox、Task、DAG、claim、run、event、audit、outbox 与 migration epoch 的权威事实。PI driver 与 Agent execution claim 都是受 revision、lease 和 fencing 约束的限时执行权，daemon 不是恢复或编排权威。
- root Task 的 requester、PI orchestration claim、Human review authority 与子 Task execution claim 分离；read、attention、责任、交付汇总与验收分别推进。
- 所有权威写入使用 Command registry 的具名 command、精确 preconditions 与业务幂等身份；失败不留部分事实，连接断开不等于事务失败。
- 每个 source lineage 在任一时刻只有一个 authority epoch 和一条工作路径；兼容 projection、legacy drain 或故障保护都不能成为第二 writer。

## 场景合同

| 场景 | 唯一允许的权威路径 | 禁止的替代解释 |
| --- | --- | --- |
| 普通聊天 | Message delivery 正常提交；`off` 不评估，`shadow` 只审计，`proposal-only` 至多展示 clarification/proposal；没有 root Task、PI run、claim 或 dispatch | 文字像任务即建单、每消息 PI、未 @ 隐式选 Agent |
| 人类显式复杂任务 | 结构化 trigger 经 Promotion gate 原子创建 root Task、source relation、run、orchestration claim、调度、event/audit/outbox；首次改变工作事实的 PI command 才把 `todo` 推进为 `in_progress` | promotion 即开工、PI 成为成员、promotion 授权高风险动作 |
| Agent 主动升级 | 只有当前合法责任 Agent 可提交绑定 source、Freshness basis、objective 与 orchestration need 的 escalation；边界内 direct promotion，越界只生成 proposal | 旁观 Agent 升级、升级即取得编排权、借升级扩权 |
| policy 与 evaluator 并发 | 确定性 policy 必须有版本化规则、预授权和 orchestration need；所有入口按 source lineage 在 Promotion gate 幂等收敛，不一致时返回 Promotion conflict | 语义模型 auto-promote、先到先得、policy 覆盖 `chat-only` |
| 并发新消息 | send/claim 只被相关 Message 或 Task 变化 freshness hold；成功只 ack 连续 Inbox candidate，自身消息不入自身 Inbox；失败、hold、conflict 不推进边界 | target 全序强阻塞、跨过未读、换 idempotency key 重发 |
| 子 Task 失败改派 | Server 按 failure classification、attempt budget、challenge/grace、deadline 与 fencing 决定是否产生新 Offer；新 Agent 必须 accept；未知外部效果进入 action_required | notice 丢失即改派、PI 直接转移 claim、未知效果自动重试 |
| 频道外能力缺口 | 无当前频道 eligible Agent 时进入 `allocation_blocked` 与人类 action_required；只可给出脱敏建议，成员变化后重新校验再 Offer | 跨频道读取或指派、静默邀请、降低 required 合同 |
| 汇总与人工验收 | required delivery 均被接受且 optional 工作已退休后，PI 原子提交 root delivery 并进入 `in_review`；合法 Human review authority 接受后才 `done`，退回产生新 revision | PI 自动验收、read 等于接受、退回新建另一 root Task |
| 取消与终态 | 合法 termination authority 通过具名 command 原子推进 `cancelled`、执行 cascade closeout 并 fencing 后续写入；已发生或未知外部效果单独治理；终态不可 reopen | 删除历史、取消即撤销外部世界、用 `closed` 代替叫停 |
| legacy cutover | Team readiness token 原子推进 authority epoch；并发消息按 migration revision 线性化；旧工作仅限隔离 drain，合法结果经 Legacy drain bridge 提交 | dual-write、旧 API 静默转译、故障回滚 legacy writer |
| PI 崩溃与结果未知 | orchestration command 全部提交或全部不提交；调用方查询 receipt 或原 key replay；新 worker 用更高 fencing 从 Server facts/events/checkpoint 恢复 | 换 key 重建 DAG、daemon 接管、模型上下文补事实 |
| simple request 升级交接 | direct escalation 成功时，Promotion gate 与 Simple request escalation handoff 在同一事务中创建新编排事实、终结旧执行权并保留未验收材料；proposal 或失败不发生 handoff | 旧直派与新 Task 并行、自动继承交付、半次 handoff |

## Simple request escalation handoff

显式 `@Agent` 首先形成不创建 Tracked task 的 Simple agent request。责任 Agent 发现真实 orchestration need 后，可以提交结构化 escalation；如果 Promotion gate 返回 direct `applied`，Server 必须在同一事务中：

1. 创建或幂等返回该 source lineage 的唯一 root Task、Promotion source relation、PI orchestration run 与 orchestration claim；
2. 终结原 simple request 的独立执行权，并 fencing 尚未提交的旧 Invocation；
3. 把原始 @Agent 主执行者约束转换为相关主子 Task 的 targeted Offer，而不是自动 execution claim；
4. 把旧执行的部分结果保存为带 provenance、未验收的 Unaccepted handoff material，只有新 Executable subtask contract 显式绑定并重新验收后才能使用。

若 escalation 只产生 Promotion proposal，原 simple request 不发生 authority handoff；Agent 只能在原授权范围内继续，或明确回复正在等待授权。`freshness_hold`、`conflict`、`rejected` 与失败路径都不创建 Task、不终结旧执行权，也不留下部分 handoff。

## 实施交接边界

实施者可以选择数据库、队列、transport、handler 与投影结构，但必须让共享 runtime schemas、Command registry、capabilities、event/receipt 版本和跨端 conformance tests 覆盖上述十二条场景。验收测试必须证明每个输入只有表中一条权威路径，并对禁止路径提供回归断言。

本决策不改变 ADR-0062 至 ADR-0068 的既有事实，也不决定多个根 Task 竞争 PI capacity 时的全局公平性、优先级、配额、饥饿保护或 backpressure；这些仍需独立合同。它完成 #891 的 Message delivery 与 PI Manager 协作编排决策地图，并为后续实现拆票提供系统级验收基线。

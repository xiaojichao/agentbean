---
status: accepted
---

# 子任务失败使用有界 attempt 与条件改派

子任务失败不新增 `failed` TaskStatus，也不自动终结根 Task。Offer 拒绝、过期、无人接受，以及 claim 后尚未出现 Task execution start 时的 relinquishment/fencing，只结束当前 allocation round；实际开工后的失败、超时、relinquishment 或 fencing 才终止并消耗 execution attempt。allocation round 受独立窗口约束，execution retry budget 则由已发布子任务合同固定，PI 不得通过改派、DAG revision 或重启重置。

Agent/daemon 只提交绑定 claim、Task revision 与 attempt 的结构化 failure report。Server 使用版本化 taxonomy 和当前权限、lease、deadline 事实形成权威分类；只有 `transient_environment`、`agent_unavailable` 等明确允许的类别才可能在预算内自动重试，`capability_mismatch` 不得重试同一 Agent，合同、权限、policy、deadline 与 `unknown` 问题必须修订、等待授权或升级。每次改派都重新校验 eligibility、容量、期限与 cooldown，签发新的 claim、grant 和 fencing token；旧 attempt 保持不可变，未验收产物只能作为经权限校验、带 provenance 的 handoff material。

Server 分别持久化 allocation、start、progress SLA 与 attempt deadline，并区分 `dueAt` 交付目标和可选 `hardStopAt` 绝对执行上限。heartbeat、离线和 notice 状态都不是进展。progress SLA 首次超时进入 `progress_at_risk` 并签发有界 challenge；grace 到期仍无有效 progress/checkpoint 时，Server 原子 fencing 并形成超时事实。安全撤权、权限失效或明确 relinquish 可以跳过 grace，迟到结果不得成为正式 delivery。

重试、阻塞、升级与恢复状态是 Server 持久事实。一次改派 command 原子校验 Task/DAG revision、attempt、fencing、预算、资格、期限和 idempotency，并共同提交旧 attempt 终止、预算、event/audit、调度、Offer 与 outbox；取消、修订或撤权并发时由 revision/fencing 仲裁。重启后按 `notBefore`、cooldown、failure fingerprint、SLA 与 `nextWakeAt` 恢复，无法安全解释旧策略时进入 `recovery_pending`，不能依赖 PI 本地记忆重试。

预算耗尽、未知失败、权限/安全阻塞、无合格候选或期限风险产生面向预声明 Human escalation authority 的独立 `action_required`。read/seen 和普通消息不能解决它；有权人类必须使用绑定当前 escalation revision 的具名 Server command 重试、增加预算、修订合同、延期或取消。策略更新不静默改变活动 Task，只有安全收紧可以立即 fencing；放宽预算、期限或可重试范围必须显式修订。未被验收的 output slot 保持未解析，下游继续不可 runnable，required 工作不能由 PI 为绕过失败而静默删除。

该决策细化 ADR-0063 的角色门禁 Task 状态机与 ADR-0064 的 allocation round、attempt、Offer 和 handoff 合同；它不决定多个根 Task 竞争 PI capacity 时的全局公平性、优先级或 backpressure。

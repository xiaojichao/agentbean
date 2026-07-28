---
status: accepted
---

# Task 生命周期使用按角色门禁的具名转换

根 Task 不设单一 owner、assignee 或普通 Agent claim：来源 requester 提供目标与作用域，PI orchestration claim 持有系统编排责任，Human review authority 决定根交付，Agent execution claim 只约束可执行子 Task。根 Task 使用 `todo → in_progress → in_review → done` 主路径，并以独立的 `cancelled` 与 `closed` 表达取消和行政关闭；分诊、拆解、派发、执行、等待与汇总只属于 PI orchestration run 的 phase/event 投影。

子 Task 只有在 Agent 接受有效 Offer 并原子建立 claim 后才能进入 `in_progress`，交付后进入 `in_review`，由 PI 按冻结验收条件与 Server evidence 接受为 `done` 或退回为新 attempt；blocked 与 failed 分别是 impediment 和 execution attempt 结果，不是 TaskStatus。所有状态变化只能通过携带角色化 authority、revision/attempt、fencing 与 idempotency key 的具名 Server command 原子提交，禁止通用 `updateTask(status)`、assignee 冒充 claim、终态直接 reopen 或用新 revision 静默复用受影响事实。

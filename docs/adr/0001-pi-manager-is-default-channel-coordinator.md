---
status: accepted
---

# PI Manager 是默认频道协调者

AgentBean 将 PI Manager 作为每一条人类频道消息的默认理解与协作决策层，因为产品目标是从消息入口根本改善意图理解、任务认领和任务分解，而不只是为显式复杂 Task 增加一个执行器。PI 对所有消息形成 Channel coordination decision，但只有需要持续跟踪、交付审核或多 Agent 协作时才创建 Task；显式 @Agent 仍约束主执行 Agent，PI 本身不成为 Team 成员，也不替代外部 Agent 完成领域工作。

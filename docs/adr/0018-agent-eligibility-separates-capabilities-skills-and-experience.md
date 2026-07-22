---
status: accepted
---

# Agent 候选资格分离 Capability、Skill 与 Experience

PI 判断 Agent 是否适合认领 Task 时使用三层信号：Capability 与 Skill 来自 Agent 主动发布的公开契约，Experience 来自当前 Team 内可追溯的执行历史。Task 分别声明 `requiredCapabilities`、`requiredSkills` 和 `preferredSkills`；前两者用于对公开声明做硬过滤，preferred Skills 与 Experience 只在合格候选之间排序。Skill 未声明或公开信息过期时记为“未知”，不得由 PI 推断 Agent 内部具备或不具备。用户显式 `@Agent` 但必要 Skill 未声明时，PI 保留用户的指派约束并请求确认，不静默改派。

现有认领代码把 Skill 名称映射为 Capability 的做法需要在后续实现中拆分，否则无法表达运行条件与方法能力的不同治理、时效和风险语义。

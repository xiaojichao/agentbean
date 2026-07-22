---
status: accepted
---

# 根 Task Skills 可由多个 Agent 通过子任务共同覆盖

根 Task 表达总体目标和整体 Skill coverage，不要求单个 Agent 具备全部 Skills。PI 按独立可交付边界建立任务树，为每个可执行子 Task 分别声明 required Capabilities 与 required Skills，并定义子 Task 之间的输入、输出、依赖和验收。认领某个可执行子 Task 的 Agent 必须完整满足该子 Task 的全部硬门槛。

当工作在语义、安全或事务上不可拆分时，PI 不得为了迁就现有 Agent 强行拆开；它必须寻找完整满足条件的单个 Agent，或者请求用户调整方案。该模型允许多个专业 Agent 共同覆盖根目标，同时保持每次认领的责任边界可验证。

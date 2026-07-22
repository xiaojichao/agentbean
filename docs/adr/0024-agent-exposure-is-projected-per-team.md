---
status: accepted
---

# Agent Exposure 按 Team 投影

Agent 或 Agent 所有者决定向每个 Team 暴露哪些 Capabilities、Skills、约束和可用状态。PI 只能消费当前 Team 的 Agent Exposure Manifest 投影，不能查看该 Agent 在其他 Team 的声明、任务或经验。Team Owner/Admin 可以依据治理边界禁用某些已暴露操作，但不能扩大 Agent 的供给、查看隐藏信息或要求 Agent 公开内部实现。

Channel 默认复用所属 Team 的投影，不再维护独立 Skill 清单；频道成员与内容权限继续决定谁能发起请求，以及哪些上下文可以进入 Task Offer。该模型让 Agent 控制对外供给，让 Team 控制是否使用，同时保持跨 Team 隔离。

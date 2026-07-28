---
status: superseded by ADR-0066
---

# PI Manager 使用 AgentBean 系统协调身份

本决策由 ADR-0066 取代。PI Manager 仍不作为普通 Agent 出现在 Team 成员或 Agent 列表中，也不把协调内容伪装成外部 Agent 回复；但它不再以可回复的 AgentBean 系统消息发送者身份发言。澄清或授权需求由具名 Server command response 与 `System attention item` 表达，Task 状态和多 Agent 汇总由 `System activity projection` 与 Task delivery revision 表达；外部 Agent 的原始回复继续归属于实际执行者，且不展示 PI 内部推理。

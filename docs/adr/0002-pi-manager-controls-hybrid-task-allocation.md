---
status: accepted
---

# PI Manager 控制定向指派与开放认领的混合分配

AgentBean 由 PI Manager 对结构化 Task 选择定向指派或开放认领，而不让外部 Agent 直接监听并争抢原始频道消息。显式 @Agent 保持为主执行者硬约束；候选明确的简单任务由 PI 定向指派，候选相近或负载不确定时发布 Task offer，多能力请求先分解再逐项分配。这样既避免频道重复回复，又保留外部 Agent 对开放任务的接受或拒绝权。

---
status: accepted
---

# 未 @ 消息禁止隐式 fallback Dispatch

AgentBean 将人类频道消息的工作入口收敛为两条：开启「PI 自动协调」时走 **Coordinated message intake**（先 Channel coordination decision，再进入闲聊、Simple agent request、Tracked task 等路径）；关闭、旁路或协调不可用时走 **Uncoordinated message intake**（仅显式 `@Agent` 定向指派，或既有 Tracked task 跟进）。禁止把「频道内第一在线 Agent」作为未 @ 消息的隐式负责人，也禁止对原始聊天消息开放 claim。

该决策废止以 latency 为理由的 legacy 未 @ 直派日常默认。隐式 fallback 会把协作退回「谁在线谁做」，挖空 PI Manager「先理解再组织」的价值，并已在生产中表现为非预期 Agent 接管（即便已限制为频道成员）。紧急旁路若仍需保留，只能挂在系统级 PI Rollout State，不得作为 Team 日常产品行为。Claim 仍只发生在结构化 Task Offer 被 Agent 接受之后；它解决唯一负责人，不解决原始消息的抢答。

## Considered Options

- **废止日常 legacy 未 @ fallback（采纳）**：与 PI Manager、Task offer、Uncoordinated intake 语言一致；未 @ 延迟由协调路径承担。
- **长期双轨（协调失败则 fallback）**：实现简单，但保留第二套抢单入口，故障与「未就绪」时行为不可预期。
- **永久保留未 @ → 频道内第一在线成员**：低延迟，但与 claim/协调叙事冲突，复杂协作无默认组织者。

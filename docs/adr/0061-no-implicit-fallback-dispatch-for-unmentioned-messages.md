---
status: superseded by ADR-0062
---

# 未 @ 消息禁止隐式 fallback Dispatch

> 当前权威合同见 ADR-0062；旧每消息协调事实、API 与数据的迁移和退役边界见 ADR-0068。

AgentBean 将人类频道消息的工作入口收敛为两条：开启「PI 自动协调」时走 **Coordinated message intake**（先 Channel coordination decision，再进入闲聊、Simple agent request、Tracked task 等路径）；关闭、旁路或协调不可用时走 **Uncoordinated message intake**（仅显式 `@Agent` 定向指派，或既有 Tracked task 跟进）。禁止把「频道内第一在线 Agent」作为未 @ 消息的隐式负责人，也禁止对原始聊天消息开放 claim。

该决策废止以 latency 为理由的 legacy 未 @ 直派日常默认。隐式 fallback 会把协作退回「谁在线谁做」，挖空 PI Manager「先理解再组织」的价值，并已在生产中表现为非预期 Agent 接管（即便已限制为频道成员）。紧急旁路若仍需保留，只能挂在系统级 PI Rollout State，不得作为 Team 日常产品行为。Claim 仍只发生在结构化 Task Offer 被 Agent 接受之后；它解决唯一负责人，不解决原始消息的抢答。

## Consequences

- Server 宿主默认 `messageIngestionMode: durable-job`，并启动 Channel Coordinator 消费循环，使开启「PI 自动协调」时走 Coordinated message intake。
- 过渡期：durable-job 在入队后仍对 **显式 @ / DM / 线程上下文 owner** 以及 **asTask 管理路由** 做即时执行桥（dispatch / managed run），避免 Agent 执行链路断裂；**未 @ 根消息**只入队、不隐式 Dispatch。
- 紧急回退可设 `AGENTBEAN_NEXT_MESSAGE_INGESTION_MODE=legacy`（或显式 host 入参）；不得把未 @ fallback 当作日常产品路径。
- 无 Active PI Model 时 Job 仍会以 unavailable 落库，消息照常展示；不回落隐式 Dispatch。

## Considered Options

- **废止日常 legacy 未 @ fallback（采纳）**：与 PI Manager、Task offer、Uncoordinated intake 语言一致；未 @ 延迟由协调路径承担。
- **长期双轨（协调失败则 fallback）**：实现简单，但保留第二套抢单入口，故障与「未就绪」时行为不可预期。
- **永久保留未 @ → 频道内第一在线成员**：低延迟，但与 claim/协调叙事冲突，复杂协作无默认组织者。

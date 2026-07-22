---
status: accepted
---

# Server 承载默认 Channel Coordinator

由于 PI Manager 被定义为每条人类频道消息的默认理解与协作决策层，AgentBean Server 必须承载默认 Channel Coordinator，使消息理解、Task 创建与分解、协作调度以及 Server 协作 Memory 检索不依赖任何用户 Device 在线。Device 继续负责外部 Agent、本地 Workspace、Device-local Memory、本地凭证及其他本地能力；Team 可以为隐私或本地模型选择 Device-only coordination，但必须接受并明确看到 Device 离线时协调能力不可用。

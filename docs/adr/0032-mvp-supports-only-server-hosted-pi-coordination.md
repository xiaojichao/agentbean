---
status: accepted
---

# MVP 只支持 Server-hosted PI Coordination

为保持全局单模型和首版运行边界简单，PI MVP 的 Channel Coordinator 统一运行在 AgentBean Server，系统管理员从 Server-hosted PI Provider Card 中指定一个全局 Active PI Model。设置页不提供 Device-only 或 placement 选择。

Device Agent 仍负责本地文件、Workspace、Shell、Device-local Memory 等 Task 执行，这一决定不移除或弱化 Device execution。此前认可的 Device-only coordination 继续作为未来产品能力保留，待真实的本地隐私需求出现后再设计 Device 选择、离线状态、本地凭据和模型差异处理。

---
status: accepted
---

# 不建立自动学习的 AgentBean 全局业务记忆

AgentBean 将全局产品知识、用户个人偏好和 Team 业务记忆分成不同概念：System Knowledge 由系统管理员版本化维护且不能被聊天自动改写；User Memory 只保存当前用户的语言、格式、时区、沟通与自动化偏好，可以随该用户跨 Team 使用；Team、Channel 和 Agent Memory 继续留在 Team 权限边界内。系统不建立从聊天自动学习的 AgentBean 全局业务记忆，跨 Team 业务知识未来只能通过显式导出、共享和接收建立。

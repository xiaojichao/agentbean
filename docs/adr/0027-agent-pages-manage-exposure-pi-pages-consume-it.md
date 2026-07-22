---
status: accepted
---

# Agent 页面管理 Exposure，PI 页面只消费与限制

Agent 所有者在 Agent 管理界面决定该 Agent 向哪些 Team 暴露哪些 Capabilities、Skills 和约束。这是在 AgentBean 中维护公开协作契约，不代表系统可以查看或管理 Agent 内部实现。PI 管理界面只消费当前 Team 的 Exposure 投影，展示 Skill coverage、匹配理由、Team 内可靠性信号和被 Team 禁用的 Agent operations。

PI 管理界面不得安装、编辑、启停、复制或探测 Agent 内部 Skill。Team Owner/Admin 可以限制本 Team 是否使用某项已暴露操作，但不能扩大 Agent 的公开供给。普通成员只在 Task 上看到理解匹配结果所需的理由，不获得其他 Team 或 Agent 内部信息。

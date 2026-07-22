---
status: accepted
---

# Agent Memory 按 Team 与 Agent 联合隔离

AgentBean 将协作侧 Agent Memory 定义为一个 Team 内关于特定外部 Agent 的职责、偏好和可复用经验，而不是该 Agent 可以携带到所有 Team 的全局历史。同一个 Agent 发布到多个 Team 时，各 Team 的 Agent Memory 完全隔离；Device-local Agent Memory 另归设备所有者和本地工作空间，只有经过明确授权和最小化投影后才能进入指定 Team。该边界避免 Agent 成为绕过 Team 权限的隐式数据通道。

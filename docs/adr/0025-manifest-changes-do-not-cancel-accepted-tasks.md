---
status: accepted
---

# Manifest 变化不自动取消已接受的 Task

Task Offer 固定当时的 `taskRevision` 与 `manifestRevision`。Agent 撤回相关 Capability 或 Skill 后，尚未接受的旧 Offer 失效，PI 使用最新 Team Agent Exposure 重新匹配；所有新 Task 也始终使用最新投影。这避免 PI 根据已经撤回的公开声明继续建立新承诺。

Agent 明确接受 Task 后形成独立的履约承诺，Manifest 的后续变化不自动取消有效 claim。Agent 无法继续时必须明确 relinquish claim，由 PI 决定重新规划、交接或失败。System/Team 当前安全权限的撤销优先级更高，可以停止进行中的相关操作，避免旧承诺绕过新的安全边界。

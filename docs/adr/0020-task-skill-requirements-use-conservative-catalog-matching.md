---
status: accepted
---

# Task Skill Requirement 采用谨慎的真实目录匹配

PI 先分解用户请求，再为每个可执行 Task 从当前 Team 可见的 Agent Exposure Manifest 中选择真实声明的稳定 Skill ID。用户明确指定的 Skill 成为 required Skill；PI 只有在缺少该 Skill 就无法正确或安全完成任务时，才自动写入 `requiredSkills`。只影响质量、速度或流程规范的 Skill 写入 `preferredSkills`，普通通用任务允许没有 required Skill。

每项自动匹配必须保存“为何需要该 Skill”的可见理由。匹配存在歧义，或者 required Skill 会排除用户显式 `@Agent` 时，PI 请求用户确认。该规则防止 PI 创造未声明的 Skill、把偏好误作硬门槛，或因过度约束制造虚假的“无人可认领”；它不授权 PI 检查 Agent 内部实现。

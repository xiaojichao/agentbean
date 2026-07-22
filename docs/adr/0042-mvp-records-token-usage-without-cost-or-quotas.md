---
status: accepted
---

# MVP 记录 Token Usage 但不关联费用或额度

每次 ManagementRun 继续记录 Provider 返回的 input/output Token 数量，用于诊断上下文增长、异常消耗和模型响应问题。系统管理员可以查看全局汇总，Team 只能查看本 Team 使用量。该遥测不计算金额，不执行 Token 配额，也不触发自动停用。

Provider 未返回 usage 时明确标记为“未知”，不能伪装成零，也不因此阻止 Provider Card 发布。这保留了运行可观测性和未来治理所需事实，同时遵守 MVP 暂不考虑费用的范围决定。

---
status: superseded
superseded-by: 0030
---

# PI Runtime Profile 使用三个固定职责槽位

一个 Runtime Profile 不只绑定一个模型，而是包含三个固定职责槽位：`realtime_coordinator` 负责频道消息理解、建 Task 判断与简单路由；`deep_orchestrator` 负责任务分解、Agent 匹配、冲突处理、结果汇总和验收；`memory_curator` 负责 Memory 候选提取、作用域判断、经验包生成和检索规划。系统管理员为各槽位配置模型供给、fallback 和预算，不同槽位可以复用同一模型。

Team 仍只选择“标准”“高质量”“低成本”“本地隐私”等完整 Runtime Profile，不逐槽位选择 Provider 或模型。固定槽位提供足够的质量、延迟与成本分工，同时避免开放任意工作流编排和大量细粒度开关。

该决定在 MVP 范围收敛时被 ADR 0030 取代。

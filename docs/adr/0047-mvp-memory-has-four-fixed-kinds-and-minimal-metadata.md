---
status: accepted
---

# MVP Memory 只有四种固定类型与最小元数据

MVP 的 Formal Memory 和 Memory Candidate 只使用四种类型：`fact` 表示已确认事实，`decision` 表示已经作出的决定，`rule` 表示必须遵守的流程或约束，`preference` 表示非强制偏好。项目经验继续使用 Reusable Experience Pack，不塞入单条 Memory。

每条 Memory 只要求类型、简短内容、作用域、来源、状态、创建/更新时间和可选失效时间。MVP 不引入知识图谱、实体关系、自定义 Schema、自定义类型或任意扩展字段，优先交付可理解、可维护、可检索的最小闭环。

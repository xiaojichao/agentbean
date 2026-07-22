---
status: superseded
superseded-by: 0043
---

# MVP Runtime Profile 只绑定一个模型

为尽快上线最小可用版本，每个 PI Runtime Profile 只绑定一个已启用 PI Provider Card 与其中一个 Model ID。频道实时协调、深度任务编排和 Memory 管理暂时共用该模型；Team 仍只选择系统管理员发布的 Profile，不直接填写 Provider endpoint、Credential 或任意模型 ID。

MVP 不引入职责槽位、Model Pool 或任意工作流编排。未来只有在真实的质量、延迟、成本或隐私需求证明单模型配置不足时，再通过新的决策扩展 Profile 结构。ADR 0029 的三个固定职责槽位方案因此被取代。

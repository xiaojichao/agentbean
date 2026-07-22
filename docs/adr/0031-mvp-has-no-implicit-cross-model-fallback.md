---
status: accepted
---

# MVP 不进行隐式跨模型 Fallback

全局 Active PI Model 绑定的 PI Provider Card 与单一 Model ID 不可用时，系统只进行有限次数的同模型网络重试，不自动切换到其他 Provider 或模型。失败后系统进入明确的 `PI degraded` 状态：频道消息仍正常保存和展示，但自动建 Task、任务分解、认领和 Memory 写入暂停；Team 与普通用户只看到 PI 状态，不看到底层模型身份。

系统管理员可以将 Active PI Model 显式切换到另一张 Provider Card 或 Model ID，恢复后再处理允许重试的事项。该策略避免隐藏的模型切换突破数据或质量边界，也避免 PI 故障阻断基础频道通信；更复杂的模型池和 fallback 等真实需求出现后再设计。

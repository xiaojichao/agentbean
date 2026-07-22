---
status: accepted
---

# 全系统只有一个 Active PI Model

系统管理员从已发布 PI Provider Card 中选择一个 Model ID，形成全系统唯一的 Active PI Model。所有 Team 的频道实时协调、深度任务编排和 Memory 管理统一使用该模型，不能选择、覆盖或为自己配置 Provider。MVP 因此删除 PI Runtime Profile 产品概念以及 Team 侧所有模型选择入口。

Provider、Model、Endpoint、测试结果和切换历史只向系统管理员展示。Team 与普通用户只看到 PI 正常、降级或不可用，不获知底层模型身份。全局切换只影响新的消息协调和 ManagementRun，进行中的 Run 固定使用启动时的 Card revision；系统仍不进行隐式 fallback。该决定取代 ADR 0011、0030 与 0033 中的 Team Runtime Profile 模型。

---
status: accepted
---

# Agent Skill Exposure 由 Agent 主动上报且具有时效

PI 只根据 Agent 或其适配器主动发布的 Agent Exposure Manifest 判断其是否公开声明某个 Skill，而不是根据自然语言自述、PI 推断或内部扫描。Manifest 中的 Skill 使用稳定 ID，并记录公开契约版本、约束、可用状态和有效期。内部是否安装、如何实现、依赖哪些工具与权限，属于 Agent 自身边界，不向 PI 证明。历史执行成功只增强候选排序可信度，不能替 Agent 增加未声明的 Skill。

Agent 未暴露 Skill 维度、声明过期或无法得到当前响应时，PI 只能标记为“未声明”或“未知”，不能断言 Agent 内部缺失。系统与 Team 只治理 PI 是否可以向 Agent 请求具有高成本、敏感数据处理、外部副作用或不可逆结果的操作，不管理 Agent 内部 Skill。

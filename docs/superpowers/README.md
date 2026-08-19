# Superpowers 历史文档归档

`docs/superpowers/` 保存 AgentBean 早期使用 Superpowers 期间产生的设计、计划、研究、审计与原型材料。

**Superpowers 已从 AgentBean 开发环境物理卸载，不再是当前开发依赖，也不再作为项目工作流或 Skill 路由的一部分。**

保留本目录是为了避免破坏历史 Issue / PR / commit 链接，并为旧设计决策提供可追溯材料。

## 新内容不要写入本目录

新的工程材料按以下真相源落盘：

- 产品需求 / PRD / 状态 / 验收：GitHub Issues
- 领域语言和上下文边界：`CONTEXT.md`
- 架构决策与理由：`docs/adr/` 或相关 context 的局部 ADR
- 项目专属编码规范：`.trellis/spec/`
- 跨 Session / 跨 Coding Agent 临时执行上下文：`.trellis/tasks/` Execution Packet
- Harness 与 Agent 协作规则：`AGENTS.md`、`docs/agents/harness.md`

历史文档可以被引用和读取，但不要从其路径或旧 Superpowers 流程推断当前开发规则。当前规则始终以根目录 `AGENTS.md` 为准。

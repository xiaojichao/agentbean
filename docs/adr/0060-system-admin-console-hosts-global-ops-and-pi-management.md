---
status: accepted
---

# System Admin Console 承载全局运维与 PI 系统管理

系统管理员的全局运维入口收敛为 **System Admin Console**（产品入口仍可称「仪表盘」）：在保留应用左侧业务主导航的前提下，主区内使用中栏导航 + 右栏内容，路由为 `/{teamPath}/dashboard/{section}`（`teams` / `users` / `devices` / `agents` / `pi`）。列表数据为全系统范围，`teamPath` 仅为 Web 壳，不按当前 Team 过滤。

**PI Agent 管理**（PI Provider Supply、Active PI Model、系统作用域 System Knowledge 等）从设置一级 Tab 迁入 Console 的 `pi` section；设置中的「PI Agent」主入口移除，旧 `settings?tab=pi` 重定向到 `dashboard/pi`。Team 作用域 Memory 治理与 Team PI 自动协调仍留在 Team/设置路径，不并入全局 Console。

本决策 **supersede** [ADR 0028](./0028-pi-management-is-a-top-level-settings-area.md) 中「PI Management 是设置一级区域」的入口结论；系统作用域与 Team 作用域配置分离的原则不变，仅改变系统作用域的导航位置。

> 编号说明：父 PRD 曾草案写作 ADR 0059，但仓库内 `0059` 已用于 Manager 阶段推进决策；本决策正式编号为 **ADR 0060**。

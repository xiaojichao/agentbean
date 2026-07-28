---
status: accepted
---

# System Admin Console 承载全局运维与 PI / Memory / 执行记录

系统管理员的全局运维入口收敛为 **System Admin Console**（产品入口仍可称「仪表盘」）：在保留应用左侧业务主导航的前提下，主区内使用中栏导航 + 右栏内容，路由为 `/{teamPath}/dashboard/{section}`（`teams` / `users` / `devices` / `agents` / `pi` / `memory` / `runs`）。列表类 section 数据为全系统范围，`teamPath` 仅为 Web 壳；Memory 管理与执行记录诊断仍按当前 Team 壳加载数据，但入口仅对系统管理员可见。

**PI Agent 管理**（PI Provider Supply、Active PI Model、系统作用域 System Knowledge 等）从设置一级 Tab 迁入 Console 的 `pi` section；设置中的「PI Agent」主入口移除，旧 `settings?tab=pi` 重定向到 `dashboard/pi`。

**Memory 管理**与**执行记录诊断**从设置一级 Tab 迁入 Console 的 `memory` / `runs` section；旧 `settings?tab=memory` / `settings?tab=runs` 对管理员重定向到对应仪表盘 section，对非管理员回退设置默认页。Team PI 自动协调（Team 设置内的 PI 策略与覆盖）仍留在 Team/设置路径。个人 User Memory 仍在账号设置。

本决策 **supersede** [ADR 0028](./0028-pi-management-is-a-top-level-settings-area.md) 中「PI Management 是设置一级区域」的入口结论；系统作用域与 Team 作用域配置分离的原则不变，仅改变系统级/运维入口的导航位置。

> 编号说明：父 PRD 曾草案写作 ADR 0059，但仓库内 `0059` 已用于 Manager 阶段推进决策；本决策正式编号为 **ADR 0060**。

---
title: AgentBean Team Daemon Profile Isolation
date: 2026-05-29
updated: 2026-07-10
status: superseded-and-implemented
superseded_by:
  - 2026-05-09-agentbean-prd.md
  - 2026-07-10-agentbean-pi-management-agent-design.md
---

# Team Device Profile 隔离结论

本文原始版本记录了旧 daemon/server 实现下的迁移推导，其中的旧字段、表名和源码路径已不再构成当前合同。为避免把历史实现机械改写成不存在的 Team 字段，原始内容只保留在 Git history；当前行为以 `apps/daemon-next`、主 PRD 与 PI 管理 Agent 设计为准。

## 当前 canonical 结论

- AgentBean 只有 Team 一种协作容器。
- 一个 saved profile 绑定一个 Team identity、一个 device credential 与一组本地状态。
- `--all-profiles` 可以并发启动多个 profile，但每个 runtime instance 仍只以自己的 `teamId` 建立连接。
- profile 根目录是 `~/.agentbean/teams/{profileId}/`；auth、scan cache 与本地配置不能跨 profile 共用。
- Device identity 包含 `deviceId`，并可带 `machineId/profileId`；Server 以 Device record 解析归属 Team。
- Device-bound 的 get、scan、select-directory、delete、rename 只发送 `deviceId`；Team-scoped list/Agent 查询显式发送 `teamId`。
- 自定义 Agent 执行、workspace、附件与产物必须使用当前 profile 的 device-bound credential。
- `visibleTeamIds` 是 Agent 可见性，不是本地 profile 隔离机制。

## 安全边界

- token、scan cache、Agent 配置、workspace 和日志必须按 profile 隔离。
- 目录选择必须发给 owning Device，不能默认在浏览器所在机器执行。
- Team owner/admin 不能自动管理其他成员的 Device；Device owner 或系统 admin 才能执行管理操作。
- reconnect 后必须重新上报 Device、runtime 与最近一次成功 scan snapshot。

## 当前证据

- `apps/daemon-next/src/profile-paths.ts`
- `apps/daemon-next/src/auth-store.ts`
- `apps/daemon-next/src/cli.ts`
- `apps/daemon-next/tests/auth-store.test.ts`
- `apps/daemon-next/tests/cli.test.ts`
- `apps/daemon-next/tests/protocol-client.test.ts`
- `apps/server-next/tests/device-management.test.ts`
- `agentbean-next/docs/verification-matrix.md`

需要回看早期方案、被否决替代或旧源码字段时，应通过本文件的 Git history 阅读，不把那些 identifier 恢复到活动产品文档。

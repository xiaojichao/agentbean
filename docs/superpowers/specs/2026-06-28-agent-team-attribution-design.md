# Agent Team 归属：当前结论

- 日期：2026-06-28
- 更新：2026-07-10
- 状态：已实现；原始重构推导由 Git history 保存

## 产品合同

- AgentOS 托管型 Agent 与自定义 Agent 是 Team 成员型 Agent。
- executor runtime 只是 Device 能力；扫描结果为自定义 Agent 创建提供参数，不建立稳定 Agent identity。
- Agent 使用 `primaryTeamId` 表示稳定归属，使用 `visibleTeamIds` 表示当前可见 Team。
- Server 与 Web 直接消费 canonical DTO，不派生第二套空间字段。
- 设备详情只提供当前 Team 可见性控制，不提供多 Team 选择对话框。
- `visibleTeamIds = []` 表示从当前 Team 移出；重新可见时恢复为包含 `primaryTeamId`。
- 可见性变化同步影响成员列表、DM/Task 权限与默认 Channel membership。
- Device 详情按 `deviceId` 仍可展示被移出 Team 成员列表的 Device-owned Agent，便于重新启用。

## 创建与扫描边界

- AgentOS 扫描结果由 Server ingest 自动注册，不调用自定义 Agent create。
- 自定义 Agent create 必须显式提供 `teamId` 与 `deviceId`。
- 同一 executor runtime 可以创建多个自定义 Agent；Web 不从名称、command、cwd 或 adapter 推断既有 Agent。

## 证据

- `packages/contracts/src/agent.ts`
- `apps/server-next/src/application/usecases.ts`
- `apps/server-next/tests/agent-team-visibility.test.ts`
- `apps/server-next/tests/device-agent-ownership.test.ts`
- `apps/web-next/tests/agent-registration-modal.test.ts`
- `agentbean-next/docs/parity-backfill-audit.md`

被移除的 UI identifier、旧 DTO projection 与多 Team 方案只在 Git history 中保留。

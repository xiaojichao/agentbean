# 第七切片实现状态

本文记录 AgentBean Next 第七切片当前已经落地的 channel member details DTO 边界。

## 已实现

- `packages/contracts`
  - 增加 `ChannelMembersDto`，同时保留 `humanMemberIds` / `agentMemberIds` 兼容字段，并补充 `humans` / `agents` 详情列表。
- `apps/server-next`
  - `listChannelMembers` use case 返回 `ChannelMembersDto`。
  - In-memory repository 支持按 channel human member ids 投影 `HumanMemberDto`。
  - SQLite repository 支持从 `team_members` 与 `users` 投影 `HumanMemberDto`，并保持输入 id 顺序。
  - Agent details 复用现有 agent repository，并只返回对 team 可见的 agent projection。

## 已验证

覆盖范围：

- Creator 添加 human 与 agent member 后，`channel:members` 同时返回 id 列表与详情 DTO。
- SQLite repository suite 覆盖 human/agent member details 持久化投影。
- Shared contract fixture 覆盖 `ChannelMembersDto` 的 transport shape。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第七切片：

- 成员弹窗 UI shell 与组件渲染。
- 成员变更后的实时 snapshot broadcast。
- Channel leave/archive/delete。

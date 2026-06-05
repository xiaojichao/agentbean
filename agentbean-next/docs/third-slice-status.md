# 第三切片实现状态

本文记录 AgentBean Next 第三切片当前已经落地的 channel membership 边界。

## 已实现

- `packages/contracts`
  - 增加 `ChannelHumanMemberCommandDto`、`ChannelAgentMemberCommandDto` 与 `ListChannelMembersCommandDto`。
  - 继续复用 `channel:add-member`、`channel:remove-member`、`channel:add-agent`、`channel:remove-agent` 与 `channel:members` socket event constants。
- `apps/server-next`
  - `addChannelHumanMember` / `removeChannelHumanMember` use cases。
  - `addChannelAgentMember` / `removeChannelAgentMember` use cases。
  - `listChannelMembers` use case。
  - In-memory 与 SQLite repositories 支持真实 membership state mutation。
  - 移除 private channel human member 后，`listChannels` 会立即反映可见性回收。
  - `/web` socket handler 绑定 channel membership commands。
- `apps/web-next`
  - Web socket client 暴露 channel human/agent member add/remove 与 member list commands。

## 已验证

覆盖范围：

- Creator 可以添加 human member，并让 private channel 对该 member 可见。
- Creator 可以移除 human member，并真实回收 private channel 可见性。
- 非 creator 不能添加 agent member。
- Creator 可以添加/移除 agent member。
- `channel:members` 返回 channel 的 human/agent member id 列表；第七切片已在此基础上补充详情 DTO。
- SQLite membership 表会持久化 add/remove 后的真实状态。
- Web socket client 与 server socket handlers 的 channel membership 协议路径。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第三切片：

- 成员弹窗 UI shell 与组件渲染。
- Channel leave/archive/delete。
- DM thread 创建与 agent DM。
- 成员变更后的实时 snapshot broadcast。

# 第八切片实现状态

本文记录 AgentBean Next 第八切片当前已经落地的 channel snapshot subscription broadcast 边界。

## 已实现

- `apps/server-next`
  - `/web` namespace 支持 `channels:subscribe`。
  - Subscribe 成功后，server 会立即向当前 socket 发送 `channels:snapshot`。
  - Server 为每个 web socket 记录 active `{ userId, teamId }` channel subscription。
  - `channel:add-member`、`channel:remove-member`、`channel:add-agent` 与 `channel:remove-agent` 成功后，会刷新同 team active subscribers 的 channel snapshots。
  - Snapshot refresh 会逐个 subscriber 调用 `listChannels`，因此 private channel visibility 仍由 server use case 决定，不向整个 team 广播同一份 channel list。

## 已验证

覆盖范围：

- 真实 Socket.IO `/web` clients 可以调用 `channels:subscribe` 并收到初始 `channels:snapshot`。
- Creator 把 human member 加入 private channel 后，新 member 的 subscribed socket 收到包含该 channel 的 snapshot。
- Creator 移除 human member 后，被移除 member 的 subscribed socket 收到不再包含该 private channel 的 snapshot。
- Owner subscriber 在 membership 变更后继续收到自己有权看到的完整 channel list。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第八切片：

- `agents:subscribe` 的 server-side initial snapshot 与 agent status broadcast；第九切片已补齐。
- 成员弹窗 UI shell 与组件渲染。
- Channel leave/archive/delete。

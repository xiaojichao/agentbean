# 第九切片实现状态

本文记录 AgentBean Next 第九切片当前已经落地的 agent snapshot subscription broadcast 边界。

## 已实现

- `apps/server-next`
  - `/web` namespace 支持 `agents:subscribe`。
  - Subscribe 成功前，server 会通过 team membership 检查确认订阅者有权访问该 team。
  - Subscribe 成功后，server 会立即向当前 socket 发送 `agents:snapshot`。
  - Server 为每个 web socket 记录 active `{ userId, teamId }` agent subscription。
  - Daemon `agent:register-batch` 成功后，会刷新同 team active subscribers 的 visible agent snapshot。
  - `dispatch:result` / `dispatch:error` 更新 agent status 后，也会刷新同 team active subscribers 的 visible agent snapshot。

## 已验证

覆盖范围：

- 真实 Socket.IO `/web` client 可以调用 `agents:subscribe` 并收到初始空 `agents:snapshot`。
- Daemon 上报 agent batch 后，已订阅 web socket 收到 online agent snapshot。
- Daemon 后续上报空 agent batch 触发 missing scanned agent offline 后，已订阅 web socket 收到 offline agent snapshot。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第九切片：

- 成员弹窗 UI shell 与组件渲染。
- Device status/runtimes 的 server-side web subscription broadcast。
- Channel leave/archive/delete。

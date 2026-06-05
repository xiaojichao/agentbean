# 第十切片实现状态

本文记录 AgentBean Next 第十切片当前已经落地的 device snapshot 与 runtimes broadcast 边界。

## 已实现

- `apps/server-next`
  - 增加 `listDevices` use case。
  - In-memory 与 SQLite device repositories 支持按 team 列出 devices。
  - `/web` namespace 支持 `device:list`，并把它作为 device snapshot subscription 入口。
  - `device:list` 成功前，server 会通过 team membership 检查确认订阅者有权访问该 team。
  - `device:list` 成功后，server 会立即向当前 socket 发送 `devices:snapshot`。
  - Daemon `device:hello` 成功后，会刷新同 team active subscribers 的 `devices:snapshot`。
  - Daemon `device:runtimes` 成功后，会向同 team active subscribers 发送 `device:runtimes`。
- `apps/web-next`
  - Web socket client 支持 `device:list`。
  - Web socket client 支持接收 `devices:snapshot` 与 `device:runtimes`。
  - Reconnect 后会重新发送 active `device:list`。

## 已验证

覆盖范围：

- 真实 Socket.IO `/web` client 可以调用 `device:list` 并收到初始空 `devices:snapshot`。
- Daemon `device:hello` 后，已订阅 web socket 收到 online device snapshot。
- Daemon `device:runtimes` 后，已订阅 web socket 收到 runtimes payload。
- Web socket client 会发送 `device:list`、接收 `devices:snapshot` / `device:runtimes`，并在 reconnect 后重新发送 active device list。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第十切片：

- `device:get` detail shell。
- `device:scan` 请求路由到 daemon。
- 成员弹窗 UI shell 与组件渲染。
- Channel leave/archive/delete。

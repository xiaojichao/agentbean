# 第十三切片实现状态

本文记录 AgentBean Next 第十三切片当前已经落地的 daemon rescan command 边界。

## 已实现

- `apps/daemon-next`
  - Protocol client 启动后会监听 `device:scan-requested`。
  - 启动与 reconnect 后会记住 server `device:hello` ack 返回的当前 `deviceId`。
  - 收到匹配当前 `deviceId` 的 `device:scan-requested` 后，会调用可注入的 scan provider。
  - scan provider 返回新的 runtimes 与 agents 后，daemon-next 会重新发送 `device:runtimes` 与 `agent:register-batch`。
  - 收到不匹配当前 `deviceId` 的 scan request 时，不触发扫描，也不重新上报。
  - 未提供 scan provider 时，会重新上报启动时传入的 runtimes 与 agents snapshot。

## 已验证

覆盖范围：

- Daemon-next 收到匹配当前 device 的 `device:scan-requested` 后，会重新发送 fresh runtimes 与 agents。
- Scan provider 会被调用一次。
- 不匹配当前 device 的 request 不会触发 provider，也不会产生额外上报。
- 既有启动 announce、reconnect announce、dispatch success/error 与 custom env 边界继续通过。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第十三切片：

- 把真实 runtime scanner / agent discovery scanner 接入 daemon-next CLI。
- 成员弹窗 UI shell 与组件渲染。
- Channel leave/archive/delete。

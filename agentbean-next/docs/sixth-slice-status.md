# 第六切片实现状态

本文记录 AgentBean Next 第六切片当前已经落地的 web reconnect resubscription 边界。

## 已实现

- `apps/web-next`
  - Web socket client 在初始化时监听 transport `connect` 事件。
  - Web socket client 会记录当前 active `agents:subscribe` 与 `channels:subscribe` 输入。
  - Reconnect 后会重新发送 active agent/channel subscriptions。
  - 重复调用 `subscribeAgents` / `subscribeChannels` 只替换 active subscription 与 snapshot callback，不重复注册 snapshot handler。
  - Snapshot 处理仍然只接收 server projection，不在 web 侧执行 dedupe、visibility 或 permission 判断。

## 已验证

覆盖范围：

- 初次订阅仍发送 documented `agents:subscribe` 与 `channels:subscribe` events。
- Reconnect 后重新发送 active subscriptions。
- Reconnect 不重复注册 snapshot handlers。
- 切换 active subscription 后，reconnect 使用最新输入。
- Snapshot callback 使用最新 active handler。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第六切片：

- 浏览器 UI shell 与组件渲染。
- Socket.IO 真实 browser runtime 的 backoff、disconnect reason 与 auth refresh 策略。
- 多 team 同时订阅；当前 web-next client 只维护当前 active team 的 agent/channel subscriptions。
- Human/agent member 详情 DTO 与成员弹窗 UI。

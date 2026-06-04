# 第五切片实现状态

本文记录 AgentBean Next 第五切片当前已经落地的 web realtime boundary。

## 已实现

- `apps/web-next`
  - Web socket client 支持 `agents:subscribe` 与 `channels:subscribe`。
  - Web socket client 支持接收 `agents:snapshot`、`channels:snapshot`、`channel:message` 与 `message:dispatch-status`。
  - Agent snapshot 与 channel snapshot 仍然是 full replacement，不在 web 侧执行 dedupe、visibility 或 permission 判断。
  - Conversation message reducer 只追加 server event。
  - Dispatch status reducer 按 `dispatch.id` 替换已有状态；未知 dispatch status 会追加到列表末尾。

## 已验证

覆盖范围：

- Web client 继续使用 first-slice command event names。
- Web client 订阅 agent/channel snapshot，并将 payload 交给调用方。
- Web client 监听 channel message 与 dispatch status realtime events。
- Session store 仍只持久化 token 与 current team。
- Snapshot reducer 不做本地 dedupe。
- Message composer payload 不包含 sender identity。
- Dispatch status update 不重排无关状态。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第五切片：

- 浏览器 UI shell 与组件渲染。
- Reconnect 后自动重新调用所有 subscriptions 的连接管理器；当前只冻结 client API 与 snapshot replacement reducer。
- Human/agent member 详情 DTO 与成员弹窗 UI。
- Permission、channel visibility 或 agent dedupe 的 web-side fallback；这些仍由 server/domain 拥有。

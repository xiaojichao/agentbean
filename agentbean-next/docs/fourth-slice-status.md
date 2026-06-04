# 第四切片实现状态

本文记录 AgentBean Next 第四切片当前已经落地的 daemon protocol hardening 边界。

## 已实现

- `apps/daemon-next`
  - Protocol client 在启动时继续发送 `device:hello`、`device:runtimes` 与 `agent:register-batch`。
  - Protocol client 支持可选 `onReconnect` hook；重连后重新发送 device hello、runtime snapshot 与 agent batch。
  - Dispatch executor 成功时发送 `dispatch:result`。
  - Dispatch executor 失败时发送 `dispatch:error`，并保留稳定的 dispatch/agent identity。
  - `DispatchRequestPayload` 支持 `customAgent` 配置；raw `customAgent.env` 只存在于被选中 dispatch request 进入 executor 的路径中。

## 已验证

覆盖范围：

- Daemon 启动时宣布 device、runtimes 与 agents。
- Daemon reconnect 后重新宣布 device、runtimes 与 agents。
- Stub executor 成功结果转换为 `dispatch:result`。
- Executor failure 转换为 `dispatch:error`。
- Raw custom agent env 不出现在 device/runtime/agent announce payload 中，只进入被选中的 dispatch executor request。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第四切片：

- 真实 adapter execution 迁移。
- Dispatch cancellation。
- Heartbeat interval、offline timeout 与 periodic scan interval。
- Server-issued secret reference 或 daemon-local secret storage；第一切片仍只允许 raw env 出现在单个 dispatch request 中。
- Browser UI shell 与组件渲染。

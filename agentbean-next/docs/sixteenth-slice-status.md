# 第十六切片实现状态

本文记录 AgentBean Next 第十六切片当前已经落地的 custom agent preview flow 边界。

## 已实现

- `packages/contracts`
  - 增加 `CreateAgentCommandDto`，用于 web client 发起 `agent:create`。
- `apps/server-next`
  - 增加 `createCustomAgent` use case。
  - `agent:create` 会校验 `userId` 是目标 team member。
  - `agent:create` 会校验目标 device 属于同一 team，且 device 当前 online。
  - 如果提供 `runtimeId`，该 runtime 必须属于同一 device/team 且 `installed: true`。
  - 创建出的 visible product agent 使用 `source: "custom"`、`category: "executor-hosted"`。
  - Public `AgentDto` 只返回 `envKeys`，不会在 ack 或 snapshot 中暴露 raw `env` values。
  - `/web` socket 已绑定 `agent:create`，成功后刷新 active `agents:snapshot` subscribers。
- `apps/web-next`
  - `createWebSocketClient` 增加 `createAgent(input)`。
- Preview smoke
  - 新增本地 preview 命令：

```bash
npm run preview:agentbean-next
```

该命令会启动本地 Socket.IO server，连接 web-like client 与 daemon-like client，执行：

```text
register -> daemon hello -> runtime report -> agent:create -> message:send -> dispatch:result -> agent reply persisted
```

## 已验证

覆盖范围：

- `agent:create` use case 可以从 installed runtime 创建 visible custom agent。
- Raw env value 不出现在 ack、snapshot 或 JSON 化结果中。
- Web socket handler 会转发 `agent:create` 并刷新 `agents:snapshot`。
- Web client 会发出 `WEB_EVENTS.agent.create`。
- Preview smoke 证明本地 server/web/daemon socket clients 可以真实收发消息。

本地命令：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
```

## 暂未实现

这些不属于第十六切片：

- Browser UI form：device runtime picker、agent name/env editor、create button。
- 长驻 server-next dev server 与 web-next 可视化页面。
- Agent update/delete/publish/unpublish 的完整管理流。

后续第十七切片已补上 raw custom agent env 的 dispatch-only transport、按 device 定向投递，以及真实 daemon-next CLI 入口。

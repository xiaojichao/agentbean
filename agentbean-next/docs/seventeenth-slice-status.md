# 第十七切片实现状态

本文记录 AgentBean Next 第十七切片当前已经落地的 daemon-next CLI 与 dispatch-only secret transport 边界。

## 已实现

- `packages/contracts`
  - `DispatchRequestDto` 增加 `deviceId`，作为 server 定向投递 dispatch 的 target hint。
  - `DispatchCustomAgentDto` 补齐 `id`、`name`、`args` 与 dispatch-only `env`。
- `apps/server-next`
  - custom agent 创建时，public `AgentDto` 仍只返回 `envKeys`。
  - repository 内部保存 custom agent raw env，供 dispatch-only path 使用。
  - 增加内部 `getDispatchRequest` use case，从 dispatch + agent + private execution config 生成 daemon request。
  - `message:send` 后不再由 socket handler 手拼 dispatch request，而是通过 use case hydrate。
  - 如果 dispatch request 带 `deviceId`，server 只向对应 daemon socket 发送 `dispatch:request`。
  - raw `customAgent.env` 不会进入 web ack、web snapshot，也不会广播给其他 daemon sockets。
- `apps/daemon-next`
  - 增加 `createCommandExecutor`。
  - custom dispatch 带 `customAgent.command` 时，daemon-next 会以 stdin 写入 prompt，并按 `args`、`cwd` 与 dispatch-only `env` 启动子进程。
  - 没有 custom command 时，executor 保留 deterministic stub reply，便于 preview 与测试。
  - 增加 Socket.IO bridge，把 real Socket.IO client 包装成 daemon protocol socket，并正确区分首次 connect 与 reconnect。
  - 增加 CLI config parser，支持通过 env 或 args 指定 `serverUrl`、`teamId`、`ownerId`、`machineId`、`profileId` 与 fallback prefix。
  - 增加 `agentbean-next-daemon` build 后入口。

## 已验证

覆盖范围：

- Use case 级验证：`createCustomAgent -> sendMessage -> getDispatchRequest` 会把 private env 放入 dispatch request，同时 public agent list 只暴露 `envKeys`。
- Socket 级验证：custom agent dispatch secret 只发送给拥有目标 `deviceId` 的 daemon socket，不发送给其他 daemon socket。
- Daemon 级验证：custom command executor 会把 prompt 写入 stdin，并传递 `args`、`cwd` 与 dispatch-only env。
- CLI 级验证：配置解析与 Socket.IO reconnect bridge 行为稳定。

本地命令：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
git diff --check
```

## 暂未实现

这些不属于第十七切片：

- Browser UI form：device runtime picker、agent name/env editor、create button。
- 长驻 server-next dev server 与 web-next 可视化页面。
- 真实 Codex/Claude/Gemini adapter 的交互式协议适配；当前 custom command executor 适合非交互式 wrapper 或脚本。
- Server-issued secret reference 或 daemon-local secret storage；当前仍是第一切片允许的 dispatch-only raw env transport。
- Agent update/delete/publish/unpublish 的完整管理流。

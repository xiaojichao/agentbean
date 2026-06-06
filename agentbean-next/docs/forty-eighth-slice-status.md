# 第四十八切片：SQLite 重启持久化 Smoke

本文记录 AgentBean Next 第四十八切片新增的 SQLite restart persistence smoke。

## 背景

第四十六切片已经证明公开入口能访问，第四十七切片已经证明业务链路能真实注册、连接 daemon、创建 custom agent、发送消息并收到 agent reply。

真正替换旧 AgentBean 之前，还需要证明 server-next 使用 SQLite 文件模式时，进程重启不会丢失最基础的产品状态。因此，本切片把 session、current team、channel 与 message history 的重启恢复路径脚本化。

## 已完成

- 新增 `scripts/smoke-agentbean-next-persistence.mjs`。
  - 默认创建临时 SQLite data dir。
  - 第一次启动 server-next，注册临时用户/team/default channel。
  - 写入一条 human message。
  - 关闭 server-next。
  - 使用同一个 data dir 第二次启动 server-next。
  - 通过 `auth:whoami` 验证 token session 与 current team 可恢复。
  - 通过 `channel:join` 验证 channel/message history 可恢复。
- 新增根命令：

```bash
npm run smoke:agentbean-next-persistence
```

- `WEB_EVENTS.channel.join` 已接入 server-next socket handler。
  - handler 先调用 `listChannels({ userId, teamId })` 做 team/member 可见性校验。
  - 只对当前用户可见的 channel 返回 metadata 与 `listChannelMessages` 历史消息。
- readiness checker 新增 `persistence-smoke-script` 静态检查，确保 persistence smoke 命令与 cutover runbook 步骤不会消失。
- `production-cutover-runbook.md` 区分了本地 SQLite restart smoke 与 final flip 后的 Railway volume 复核。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/persistence-smoke-script.test.ts tests/persistence-smoke.test.ts tests/socket-handlers.test.ts
```

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未在 production host 上运行 `smoke:agentbean-next-entry` 与 `smoke:agentbean-next-business`。
- 尚未在 Railway production volume 上完成重启后 session/team/channel/message 复核；本切片只证明同一 SQLite data dir 的本地 restart 路径。

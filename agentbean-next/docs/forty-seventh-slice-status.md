# 第四十七切片：业务链路 Smoke

本文记录 AgentBean Next 第四十七切片新增的 business smoke。

## 背景

第四十六切片已经把公开入口 smoke 脚本化，可以确认生产 URL 返回的是 AgentBean Next 页面与 Socket.IO client route。但真正替换旧 AgentBean 还需要证明业务链路可用，而不只是页面可访问。

因此，本切片新增一个无需浏览器的 Socket.IO business smoke：它直接跑通注册、daemon、custom agent、消息 dispatch 与 agent reply。

## 已完成

- 新增 `scripts/smoke-agentbean-next-business.mjs`。
  - 通过 `--url` 或 `AGENTBEAN_NEXT_ENTRY_URL` 指定目标入口。
  - 连接 `/web` 与 `/agent` Socket.IO namespaces。
  - 注册临时 smoke 用户与临时 team。
  - daemon socket 上报在线 device 与 runtime。
  - web socket 基于该 runtime 创建 custom agent。
  - 发送 `@AgentName hello` 消息。
  - daemon 收到 dispatch 后回写 `business-smoke:<prompt>`。
  - web socket 等待 `channel:message` 中出现 agent reply。
- 新增根命令：

```bash
npm run smoke:agentbean-next-business
```

- readiness checker 新增 `business-smoke-script` 静态检查，确保业务 smoke 命令和 runbook 步骤不会消失。
- 新增 `apps/server-next/tests/business-smoke.test.ts`，使用真实 `server-next` dev server 与真实 Socket.IO client 验证 business smoke。
- `production-cutover-runbook.md` 增加 final flip 后的 business smoke 步骤。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_ENTRY_URL=http://127.0.0.1:4110 npm run smoke:agentbean-next-business
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
```

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未在 production host 上运行 `smoke:agentbean-next-entry` 与 `smoke:agentbean-next-business`。
- 尚未完成真实浏览器 smoke 与 SQLite volume 重启持久化复核。


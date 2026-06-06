# 第四十六切片：公开入口 Smoke

本文记录 AgentBean Next 第四十六切片新增的 public entry smoke。

## 背景

AgentBean Next 已经具备本地 preview、npm 发布、Railway env sync 与 Railway preflight 证据。但真正替换旧 AgentBean 时还有一个容易误判的风险：公开访问入口可能仍然指向旧 Vercel web，或者返回早期 `AgentBean Next Preview` harness，而不是现在的 AgentBean Next 产品 preview shell。

因此，本切片把“公开入口是不是 AgentBean Next”从人工目测改为可运行 smoke。

## 已完成

- 新增 `scripts/smoke-agentbean-next-entry.mjs`。
  - 通过 `--url` 或 `AGENTBEAN_NEXT_ENTRY_URL` 指定目标入口。
  - 检查 `/healthz` 是否返回 `ok: true` 与 `service: "agentbean-next-server"`。
  - 检查根页面 HTML 是否包含：
    - `<title>AgentBean</title>`
    - `私有 Agent 团队`
    - `team-switcher`
    - `添加自定义 Agent`
  - 检查根页面 HTML 不再包含：
    - `AgentBean Next Preview`
    - `Next local`
  - 检查 `/socket.io/socket.io.js` 可访问，确保 web session 的 realtime client route 存在。
- 新增根命令：

```bash
npm run smoke:agentbean-next-entry
```

- readiness checker 新增 `entry-smoke-script` 静态检查，确保入口 smoke 命令和 runbook 说明不会消失。
- 新增 `apps/server-next/tests/entry-smoke.test.ts`。
  - 覆盖入口正确时通过。
  - 覆盖根页面仍是 harness/旧入口时失败。
  - 覆盖缺少目标 URL 时给出明确失败。
- 修正根目录 workspace test scripts，使 `npm run test:server-next` 等命令先进入对应 workspace 再运行 Vitest，避免 config root 与 CLI test path 叠加后找不到测试文件。
- `production-cutover-runbook.md` 增加 final flip 后的 entry smoke 步骤。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH node apps/server/node_modules/vitest/vitest.mjs run apps/server-next/tests/entry-smoke.test.ts apps/server-next/tests/readiness-check.test.ts --environment node --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_ENTRY_URL=http://127.0.0.1:4110 npm run smoke:agentbean-next-entry
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:contracts -- --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:domain -- --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:daemon-next -- --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:web-next -- --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
```

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未在 production host 上运行 `smoke:agentbean-next-entry`。
- 尚未完成真实浏览器 business smoke：登录、current team 恢复、custom agent 创建、daemon-next 连接、消息发送、agent reply 可见。

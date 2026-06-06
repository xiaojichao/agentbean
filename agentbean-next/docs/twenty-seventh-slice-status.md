# 第二十七切片实现状态

本文记录 AgentBean Next 第二十七切片当前已经落地的 production session secret guard。

## 已实现

- `apps/server-next`
  - `ServerNextDevConfig` 增加 `sessionSecret`。
  - `parseServerNextDevConfig` 支持 `AGENTBEAN_NEXT_SESSION_SECRET` 与 `--session-secret`。
  - 平台式启动存在 `PORT` 时，缺少 session secret 会直接报错。
  - 本地开发未设置 `PORT` 时继续使用 dev fallback secret。
  - memory 与 SQLite app 创建都会把 session secret 传给 use cases。
- `apps/server-next/src/full-preview.ts`
  - full preview 解析并传递 session secret。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 production session secret guard 检查项。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/dev-server.test.ts tests/full-preview.test.ts --config vitest.config.ts --api.host 127.0.0.1
```

## 暂未实现

这些不属于第二十七切片：

- 在 Railway production 上设置 `AGENTBEAN_NEXT_SESSION_SECRET`。
- token expiry、logout/revoke 与 secret rotation。
- 将 `AGENTBEAN_DEPLOY_TARGET` 实际切到 `next`。

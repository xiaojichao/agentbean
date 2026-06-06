# 第二十八切片实现状态

本文记录 AgentBean Next 第二十八切片当前已经落地的 production SQLite data dir guard。

## 已实现

- `apps/server-next`
  - `parseServerNextDevConfig` 区分显式配置的 data dir 与本地开发 fallback data dir。
  - 平台式启动存在 `PORT` 且 storage 为 SQLite 时，缺少 `AGENTBEAN_NEXT_DATA_DIR` 或 `--data-dir` 会直接报错。
  - 本地开发未设置 `PORT` 时继续允许默认 `.agentbean-next` data dir。
  - 显式选择 memory storage 的平台式启动不要求 SQLite data dir。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P2-25` production SQLite data dir guard 检查项。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/dev-server.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_HOST=127.0.0.1 PORT=0 AGENTBEAN_NEXT_SESSION_SECRET=production-smoke-secret AGENTBEAN_NEXT_DATA_DIR=/private/tmp/agentbean-next-data-dir-guard-smoke npm run start:server-next
```

production-style smoke 启动后，`/healthz` 返回：

```json
{"ok":true,"service":"agentbean-next-server"}
```

## 暂未实现

这些不属于第二十八切片：

- 在 Railway production 上创建或绑定实际持久化 volume。
- 设置真实 production `AGENTBEAN_NEXT_DATA_DIR`。
- 将 `AGENTBEAN_DEPLOY_TARGET` 实际切到 `next`。

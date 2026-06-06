# 第三十一切片实现状态

本文记录 AgentBean Next 第三十一切片当前已经落地的 root Railway deploy config。

## 已实现

- 根 `railway.json`
  - 使用 `RAILPACK` builder。
  - 显式声明 build command 为 `npm run build`。
  - 显式声明 start command 为 `npm start`。
  - 显式声明 healthcheck path 为 `/healthz`。
  - 保留旧 server 当前使用的 healthcheck timeout 与 restart policy。
- `.github/workflows/ci-cd.yml`
  - `Validate AgentBean Next` 的路径检测纳入根 `railway.json`。
  - 以后仅修改 root deploy config 也会触发 AgentBean Next validation。
- `apps/server-next/tests/deploy-config.test.ts`
  - 锁住 root Railway build、start 与 healthcheck 配置。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P2-26` root Railway deploy config 检查项。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/deploy-config.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
```

## 暂未实现

这些不属于第三十一切片：

- 在 Railway production 上设置 `AGENTBEAN_NEXT_SESSION_SECRET`。
- 在 Railway production 上绑定持久化 volume 并设置真实 `AGENTBEAN_NEXT_DATA_DIR`。
- 将 GitHub 仓库变量 `AGENTBEAN_DEPLOY_TARGET` 设置为 `next`。

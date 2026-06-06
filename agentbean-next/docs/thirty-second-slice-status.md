# 第三十二切片实现状态

本文记录 AgentBean Next 第三十二切片当前已经落地的 production readiness checker。

## 已实现

- `scripts/check-agentbean-next-readiness.mjs`
  - 默认模式检查仓库内静态部署契约。
  - `--production` 模式额外检查真正替换旧 AgentBean 前必须显式具备的生产配置。
  - 支持纯函数 `collectAgentBeanNextReadinessChecks` 与 `summarizeReadiness`，便于测试复用。
  - 检查 root `package.json` build/start scripts。
  - 检查 root `railway.json` build/start/healthcheck。
  - 检查 CI deploy target gate 仍保留 `old|next`。
  - 检查 CI AgentBean Next change detection 覆盖 root `railway.json`。
  - production 模式检查 `AGENTBEAN_DEPLOY_TARGET=next`、`RAILWAY_TOKEN`、`AGENTBEAN_NEXT_SESSION_SECRET` 与 `AGENTBEAN_NEXT_DATA_DIR`。
- 根 `package.json`
  - 新增 `check:agentbean-next-readiness`。
- `apps/server-next/tests/readiness-check.test.ts`
  - 覆盖静态 readiness 通过。
  - 覆盖 production readiness 在缺少 flip/env 配置时失败。
  - 覆盖 production readiness 在部署目标与生产 env 显式配置时通过。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P2-27` production readiness checker 检查项。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/readiness-check.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness -- --production
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_DEPLOY_TARGET=next RAILWAY_TOKEN=dummy AGENTBEAN_NEXT_SESSION_SECRET=dummy-secret AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next npm run check:agentbean-next-readiness -- --production
```

默认 readiness 当前通过 6/6。

production readiness 当前失败 5/11，失败项为：

- `production-deploy-target-next`
- `railway-token-present`
- `production-session-secret-present`
- `production-data-dir-present`
- `production-data-dir-not-default`

这些失败项符合预期：它们表示尚未执行真正 production flip，也尚未在当前本地环境注入 production deploy/runtime env。

显式提供目标变量时，production readiness 通过 11/11。

## 暂未实现

这些不属于第三十二切片：

- 写入 GitHub 仓库变量 `AGENTBEAN_DEPLOY_TARGET=next`。
- 在 Railway production 上设置 `AGENTBEAN_NEXT_SESSION_SECRET`。
- 在 Railway production 上绑定持久化 volume 并设置真实 `AGENTBEAN_NEXT_DATA_DIR`。
- 执行 production deploy flip。

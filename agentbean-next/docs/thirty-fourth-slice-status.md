# 第三十四切片实现状态

本文记录 AgentBean Next 第三十四切片当前已经落地的 production deploy preflight gate。

## 已实现

- `.github/workflows/ci-cd.yml`
  - 在 `Deploy production` job 中新增 `Run AgentBean Next production readiness checks`。
  - 该 step 只在 `RAILWAY_TOKEN` 存在且 `AGENTBEAN_DEPLOY_TARGET == 'next'` 时运行。
  - 该 step 位于 Railway CLI 安装与 `railway up` 之前。
  - 该 step 运行 `npm run check:agentbean-next-readiness -- --production`。
  - 该 step 从 GitHub Actions 配置读取：
    - `secrets.AGENTBEAN_NEXT_SESSION_SECRET`
    - `vars.AGENTBEAN_NEXT_DATA_DIR`
- `scripts/check-agentbean-next-readiness.mjs`
  - 新增 `ci-runs-production-readiness-before-next-deploy` 静态检查项。
  - 默认 readiness 现在会确认 deploy job 存在 production preflight gate。
  - production readiness 继续检查 `AGENTBEAN_DEPLOY_TARGET=next`、`RAILWAY_TOKEN`、`AGENTBEAN_NEXT_SESSION_SECRET` 与 `AGENTBEAN_NEXT_DATA_DIR`。
- `apps/server-next/tests/readiness-check.test.ts`
  - 更新静态 readiness check id 列表，覆盖新的 production deploy preflight gate。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P2-29`。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/readiness-check.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness -- --production
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_DEPLOY_TARGET=next RAILWAY_TOKEN=dummy AGENTBEAN_NEXT_SESSION_SECRET=dummy-secret AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next npm run check:agentbean-next-readiness -- --production
```

默认 readiness 当前通过 8/8。

production readiness 在当前本地环境中仍按预期失败 5/13，因为尚未注入真正 production flip 配置。显式提供目标变量时，production readiness 通过 13/13。

## 暂未实现

这些不属于第三十四切片：

- 写入 GitHub 仓库变量 `AGENTBEAN_DEPLOY_TARGET=next`。
- 写入 GitHub secret `AGENTBEAN_NEXT_SESSION_SECRET`。
- 写入 GitHub variable `AGENTBEAN_NEXT_DATA_DIR`。
- 在 Railway production 上绑定持久化 volume 并设置匹配的数据目录。
- 执行 production deploy flip。

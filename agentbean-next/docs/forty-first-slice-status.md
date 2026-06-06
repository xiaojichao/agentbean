# 第四十一切片实现状态

本文记录 AgentBean Next 第四十一切片当前已经落地的 next npm publish 与 production deploy 解耦。

## 已实现

- `.github/workflows/ci-cd.yml`
  - `workflow_dispatch` 新增 `agentbean_deploy_target`。
  - `workflow_dispatch` 新增 `agentbean_npm_publish_target`。
  - `workflow_dispatch` 新增 `run_production_deploy`，默认 `false`。
  - `Deploy production` 在手动 dispatch 时只有 `run_production_deploy=true` 才运行。
  - `Publish agent to npm` 支持手动 dispatch。
  - next npm packages 发布由 `AGENTBEAN_NPM_PUBLISH_TARGET=next` 控制，不再依赖 `AGENTBEAN_DEPLOY_TARGET=next`。
  - `AGENTBEAN_NPM_PUBLISH_TARGET` 默认优先使用 workflow_dispatch input，其次使用 GitHub variable `AGENTBEAN_NPM_PUBLISH_TARGET`，再 fallback 到 `AGENTBEAN_DEPLOY_TARGET`。
- `scripts/check-agentbean-next-readiness.mjs`
  - 更新 `ci-publishes-next-packages`，要求 next npm 发布由 npm publish target 控制。
  - 新增 `ci-decouples-next-npm-publish-from-production-deploy`。
- `apps/server-next/tests/readiness-check.test.ts`
  - 锁定新的 readiness check 顺序。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 增加“先发布 next npm packages，不切 production deploy”的操作路径。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/readiness-check.test.ts --config vitest.config.ts --api.host 127.0.0.1
```

## 预期操作方式

先发布 next npm packages、但不替换 Railway production：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f agentbean_deploy_target=old \
  -f agentbean_npm_publish_target=next \
  -f run_production_deploy=false
```

这会让 publish job 发布缺失的：

- `@agentbean/contracts@0.2.0`
- `@agentbean/daemon-next@0.2.0`
- canonical `@agentbean/daemon@0.2.0`

同时不会运行 Railway production deploy。

真正替换旧 AgentBean 时，仍需单独执行 production flip，并让 `run_production_deploy=true` 或推送 main 触发生产部署。

## 暂未实现

这些不属于第四十一切片：

- 实际运行 next npm publish workflow dispatch。
- 写入 GitHub `AGENTBEAN_NEXT_SESSION_SECRET`。
- 设置 GitHub/Railway `AGENTBEAN_NEXT_DATA_DIR`。
- production deploy flip。
- production browser smoke。

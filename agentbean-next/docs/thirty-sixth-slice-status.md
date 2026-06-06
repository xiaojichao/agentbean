# 第三十六切片实现状态

本文记录 AgentBean Next 第三十六切片当前已经落地的 daemon-next npm readiness。

## 已实现

- `packages/contracts/package.json`
  - 改为 `private: false`。
  - 版本提升为 `0.1.0`。
  - 增加 `files: ["dist/**/*"]`。
  - 增加 `prepublishOnly`，发布前强制 build。
- `apps/daemon-next/package.json`
  - 改为 `private: false`。
  - 版本提升为 `0.1.0`。
  - 增加 `files: ["dist/**/*"]`。
  - 增加 `prepublishOnly`，发布前强制 build。
  - `@agentbean/contracts` 依赖改为 registry version `0.1.0`。
  - 增加运行时依赖 `socket.io-client`。
- `apps/daemon-next/src/cli.ts`
  - `socket.io-client` resolution 增加发布包自身 `package.json` 候选路径。
  - 保留 repo-local `apps/server` fallback，确保本地 preview 与测试仍可复用既有依赖。
- `.github/workflows/ci-cd.yml`
  - `publish` job 增加 `AGENTBEAN_DEPLOY_TARGET`。
  - `AGENTBEAN_DEPLOY_TARGET=next` 且 `NPM_TOKEN` 存在时，构建并检查 AgentBean Next npm packages。
  - 先检查并发布 `@agentbean/contracts`。
  - 再检查并发布 `@agentbean/daemon-next`。
  - 已发布版本会正确跳过。
- `scripts/check-agentbean-next-readiness.mjs`
  - 新增 `contracts-package-publishable`。
  - 新增 `daemon-next-package-publishable`。
  - 新增 `daemon-next-runtime-dependencies`。
  - 新增 `ci-publishes-next-packages`。
- `apps/server-next/tests/readiness-check.test.ts`
  - 覆盖新增 readiness checks。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P3-12`。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 记录 next 目标下 npm publish 路径。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm install --package-lock-only --ignore-scripts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/readiness-check.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_DEPLOY_TARGET=next RAILWAY_TOKEN=dummy AGENTBEAN_NEXT_SESSION_SECRET=dummy-secret AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next npm run check:agentbean-next-readiness -- --production
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm_config_cache=/private/tmp/agentbean-npm-cache npm pack --dry-run
```

默认 readiness 当前通过 12/12。

显式提供目标变量时，production readiness 当前通过 17/17。

`npm pack --dry-run` 已分别在 `packages/contracts` 与 `apps/daemon-next` 中验证，两个 package 都会包含 `dist/**/*` 与 `package.json`。

## 暂未实现

这些不属于第三十六切片：

- 真实发布 `@agentbean/contracts@0.1.0`。
- 真实发布 `@agentbean/daemon-next@0.1.0`。
- 把旧 `@agentbean/daemon` npm 包切换为 daemon-next 实现。
- 为旧 daemon 用户提供自动迁移命令。
- 瘦身 `@agentbean/daemon-next` tarball 中由当前 TypeScript `rootDir` 带入的冗余 contracts dist 副本。

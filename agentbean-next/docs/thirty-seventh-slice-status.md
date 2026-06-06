# 第三十七切片实现状态

本文记录 AgentBean Next 第三十七切片当前已经落地的 canonical daemon release package。

## 已实现

- `scripts/prepare-agentbean-next-daemon-release.mjs`
  - 从 `apps/daemon-next/dist` 生成 canonical npm release package。
  - 默认 package name 为 `@agentbean/daemon`。
  - 版本继承 `apps/daemon-next/package.json`。
  - 保留旧 daemon 用户入口：
    - `daemon`
    - `agentbean-daemon`
  - 同时保留 `agentbean-next-daemon`。
  - dependencies 指向 registry 版 `@agentbean/contracts` 与 `socket.io-client`。
- `apps/server-next/tests/daemon-release.test.ts`
  - 覆盖 generated package name、version、bin 与 dependencies。
- `packages/contracts/package.json`
  - 版本提升为 `0.2.0`。
- `apps/daemon-next/package.json`
  - 版本提升为 `0.2.0`。
  - `@agentbean/contracts` 依赖同步为 `0.2.0`。
- `.github/workflows/ci-cd.yml`
  - `AGENTBEAN_DEPLOY_TARGET=next` 时生成 `.agentbean-next-release/daemon`。
  - 检查 `@agentbean/daemon@$CANONICAL_DAEMON_VERSION` 是否已发布。
  - 在 contracts 与 daemon-next 之后发布 canonical `@agentbean/daemon`。
- `scripts/check-agentbean-next-readiness.mjs`
  - 新增 `daemon-next-version-replaces-old-daemon`，要求 daemon-next 版本高于当前旧 daemon `0.1.35`。
  - 扩展 `ci-publishes-next-packages`，要求 CI 生成并发布 canonical `@agentbean/daemon`。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P3-13`。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 记录 canonical daemon 发布顺序与旧 bin 兼容入口。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm install --package-lock-only --ignore-scripts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:contracts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:daemon-next
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH node scripts/prepare-agentbean-next-daemon-release.mjs --out /private/tmp/agentbean-next-canonical-daemon
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm_config_cache=/private/tmp/agentbean-npm-cache npm pack --dry-run /private/tmp/agentbean-next-canonical-daemon
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/daemon-release.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/readiness-check.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_DEPLOY_TARGET=next RAILWAY_TOKEN=dummy AGENTBEAN_NEXT_SESSION_SECRET=dummy-secret AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next npm run check:agentbean-next-readiness -- --production
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
```

验证结果：

- generated package 为 `@agentbean/daemon@0.2.0`。
- generated package 保留 `daemon`、`agentbean-daemon` 与 `agentbean-next-daemon` 三个 bin。
- `npm pack --dry-run` 显示 tarball 名称为 `agentbean-daemon-0.2.0.tgz`，共 31 个文件。
- `tests/daemon-release.test.ts` 通过 1 个测试。
- `tests/readiness-check.test.ts` 通过 3 个测试。
- readiness 默认检查通过 `13/13`。
- production readiness dummy env 检查通过 `18/18`。
- `npm run test:phase1` 通过 20 个测试文件、90 个测试。
- `npm run build:packages` 通过。
- `npm run preview:agentbean-next` 通过 1 个 preview smoke。

## 暂未实现

这些不属于第三十七切片：

- 真实发布 `@agentbean/contracts@0.2.0`。
- 真实发布 `@agentbean/daemon-next@0.2.0`。
- 真实发布 canonical `@agentbean/daemon@0.2.0`。
- 对旧 daemon 安装用户执行真实升级 smoke。

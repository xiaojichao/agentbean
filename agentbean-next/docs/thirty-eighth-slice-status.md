# 第三十八切片实现状态

本文记录 AgentBean Next 第三十八切片当前已经落地的 daemon install smoke。

## 已实现

- `scripts/smoke-agentbean-next-daemon-install.mjs`
  - 构建 `@agentbean/contracts` 与 `@agentbean/daemon-next`。
  - 生成 canonical `@agentbean/daemon` release package。
  - 将 `@agentbean/contracts` 与 canonical `@agentbean/daemon` pack 成本地 tarball。
  - 在临时空项目中执行 `npm install --ignore-scripts` 安装两个 tarball。
  - 校验安装后的 package name 为 `@agentbean/daemon`。
  - 校验安装版本与 `apps/daemon-next/package.json` 一致。
  - 执行 `daemon`、`agentbean-daemon` 与 `agentbean-next-daemon` 三个 bin。
  - 通过缺少 `AGENTBEAN_NEXT_TEAM_ID` 的预期错误确认三个 bin 都能进入 daemon-next CLI config validation。
- `package.json`
  - 新增 `smoke:agentbean-next-daemon-install`。
- `apps/daemon-next/src/bin.ts`
  - 增加 `#!/usr/bin/env node` shebang，确保 npm 生成的 `.bin/daemon`、`.bin/agentbean-daemon` 与 `.bin/agentbean-next-daemon` 可以直接执行。
- `.github/workflows/ci-cd.yml`
  - `Validate AgentBean Next` 在 packages build 后运行 install smoke。
- `scripts/check-agentbean-next-readiness.mjs`
  - 新增 `daemon-install-smoke-script`。
  - 新增 `ci-runs-daemon-install-smoke`。
- `apps/server-next/tests/readiness-check.test.ts`
  - 覆盖新增 readiness check IDs。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P3-14`。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 记录 daemon install smoke 已进入替换前 gate。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm install --package-lock-only --ignore-scripts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run smoke:agentbean-next-daemon-install
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run smoke:agentbean-next-daemon-install -- --skip-build
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/readiness-check.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_DEPLOY_TARGET=next RAILWAY_TOKEN=dummy AGENTBEAN_NEXT_SESSION_SECRET=dummy-secret AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next npm run check:agentbean-next-readiness -- --production
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
```

验证结果：

- default install smoke 通过，确认 generated canonical package 可以在临时空项目安装。
- `--skip-build` install smoke 通过，确认 CI 形态可以复用 packages build 产物。
- `daemon`、`agentbean-daemon` 与 `agentbean-next-daemon` 三个 bin 都能进入 daemon-next CLI config validation。
- `tests/readiness-check.test.ts` 通过 3 个测试。
- readiness 默认检查通过 `15/15`。
- production readiness dummy env 检查通过 `20/20`。
- `npm run test:phase1` 通过 20 个测试文件、90 个测试。
- `npm run build:packages` 通过。
- `npm run preview:agentbean-next` 通过 1 个 preview smoke。

## 暂未实现

这些不属于第三十八切片：

- 真实发布 `@agentbean/contracts@0.2.0`。
- 真实发布 `@agentbean/daemon-next@0.2.0`。
- 真实发布 canonical `@agentbean/daemon@0.2.0`。
- 使用真实 registry 版本执行旧 daemon 用户升级 smoke。
- production deploy flip。

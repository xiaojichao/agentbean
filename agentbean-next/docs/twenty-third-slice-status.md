# 第二十三切片实现状态

本文记录 AgentBean Next 第二十三切片当前已经落地的 CI validation gate。

## 已实现

- `.github/workflows/ci-cd.yml`
  - 新增 `Validate AgentBean Next` job。
  - pull request 变更 `agentbean-next/`、`packages/`、`apps/server-next/`、`apps/daemon-next/`、`apps/web-next/`、根 `package.json` 或 CI workflow 时，会运行 AgentBean Next validation。
  - push 到 `main` 时，总是运行 AgentBean Next validation。
  - validation 会运行 phase tests、packages build 与 preview smoke。
  - production deploy 与 npm publish 现在同时依赖旧 app validation 和 AgentBean Next validation。

## 已验证

本地按 CI 命令验证：

```bash
node apps/server/node_modules/vitest/vitest.mjs run \
  packages/contracts/tests \
  packages/domain/tests \
  apps/server-next/tests \
  apps/daemon-next/tests \
  apps/web-next/tests \
  --environment node \
  --api.host 127.0.0.1

apps/server/node_modules/.bin/tsc -p packages/contracts/tsconfig.json
apps/server/node_modules/.bin/tsc -p packages/domain/tsconfig.json
apps/server/node_modules/.bin/tsc -p apps/server-next/tsconfig.json --typeRoots apps/server/node_modules/@types
apps/server/node_modules/.bin/tsc -p apps/daemon-next/tsconfig.json --typeRoots apps/server/node_modules/@types
apps/server/node_modules/.bin/tsc -p apps/web-next/tsconfig.json

node apps/server/node_modules/vitest/vitest.mjs run \
  apps/server-next/tests/e2e-first-slice.test.ts \
  --environment node \
  --api.host 127.0.0.1 \
  -t "runtime capability -> custom agent -> message -> daemon reply"
```

## 暂未实现

这些不属于第二十三切片：

- production deploy 切换到 server-next。
- 真实浏览器点击自动化。
- 根 workspace `package-lock.json`；当前 CI 继续复用 `apps/server/package-lock.json` 提供 Next validation 所需工具链。

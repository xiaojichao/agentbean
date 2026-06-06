# 第三十三切片实现状态

本文记录 AgentBean Next 第三十三切片当前已经落地的 CI readiness gate。

## 已实现

- `.github/workflows/ci-cd.yml`
  - 在 `Validate AgentBean Next` job 中新增 `Run AgentBean Next readiness checks`。
  - 该 step 位于 root `npm ci --ignore-scripts` 之后、共享 validation dependencies 安装之前。
  - AgentBean Next 相关路径变更时，CI 会显式运行 `npm run check:agentbean-next-readiness`。
  - 如果 readiness checker 失败，后续 deploy/publish 仍会被 `needs: validate-agentbean-next` 阻止。
- `scripts/check-agentbean-next-readiness.mjs`
  - 新增 `ci-runs-readiness-checker` 静态检查项。
  - readiness checker 现在会检查 CI workflow 是否保留 `npm run check:agentbean-next-readiness`。
  - 这样 workflow 与 checker 形成互相保护：CI 执行 checker，checker 反过来验证 CI gate 存在。
- `apps/server-next/tests/readiness-check.test.ts`
  - 更新静态 readiness check id 列表，覆盖新的 CI gate 检查项。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P2-28`。
  - 更新 `E2E-05`，把 readiness checks 纳入第一条端到端 CI gate。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/readiness-check.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
```

默认 readiness 当前通过 7/7。

新增检查项：

- `ci-runs-readiness-checker`

## 暂未实现

这些不属于第三十三切片：

- 写入 GitHub 仓库变量 `AGENTBEAN_DEPLOY_TARGET=next`。
- 在 Railway production 上设置 `AGENTBEAN_NEXT_SESSION_SECRET`。
- 在 Railway production 上绑定持久化 volume 并设置真实 `AGENTBEAN_NEXT_DATA_DIR`。
- 执行 production deploy flip。

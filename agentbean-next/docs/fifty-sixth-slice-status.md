# 第五十六切片：manual rollback smoke guard

本文记录 AgentBean Next 第五十六切片新增的手动 rollback smoke guard。

## 背景

第五十五切片已经补上 `Old AgentBean production smoke`，可以在 rollback 或 old-target deploy 后验证公开入口已经恢复旧 AgentBean。

但如果操作者手动触发 `workflow_dispatch`，选择 `agentbean_deploy_target=old` 且 `run_production_deploy=true`，却没有同时勾选 `run_agentbean_old_production_smoke=true`，回滚仍可能变成反向只切不验。

因此本切片把 old-target 手动 production deploy 也纳入 smoke guard：手动部署 old 目标时，必须请求 old entry smoke。

## 已落地

- `.github/workflows/ci-cd.yml`
  - `Deploy production` job 新增 `Require old production smoke for manual AgentBean rollback deploy`。
  - 当 `workflow_dispatch && run_production_deploy=true && AGENTBEAN_DEPLOY_TARGET=old && !run_agentbean_old_production_smoke` 时，在 `railway up` 前直接失败。
  - 该 guard 不影响 push 触发的当前 old-target deploy，也不影响只发布 npm、只跑 preflight、只同步 env 的 workflow_dispatch。
- `scripts/check-agentbean-next-readiness.mjs`
  - 新增 `ci-requires-old-smoke-for-manual-rollback-deploy` 静态检查。
  - 检查 CI step、错误文案、条件表达式与 runbook 说明都存在。
- `apps/server-next/tests/readiness-check.test.ts`
  - 将新检查纳入 readiness checker 的稳定检查列表。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 明确手动 old production deploy 必须同时设置 `run_agentbean_old_production_smoke=true`。
  - 使用“反向只切不验”描述 rollback 风险，和 Next final flip 的只切不验 guard 对齐。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P3-25`。

## 验证命令

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/readiness-check.test.ts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-ready-to-flip -- --json
```

## 剩余边界

- 本切片不触发 rollback、不部署 old target，也不修改 `AGENTBEAN_DEPLOY_TARGET`。
- push 到 `main` 的常规 old-target deploy 仍不会自动运行 old entry smoke；本 guard 只约束手动 rollback/old production deploy。
- 生产是否真正替换旧 AgentBean 仍取决于用户明确批准最终开关、production deploy flip、Next production smoke、真实浏览器验收与必要时的 rollback smoke。

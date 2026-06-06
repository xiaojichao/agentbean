# 第五十七切片：final flip repository variable guard

本文记录 AgentBean Next 第五十七切片新增的 final flip repository variable guard。

## 背景

第五十四切片已经阻止手动 Next production deploy 只切不验，第五十六切片也让手动 rollback/old deploy 必须搭配 old entry smoke。

但还有一个更细的发布风险：`workflow_dispatch` 允许通过 input 把本次 `agentbean_deploy_target` 设为 `next`。如果 repository variable `AGENTBEAN_DEPLOY_TARGET` 仍然是 `old`，这次手动 run 可以临时部署 Next，但下一次 push 到 `main` 又会按 repository variable 回到旧 AgentBean。这样会把一次性 workflow input 误当成真正 final flip。

因此本切片要求：手动 Next production deploy 只有在 repository variable `AGENTBEAN_DEPLOY_TARGET=next` 已经设置后才允许继续。

## 已落地

- `.github/workflows/ci-cd.yml`
  - `Deploy production` job 新增 `Require repository deploy target for manual AgentBean Next deploy`。
  - 当 `workflow_dispatch && run_production_deploy=true && AGENTBEAN_DEPLOY_TARGET=next && vars.AGENTBEAN_DEPLOY_TARGET != 'next'` 时，在 `railway up` 前直接失败。
  - 错误文案明确 workflow input alone 不是 final production flip。
- `scripts/check-agentbean-next-readiness.mjs`
  - 新增 `ci-requires-repository-target-for-manual-next-deploy` 静态检查。
  - 检查 CI step、错误文案、条件表达式与 runbook 说明都存在。
- `apps/server-next/tests/readiness-check.test.ts`
  - 将新检查纳入 readiness checker 的稳定检查列表。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 明确 `AGENTBEAN_DEPLOY_TARGET=next` 是 repository variable，不是 workflow dispatch input。
  - 明确手动 Next production deploy 必须先完成 repository variable final flip，并同时请求 `run_agentbean_next_production_smoke=true`。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P3-26`。

## 验证命令

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/readiness-check.test.ts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-ready-to-flip -- --json
```

## 剩余边界

- 本切片不设置 `AGENTBEAN_DEPLOY_TARGET=next`，不触发 production flip。
- 本切片不运行手动 Next production deploy；它只让错误组合在 `railway up` 前失败。
- 生产是否真正替换旧 AgentBean 仍取决于用户明确批准最终开关、设置 repository variable、production deploy flip、Next production smoke 与真实浏览器验收。

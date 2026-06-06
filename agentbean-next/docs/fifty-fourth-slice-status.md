# 第五十四切片：Final Flip Smoke Guard

本文记录 AgentBean Next 第五十四切片新增的 final flip smoke guard。

## 背景

第五十三切片已经让 `AgentBean Next production smoke` 在触碰入口前先运行 ready-to-flip audit。剩余风险是 workflow dispatch 仍允许手动组合 `agentbean_deploy_target=next` 与 `run_production_deploy=true`，但不勾选 `run_agentbean_next_production_smoke=true`。

这种组合会造成“只切不验”：生产后端可能已经替换成 AgentBean Next，但同一次 CI run 不会自动执行 public entry smoke 与 business smoke。

## 已完成

- `.github/workflows/ci-cd.yml` 的 `Deploy production` job 新增 `Require production smoke for manual AgentBean Next deploy` step。
  - 如果 workflow dispatch 手动运行 next production deploy，但没有请求 production smoke，该 step 会直接失败。
  - 该 step 位于 Railway CLI 安装与 `railway up` 之前，不会先部署再报错。
- `AgentBean Next production smoke` job 现在也会在 push 到 `main` 且 `vars.AGENTBEAN_DEPLOY_TARGET == 'next'` 时自动运行。
  - 这覆盖了通过 repository variable 打开 final flip 后再推送 main 的切换路径。
  - 当前变量仍是 old 或未设置时，该 job 继续 skipped。
- readiness checker 新增 `ci-requires-production-smoke-for-next-deploy` 静态检查。
- `production-cutover-runbook.md` 明确禁止只切不验。
- `verification-matrix.md` 新增 P3-23。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/readiness-check.test.ts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-ready-to-flip -- --json
```

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未设置 `AGENTBEAN_DEPLOY_TARGET=next`。
- 尚未执行 next production deploy。
- 尚未在 production host 上真实运行 `AgentBean Next production smoke`。
- 尚未在 Railway production volume 上完成重启后 session/team/channel/message 复核。

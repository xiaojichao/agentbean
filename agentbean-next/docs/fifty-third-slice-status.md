# 第五十三切片：Production Smoke Preflight Gate

本文记录 AgentBean Next 第五十三切片新增的 production smoke preflight gate。

## 背景

第五十二切片已经把“除最终开关外全部就绪”的状态做成 `audit:agentbean-next-ready-to-flip`。但 GitHub Actions 里的 `AgentBean Next production smoke` job 仍然直接运行 entry smoke 与 business smoke。

如果 GitHub variables/secrets、production smoke URL 或 npm registry 状态在 final flip 前漂移，原 workflow 会等到 smoke 真实连接生产入口时才暴露问题。更好的边界是：production smoke job 在触碰入口前，先证明外部状态仍处于 ready-to-flip。

## 已完成

- `.github/workflows/ci-cd.yml` 的 `AgentBean Next production smoke` job 新增 `Run AgentBean Next ready-to-flip audit` step。
  - 该 step 在 `Verify production smoke target URL` 之后执行。
  - 该 step 在 public entry smoke 与 business smoke 之前执行。
  - 该 step 不部署、不发布 npm、不修改 GitHub variables。
- `scripts/check-agentbean-next-readiness.mjs` 新增 `ci-runs-ready-to-flip-before-production-smoke` 静态检查。
- `apps/server-next/tests/readiness-check.test.ts` 固化 readiness check 顺序。
- `production-cutover-runbook.md` 明确 production smoke 会先运行 ready-to-flip audit。
- `verification-matrix.md` 新增 P3-22。

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

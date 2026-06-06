# 第五十二切片：Ready-to-Flip Audit

本文记录 AgentBean Next 第五十二切片新增的 ready-to-flip audit。

## 背景

第五十一切片之后，外部 cutover audit 已经收敛到 `10/11`：GitHub secrets、`AGENTBEAN_NEXT_DATA_DIR`、`AGENTBEAN_NEXT_ENTRY_URL`、npm registry next packages 都已通过，唯一失败项是最终生产替换开关 `AGENTBEAN_DEPLOY_TARGET=next`。

严格 cutover audit 必须继续在 final flip 前失败，否则会把“等待授权”误报成“已经替换”。但此时也需要一个单独的绿灯命令，证明除最终开关之外的外部条件都已准备好。

## 已完成

- `scripts/audit-agentbean-next-cutover.mjs` 增加 `--allow-pending-final-flip`。
  - 普通模式仍要求 `AGENTBEAN_DEPLOY_TARGET=next`。
  - ready-to-flip 模式只允许 `github-variable-deploy-target-next` 这一项保持失败。
  - 如果还有其他失败项，命令仍失败。
- 根 `package.json` 新增 `audit:agentbean-next-ready-to-flip`。
- `apps/server-next/tests/cutover-audit.test.ts` 覆盖严格模式与 ready-to-flip 模式的差异。
- readiness checker 新增 `ready-to-flip-audit-script` 静态检查，防止该命令或 runbook 说明消失。
- `production-cutover-runbook.md` 增加 ready-to-flip audit 步骤，并更新 `AGENTBEAN_NEXT_ENTRY_URL=https://api.agentbean.dev` 的当前外部状态。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/cutover-audit.test.ts tests/readiness-check.test.ts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-ready-to-flip -- --json
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-cutover -- --json
```

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未设置 `AGENTBEAN_DEPLOY_TARGET=next`。
- 尚未执行 next production deploy。
- 尚未在 production host 上真实运行 `AgentBean Next production smoke`。
- 尚未在 Railway production volume 上完成重启后 session/team/channel/message 复核。

# 第五十五切片：rollback old entry smoke

本文记录 AgentBean Next 第五十五切片新增的 rollback old entry smoke。

## 背景

第五十四切片已经阻止了手动 Next production deploy “只切不验”。但真正替换旧 AgentBean 前，还需要把反向路径也变成可执行证据：如果 production smoke 失败并切回 `AGENTBEAN_DEPLOY_TARGET=old`，不能只靠人工看日志判断旧系统已恢复。

因此本切片补上旧入口 smoke：它验证公开入口 `/healthz` 返回旧 AgentBean 的 `{ "status": "ok" }`，同时拒绝 AgentBean Next 的 `{ "ok": true, "service": "agentbean-next-server" }`，防止 rollback 后实际上仍停在 Next server。

## 已落地

- `scripts/smoke-agentbean-old-entry.mjs`
  - 新增 `collectAgentBeanOldEntrySmoke` 与 `summarizeOldEntrySmoke`。
  - 支持 `--url`、`AGENTBEAN_OLD_ENTRY_URL`，并可 fallback 到 `AGENTBEAN_NEXT_ENTRY_URL`，方便复用当前 production backend entry。
  - 明确区分旧 server health payload 与 AgentBean Next server health payload。
- 根 `package.json`
  - 新增 `npm run smoke:agentbean-old-entry`。
- `.github/workflows/ci-cd.yml`
  - 新增 workflow_dispatch input：
    - `run_agentbean_old_production_smoke`
    - `agentbean_old_entry_url`
  - 新增 `Old AgentBean production smoke` job。
  - 该 job 只在显式请求时运行，用于 old-target deploy 或 rollback 后验证公开入口。
- `scripts/check-agentbean-next-readiness.mjs`
  - 新增 `old-entry-smoke-script` 静态检查，守住 package script、CI input/job 与 runbook 说明。
- `apps/server-next/tests/old-entry-smoke.test.ts`
  - 覆盖旧 payload 通过、Next payload 失败、缺少 URL 时不 fetch。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 增加 old entry smoke 的独立 workflow dispatch 命令。
  - rollback 步骤要求 `Old AgentBean production smoke` 通过。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P3-24`。

## 验证命令

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/old-entry-smoke.test.ts tests/readiness-check.test.ts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_OLD_ENTRY_URL=https://api.agentbean.dev npm run smoke:agentbean-old-entry -- --json
```

## 剩余边界

- 本切片不执行 production rollback，也不修改 `AGENTBEAN_DEPLOY_TARGET`。
- `Old AgentBean production smoke` 是 rollback/old-target deploy 的验证入口；它不能替代 AgentBean Next final flip 后的 entry smoke 与 business smoke。
- 生产是否真正替换旧 AgentBean 仍取决于用户明确批准最终开关、production deploy flip、Next production smoke 与真实浏览器验收。

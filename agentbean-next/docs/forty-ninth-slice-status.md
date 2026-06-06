# 第四十九切片：Production Smoke Workflow Gate

本文记录 AgentBean Next 第四十九切片新增的 production smoke workflow gate。

## 背景

第四十六到第四十八切片已经把公开入口、业务链路与本地 SQLite 重启持久化 smoke 脚本化。真正替换旧 AgentBean 时，仍需要在 GitHub Actions 里有一个可重复触发的 production smoke gate，避免 final flip 后只靠人工在本机敲命令确认入口和业务链路。

因此，本切片新增一个只在 `workflow_dispatch` 显式勾选时运行的 smoke job。它不会部署，不会发布 npm，也不会修改 `AGENTBEAN_DEPLOY_TARGET`。

## 已完成

- `.github/workflows/ci-cd.yml` 新增 `run_agentbean_next_production_smoke` workflow input。
- `.github/workflows/ci-cd.yml` 新增 `agentbean_next_entry_url` workflow input。
  - 如果 input 为空，job 会使用 repository variable `AGENTBEAN_NEXT_ENTRY_URL`。
- 新增 `AgentBean Next production smoke` job。
  - 安装 root smoke dependencies。
  - 安装 `apps/server` 的 Socket.IO client dependency。
  - 校验 `AGENTBEAN_NEXT_ENTRY_URL` 已配置。
  - 运行 `npm run smoke:agentbean-next-entry`。
  - 运行 `npm run smoke:agentbean-next-business`。
- readiness checker 新增 `ci-runs-production-smoke-on-demand` 静态检查，确保 workflow input、job 与 runbook 步骤不会消失。
- `production-cutover-runbook.md` 增加手动触发 production smoke 的命令，并把它列入 final flip 后的验收项。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/readiness-check.test.ts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
```

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未在 production host 上真实运行 `AgentBean Next production smoke`。
- 尚未在 Railway production volume 上完成重启后 session/team/channel/message 复核。

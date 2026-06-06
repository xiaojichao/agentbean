# 第五十切片：Production Smoke URL Cutover Audit

本文记录 AgentBean Next 第五十切片新增的 production smoke URL cutover audit。

## 背景

第四十九切片已经在 GitHub Actions 中新增 `AgentBean Next production smoke` job。该 job 可以通过 workflow input `agentbean_next_entry_url` 或 repository variable `AGENTBEAN_NEXT_ENTRY_URL` 获取部署 URL。

如果 final flip 前没有配置 production smoke URL，切换后 smoke job 会因为缺少目标 URL 才失败。为了把这个风险前移，本切片把 `AGENTBEAN_NEXT_ENTRY_URL` 纳入外部 cutover audit。

## 已完成

- `scripts/audit-agentbean-next-cutover.mjs` 新增 `github-variable-next-entry-url` 检查。
  - 要求 `AGENTBEAN_NEXT_ENTRY_URL` 是 `http` 或 `https` URL。
  - 禁止 `localhost`、`127.0.0.1`、`0.0.0.0` 与 `::1`，避免把本地地址误当成 production smoke 目标。
- `apps/server-next/tests/cutover-audit.test.ts` 更新通过态与缺失态。
  - 全部就绪时 audit 总数变为 `11`。
  - 缺少 production smoke URL 时会报告 `github-variable-next-entry-url`。
- `production-cutover-runbook.md` 明确 `AGENTBEAN_NEXT_ENTRY_URL` 的用途与 fallback。
- `verification-matrix.md` 将 production smoke URL 纳入 P3-15。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/cutover-audit.test.ts
```

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未设置真实 `AGENTBEAN_NEXT_ENTRY_URL`。
- 尚未在 production host 上真实运行 `AgentBean Next production smoke`。
- 尚未在 Railway production volume 上完成重启后 session/team/channel/message 复核。

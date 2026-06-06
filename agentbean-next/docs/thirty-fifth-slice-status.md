# 第三十五切片实现状态

本文记录 AgentBean Next 第三十五切片当前已经落地的 production cutover runbook。

## 已实现

- `agentbean-next/docs/production-cutover-runbook.md`
  - 记录当前代码 gate 状态。
  - 记录当前真实外部配置状态。
  - 明确切换前必须设置的 GitHub Actions secret/variable。
  - 明确 Railway volume 与 runtime env 要求。
  - 明确本地验证、production flip、production smoke 与 rollback 步骤。
  - 明确旧 Vercel web 入口仍需单独决策。
- `agentbean-next/README.md`
  - 增加 production cutover runbook 入口。
  - 增加第三十五切片状态页入口。
  - 更新当前实现状态。
- `agentbean-next/docs/migration-plan.md`
  - Phase 6 cutover 要求引用 production cutover runbook。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `E2E-06`，把 production cutover runbook 纳入替换旧系统前的 ops gate。

## 已验证

本地验证：

```bash
rg -n "production-cutover-runbook|E2E-06|第三十五|AGENTBEAN_DEPLOY_TARGET" agentbean-next
```

外部配置只做只读检查：

```bash
gh variable list --repo xiaojichao/agentbean
gh secret list --repo xiaojichao/agentbean
which railway
```

当前观察结果：

- GitHub repository variables 当前为空。
- GitHub repository secrets 当前已有 `RAILWAY_TOKEN`，但未看到 `AGENTBEAN_NEXT_SESSION_SECRET`。
- 本机当前没有安装 `railway` CLI。

## 暂未实现

这些不属于第三十五切片：

- 写入 GitHub repository variable/secret。
- 安装或登录 Railway CLI。
- 绑定 Railway production volume。
- 执行 production deploy flip。
- production browser smoke。

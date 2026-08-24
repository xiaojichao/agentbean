# Staging rollback rehearsal

`rehearse:staging-rollback` 为 AgentBean Next 提供确定性的 Railway staging rollback 演练路径。它补充而不复制 `agentbean-next/docs/production-cutover-runbook.md`：生产事故处理仍以该 Runbook 为权威，Production rollback 不在本工具权限内。

当前仓库尚未保存 staging Railway environment ID、专用 project token 或 staging URL，因此本次只落地可执行协议与离线验证，**没有执行真实远端 rollback**。接入真实 staging 前，operator 必须创建环境级 project token，并在本地或受保护的 CI 环境提供实际配置。

Railway 官方 Public API 支持按 deployment ID 调用 `deploymentRollback`，但目标必须仍为 `canRollback: true`。项目 token 使用 `Project-Access-Token` header，并且只对单个 project environment 生效：

- https://docs.railway.com/integrations/api/manage-deployments
- https://docs.railway.com/integrations/api

## 安全边界

- config 的 `environmentName` 必须精确为 `staging`；已知 production environment ID 和 production URL 会被硬拒绝。
- token 只能从 `AGENTBEAN_STAGING_RAILWAY_TOKEN` 读取，config 不得保存 token，也不接受通用 `RAILWAY_TOKEN` / `NPM_TOKEN`。
- 每次 live plan 都回读 project token 的 `projectId/environmentId` 和 Railway environment 的真实名称；任一项与 config 或精确名称 `staging` 不一致时 fail closed。
- 默认只生成 plan。真实写操作必须同时提供 `--execute --confirm <当前 planHash> --ack-staging-frozen`；operator 先暂停 staging 自动部署，脚本再重新读取完整 deployment history 并重算 plan，current、target 或版本状态变化都会使旧 hash 失效。
- 执行还要求受保护环境变量 `AGENTBEAN_STAGING_ENTRY_HOST` 与 config URL 的 hostname 精确一致；IP、localhost、本地域名和非默认端口均被拒绝。
- 离线 snapshot 只能生成 dry-run plan，禁止执行。
- rollback 后只运行 GET 型 public entry smoke：`/healthz`、`/`、`/socket.io/socket.io.js`。会创建用户、Device、Task 或消息的 business smoke 不属于第一阶段 rehearsal。
- health/smoke 失败时冻结 staging 并报告，不自动继续 rollback、redeploy、publish、修改变量或触发 production 操作。

## Staging config

配置文件不进入仓库；下面只是字段格式：

```json
{
  "schemaVersion": 1,
  "provider": "railway",
  "environmentName": "staging",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "serviceId": "22222222-2222-4222-8222-222222222222",
  "environmentId": "33333333-3333-4333-8333-333333333333",
  "baseUrl": "https://staging.example.com",
  "tokenEnv": "AGENTBEAN_STAGING_RAILWAY_TOKEN"
}
```

字段必须完整且无未知项；ID 必须是 UUID，`baseUrl` 必须是无凭据、query、fragment 或子路径的 HTTPS origin。

## Dry-run

有 staging project token 时，从 Railway live API 读取最近 50 个 deployments，选择当前 `SUCCESS` deployment 与上一条 `canRollback=true` 的历史 deployment。`canRollback` 是 Railway 的权威可回滚条件；历史项可能已显示为 `REMOVED`，不要把状态标签本身解释为当前运行成功：

```bash
export AGENTBEAN_STAGING_RAILWAY_TOKEN='<environment-scoped-token>'
npm run rehearse:staging-rollback -- --config /absolute/path/staging.json --json
```

历史分页截断、最新 deployment 不是稳定 `SUCCESS`、没有上一可回滚版本、目标 `canRollback=false`、token scope 不匹配时均 fail closed。可以用 `--target-deployment <uuid>` 选择更早的合法目标。

没有 staging 凭据时，可用离线 snapshot 验证选版和 plan hash。snapshot 必须记录相同的 project/service/environment IDs、`historyTruncated=false` 和至少两个 deployment；它不能进入 execute 路径：

```bash
npm run rehearse:staging-rollback -- \
  --config /absolute/path/staging.json \
  --snapshot /absolute/path/deployments.json \
  --json
```

## 人工授权执行

operator 审核 plan 的 current、target、staging IDs、URL 和 actions 后，使用刚生成的 hash 显式授权：

```bash
export AGENTBEAN_STAGING_RAILWAY_TOKEN='<environment-scoped-token>'
export AGENTBEAN_STAGING_ENTRY_HOST='staging.example.com'
npm run rehearse:staging-rollback -- \
  --config /absolute/path/staging.json \
  --execute \
  --confirm '<64-char-plan-hash>' \
  --ack-staging-frozen \
  --json
```

执行链固定为：operator 暂停 staging 自动部署并确认 freeze → 校验 plan/config/hostname 绑定 → 再次读取完整 history 并重算 planHash → 再次校验目标 `canRollback` → 一次 `deploymentRollback` mutation → 等待新 deployment `SUCCESS` → 运行只读 entry smoke。不会重试 mutation。

Railway 的 `deploymentRollback(id)` 不提供“仅当 current deployment 仍为某 ID”这一条件参数，因此无法由客户端消除查询与 mutation 之间的最后竞态窗口。environment-scoped token、staging freeze、最新状态检查与 fresh planHash 用于把窗口降到最小；Railway 服务端仍以 mutation 时的 `canRollback` 和 token scope 作最终原子门禁。

结果中的 `planHash`、current/target/rollback deployment IDs、entry smoke checks 和 `nextAction` 应保存到 incident 或演练记录，由 operator sign-off。token 不会出现在结果中。

## CI 接线

单元测试完全离线，覆盖 production guard、历史截断、目标选择、token scope、plan hash 授权、单次 mutation 和 smoke 失败冻结。它进入 retained boundaries，但脚本路径不会设置 `should_deploy`，也不接入现有 production `workflow_dispatch`。

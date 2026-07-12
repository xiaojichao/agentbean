# AgentBean Next 生产发布与回滚 Runbook

本文只描述 Release B 之后仍然可执行的生产操作。旧 AgentBean 切换命令、old-target workflow inputs 和旧源码构建方式已经退出活动合同；历史过程由 Git 历史和 Phase -1 验收矩阵保存，事故处理中不得照搬。

## 当前发布边界

- 唯一服务端实现：`apps/server-next`。
- 唯一 Web 实现：`apps/web-next`，由 server-next 托管。
- 唯一 Device runtime 源码：`apps/daemon-next`。
- canonical npm 入口：`@agentbean/daemon@latest`，当前必须指向 daemon-next。
- 历史归档：`@agentbean/daemon@legacy=0.1.35`。它使用旧 `register` 事件和旧空间字段协议，与 server-next 不兼容，不能作为 Device rollback。
- Device rollback：选择已发布且经 server-next 连接 smoke 验证的 canonical daemon-next 版本；当前已知候选为 `@agentbean/daemon@0.3.5`，事故操作前仍必须重新验证。
- Server rollback：与当前 SQLite schema 兼容的上一成功 Railway deployment，或 Git revert 后重新部署 AgentBean Next。
- 不从 `main` 重建已经退役的 `apps/server`、`apps/web` 或 `apps/daemon`。

Release B 已通过 PR #485 合并到 `main`，merge commit 为 `b9238c5b8c14b7daf327ecb982f9853a739afd28`。对应 [main CI/CD run 29177487834](https://github.com/xiaojichao/agentbean/actions/runs/29177487834) 的 validate、npm publish gate、Railway deploy 和 production smoke 全部成功；Phase -1 的完整发布证据记录在验收矩阵中。

## 自动 main 发布

推送 `main` 触发生产部署，流水线顺序固定为：

1. `Validate AgentBean Next`
2. `Publish agent to npm`
3. `Deploy production`
4. `AgentBean Next production smoke`

约束：

- main publish 缺少 `NPM_TOKEN` 时必须失败，不能静默跳过。
- production deploy 缺少 `RAILWAY_TOKEN` 时必须失败，不能静默跳过。
- deploy 必须等待 publish 成功，防止新 Server 先于对应 contracts/daemon artifact 对外生效。
- push run 的 deploy 成功后自动运行 `AgentBean Next production smoke`。
- production smoke 先运行 strict cutover audit，再运行 public entry smoke 与 business smoke。
- strict audit 必须确认 npm `@latest` dist-tag 已指向 daemon-next，并确认历史归档 `legacy` 仍固定为 `0.1.35`；该检查不代表 `legacy` 可用于回滚。

## 手动操作

### 只读 Railway preflight

```bash
gh workflow run ci-cd.yml \
  --ref main \
  -f run_production_deploy=false \
  -f run_railway_preflight=true \
  -f sync_railway_next_runtime_env=false \
  -f run_agentbean_next_production_smoke=false \
  -f agentbean_next_entry_url='' \
  -f promote_agentbean_daemon_latest=false \
  -f skip_npm_publish=true
```

### 手动 server-next deploy

```bash
gh workflow run ci-cd.yml \
  --ref main \
  -f run_production_deploy=true \
  -f run_railway_preflight=false \
  -f sync_railway_next_runtime_env=false \
  -f run_agentbean_next_production_smoke=true \
  -f agentbean_next_entry_url='' \
  -f promote_agentbean_daemon_latest=false \
  -f skip_npm_publish=false
```

手动 deploy 必须同时传 `run_agentbean_next_production_smoke=true`，且不得传 `skip_npm_publish=true`；CI 会阻止只切不验和绕过 npm 发布。`agentbean_next_entry_url` 为空时使用 repository variable `AGENTBEAN_NEXT_ENTRY_URL`。

### 只运行 production smoke

```bash
gh workflow run ci-cd.yml \
  --ref main \
  -f run_production_deploy=false \
  -f run_railway_preflight=false \
  -f sync_railway_next_runtime_env=false \
  -f run_agentbean_next_production_smoke=true \
  -f agentbean_next_entry_url='https://api.agentbean.dev' \
  -f promote_agentbean_daemon_latest=false \
  -f skip_npm_publish=true
```

## 本地与生产验证

```bash
npm run audit:agentbean-next-cutover -- --json
npm run check:agentbean-next-readiness
npm run test:phase1
npm run build:packages
npm run smoke:agentbean-next-persistence
npm run smoke:agentbean-next-browser
```

production URL 验证：

```bash
AGENTBEAN_NEXT_ENTRY_URL=https://api.agentbean.dev npm run smoke:agentbean-next-entry
AGENTBEAN_NEXT_ENTRY_URL=https://api.agentbean.dev npm run smoke:agentbean-next-business
```

public entry smoke 验证 `/healthz`、根页面和 Socket.IO assets。business smoke 验证注册/登录、Device hello、runtime report、custom agent 创建、消息 dispatch 和 agent reply 可见。

SQLite volume persistence 使用：

```bash
npm run smoke:agentbean-next-persistence
```

它验证 server restart 后 session、Team、channel/message 能从 SQLite volume 恢复。

## Release B rollback

Release A 前 global SQLite backup 没有可验证证据，而 production 已应用 `global/0014_device_revocations_team_columns.sql`。发布后同 volume snapshot 不是 old binary rollback point，也不能覆盖 volume 丢失。

生产异常时：

1. 停止后续 deploy，保存失败日志、deployment ID、global/team DB metadata 与 incident 时间线。
2. 保持现有 volume，不删除、不覆盖现场数据。
3. Server 代码回滚只选择已知兼容 `0014` 的上一成功 AgentBean Next Railway deployment，或 revert 到兼容 commit 后重新部署。
4. 回滚后重新运行 strict cutover audit、public entry smoke、business smoke，以及故障面对应的 browser/SQLite 验证。
5. 涉及数据恢复时先停止写入；只有确认 snapshot 时间点、目标 schema、影响范围并完成恢复演练后才能执行。
6. Device 客户端需要回滚时，选择已发布、与 server-next canonical 协议兼容的上一成功版本，并在隔离 Device 上完成安装、登录、`device:hello`、runtime/agent report 和任务往返 smoke 后再扩大范围。当前已知候选为 `npm install @agentbean/daemon@0.3.5`，但事故时仍须重新验证 registry artifact 和连接行为。
7. 不得安装 `@agentbean/daemon@legacy=0.1.35` 进行回滚；它只保留为历史归档，使用旧协议，无法连接当前 server-next。
8. 若唯一方案需要 old binary，保持服务冻结并升级为人工 incident 决策；不得临时恢复已退役 workflow 或从 `main` 重建旧源码。

## Phase -1 收口

Release B 合并后记录：

- merge commit；
- main CI run；
- npm publish 结果和 `latest/legacy` dist-tags；
- Railway deployment；
- strict audit、entry/business、combined browser smoke；
- Team/Device/Artifact/revocation/storage 生产行为；
- SQLite snapshot 的已知限制。

上述证据通过后，再用 verification-only PR 把 P-1-09、P-1-12、P-1-16 和 Phase -1 状态更新为最终结论。

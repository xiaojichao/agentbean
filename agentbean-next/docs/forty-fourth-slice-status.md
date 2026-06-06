# 第四十四切片：Railway Next 只读预检

本文记录 AgentBean Next 第四十四切片当前已经落地的 Railway production preflight。

## 已完成

- 新增 `scripts/check-agentbean-next-railway-preflight.mjs`。
  - 通过 Railway CLI 只读查询 production service 的 runtime variables 与 volumes。
  - 检查 `AGENTBEAN_NEXT_DATA_DIR` 与 Railway runtime env 一致。
  - 检查 Railway runtime env 存在 `AGENTBEAN_NEXT_SESSION_SECRET`。
  - 检查至少一个 production volume mount path 覆盖 `AGENTBEAN_NEXT_DATA_DIR`。
  - 对 secret redacted value 只检查变量存在，不打印、不比较 secret 明文。
- 新增根命令 `npm run check:agentbean-next-railway-preflight`。
- `CI/CD` 新增手动输入 `run_railway_preflight`。
  - 只有 `workflow_dispatch` 且 `run_railway_preflight=true` 时运行。
  - 该 job 不执行 `railway up`，不会部署，也不会切换旧生产系统。
  - preflight-only dispatch 下 `Publish agent to npm` 也会跳过，避免只读预检顺手触发 npm 发布逻辑。
  - 运行 production readiness 后安装 Railway CLI，再执行 Railway preflight。
- `CI/CD` 新增手动输入 `sync_railway_next_runtime_env`。
  - 只有 `workflow_dispatch` 且 `sync_railway_next_runtime_env=true` 时运行。
  - 将 GitHub Actions 中已有的 `AGENTBEAN_NEXT_DATA_DIR` 与 masked `AGENTBEAN_NEXT_SESSION_SECRET` 同步到 Railway variables。
  - 使用 `--skip-deploys`，不会触发 Railway deploy。
  - sync-only dispatch 下 `Publish agent to npm` 也会跳过。
  - 同步完成后立即运行 Railway preflight 验证。
- readiness checker 新增静态检查，确保 Railway preflight job 和 npm script 不会从 CI 中消失。
- 新增 `apps/server-next/tests/railway-preflight.test.ts`。
  - 覆盖 runtime variables 与 volume 都正确时通过。
  - 覆盖 data dir 不一致、缺少 session secret、volume 不覆盖 data dir 时失败。
  - 覆盖 Railway JSON output 形状兼容与 redacted secret 处理。
  - 覆盖当前 Railway CLI 的 `volume list --json` 参数形状。

## 真实运行记录

- GitHub Actions run `27066832805` 首次真实执行了 `Railway Next preflight`。
- `Run AgentBean Next production readiness checks` 通过 `22/22`。
- `Deploy production` 与 `Publish agent to npm` 均按预期 skipped。
- `Run Railway AgentBean Next preflight` 失败，暴露两个问题：
  - 当前 npm 安装的 Railway CLI 不接受 `railway volume list --project`。
  - Railway production service 尚未暴露 `AGENTBEAN_NEXT_DATA_DIR` 与 `AGENTBEAN_NEXT_SESSION_SECRET` runtime variables。
- GitHub Actions run `27067004872` 再次真实执行 `Railway Next preflight`，确认当前 npm 安装的 Railway CLI 对 `railway volume list` 也不接受 `--service`。
- 本切片随后修正脚本，改用当前 CLI 接受的最小只读命令 `railway volume list --json`。
- GitHub Actions run `27067234056` 第三次真实执行 `Railway Next preflight`。
  - production readiness 通过 `22/22`。
  - Railway volumes 已可读。
  - 已确认 production service 有持久化 volume。
  - 已确认 volume mount path 覆盖 `/data/agentbean-next`。
  - 仅剩 Railway variables 缺少 `AGENTBEAN_NEXT_DATA_DIR` 与 `AGENTBEAN_NEXT_SESSION_SECRET`。
- 本切片随后新增显式 Railway env sync job，用于补齐上述两个 variables，但仍不 deploy。
- GitHub Actions run `27067398886` 真实执行 `Railway Next env sync`。
  - `Validate AgentBean Next` 通过。
  - `Run AgentBean Next production readiness checks` 通过 `23/23`。
  - `Sync Railway AgentBean Next runtime env` 成功。
  - `Verify Railway AgentBean Next preflight` 通过 `11/11`。
  - `Deploy production` 与 `Publish agent to npm` 均按预期 skipped。
- 本机随后运行 external cutover audit：
  - GitHub variables/secrets 可读。
  - `AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next` 已设置。
  - `RAILWAY_TOKEN`、`NPM_TOKEN`、`AGENTBEAN_NEXT_SESSION_SECRET` 已存在。
  - npm registry 已包含 `@agentbean/contracts@0.2.0`、`@agentbean/daemon-next@0.2.0`、canonical `@agentbean/daemon@0.2.0`。
  - 当前唯一失败项是 `AGENTBEAN_DEPLOY_TARGET=next` 尚未打开。

## 当前真实状态

截至本切片，AgentBean Next 的本地、npm、GitHub Actions、Railway variables 与 Railway volume gate 已全部满足。真正 production flip 前只剩一个外部生产开关：

```bash
gh variable set AGENTBEAN_DEPLOY_TARGET --repo xiaojichao/agentbean --body next
```

该命令会把后续 production deploy 目标切到 AgentBean Next。由于它会实际替换生产后端，必须由用户明确批准后才能执行。

## 本地验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH node apps/server/node_modules/vitest/vitest.mjs run apps/server-next/tests/readiness-check.test.ts apps/server-next/tests/railway-preflight.test.ts --environment node --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
```

## 下一步

在 `main` 上手动触发：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f agentbean_deploy_target=old \
  -f agentbean_npm_publish_target=old \
  -f run_production_deploy=false \
  -f run_railway_preflight=true \
  -f sync_railway_next_runtime_env=false
```

如果 `Railway Next preflight` 通过，说明 production service 的 Next runtime env 与 volume 已经具备切换前条件。当前该条件已经由 run `27067398886` 证明通过。下一步是用户明确批准后，把 `AGENTBEAN_DEPLOY_TARGET` 设为 `next`，再触发 production deploy 与 smoke。

如果 preflight 仅因为 Railway variables 缺失而失败，先运行：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f agentbean_deploy_target=old \
  -f agentbean_npm_publish_target=old \
  -f run_production_deploy=false \
  -f run_railway_preflight=false \
  -f sync_railway_next_runtime_env=true
```

该流程会补齐 Railway variables，然后立即运行 preflight；仍不会 deploy 或 publish。

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未把 GitHub variable `AGENTBEAN_DEPLOY_TARGET` 设置为 `next`。
- 尚未执行 production deploy flip。
- 尚未完成 production browser smoke 与 SQLite volume 持久化复核。

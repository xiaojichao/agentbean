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
  -f run_railway_preflight=true
```

如果 `Railway Next preflight` 通过，说明 production service 的 Next runtime env 与 volume 已经具备切换前条件。届时仍不要自动 flip；下一步才是把 `AGENTBEAN_DEPLOY_TARGET` 设为 `next`，再触发 production deploy 与 smoke。

## 仍未完成

- 尚未在 GitHub Actions 中真实运行 `Railway Next preflight`。
- 尚未把 GitHub variable `AGENTBEAN_DEPLOY_TARGET` 设置为 `next`。
- 尚未执行 production deploy flip。
- 尚未完成 production browser smoke 与 SQLite volume 持久化复核。

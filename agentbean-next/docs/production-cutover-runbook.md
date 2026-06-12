# AgentBean Next 生产切换 Runbook

本文档描述如何把生产部署从旧 AgentBean 切换到 AgentBean Next。它是操作清单，不是自动切换脚本。

## 状态更新

截至 2026-06-12，AgentBean Next final flip 已经完成，post-flip strict cutover audit、production entry smoke、business smoke 与 browser smoke gate 已进入主线验证。当前 follow-up 状态见 `post-flip-follow-up-status.md`。

本文后续仍保留切换前 gate、manual deploy、rollback 与 smoke 的操作说明，供回放、审计或受控 rollback 演练使用；不要把下方历史 pre-flip 状态误读为当前仍未切换。

## 切换前 gate 状态（历史）

截至第五十五切片，仓库内替换前 gate 已具备：

- 根目录 `railway.json` 明确声明 AgentBean Next 的 build、start 与 `/healthz`。
- `AGENTBEAN_DEPLOY_TARGET` 支持 `old|next`，默认仍为 `old`。
- `Validate AgentBean Next` job 会运行：
  - root install plan
  - readiness checks
  - phase tests
  - packages build
  - daemon install smoke
  - preview smoke
- `Deploy production` job 在 `AGENTBEAN_DEPLOY_TARGET=next` 时，会先运行 `npm run check:agentbean-next-readiness -- --production`。
- `Publish agent to npm` job 在 `AGENTBEAN_NPM_PUBLISH_TARGET=next` 时，会先发布 `@agentbean/contracts`，再发布 `@agentbean/daemon-next`，最后发布由 daemon-next 生成的 canonical `@agentbean/daemon`。
- `workflow_dispatch` 可以把 `agentbean_npm_publish_target=next` 与 `agentbean_deploy_target=old` 组合使用，先发布 next npm packages 而不替换 Railway production deploy。
- `workflow_dispatch` 只有 `run_production_deploy=true` 时才会运行 Railway production deploy。
- `workflow_dispatch` 可以设置 `run_railway_preflight=true` 单独运行 `Railway Next preflight`，只读验证 Railway production runtime env 与 volume，不执行 `railway up`。
- `workflow_dispatch` 可以设置 `sync_railway_next_runtime_env=true` 单独运行 `Railway Next env sync`，把 GitHub Actions 中的 Next runtime env 写入 Railway variables，并使用 `--skip-deploys` 避免触发部署。
- `workflow_dispatch` 可以设置 `run_agentbean_next_production_smoke=true`，对输入 `agentbean_next_entry_url` 或 repository variable `AGENTBEAN_NEXT_ENTRY_URL` 指向的 URL 运行 production smoke。final flip 前，该 job 会先运行 ready-to-flip audit；final flip 后，该 job 会先运行 strict cutover audit，再运行 public entry smoke 与 business smoke。Actions 中的 audit 会使用 job 注入的 production variables/secrets；其中 smoke 目标 URL 可由 workflow input 覆盖，但 strict audit 的 entry URL 来自 repository variable `AGENTBEAN_NEXT_ENTRY_URL` 的专用注入值。本地 audit 缺少 env 时会回退到 GitHub CLI 只读查询。
- `workflow_dispatch` 可以设置 `run_agentbean_old_production_smoke=true`，对输入 `agentbean_old_entry_url`、`agentbean_next_entry_url` 或 repository variable `AGENTBEAN_NEXT_ENTRY_URL` 指向的 URL 运行 old entry smoke，用于 rollback 后证明公开入口已经回到旧 AgentBean。
- `workflow_dispatch` 手动执行 `agentbean_deploy_target=next` 且 `run_production_deploy=true` 时，仓库变量 `AGENTBEAN_DEPLOY_TARGET` 也必须已经是 `next`。workflow input alone 不是最终生产开关，不能绕过 repository variable 的 final flip。
- `workflow_dispatch` 手动执行 `agentbean_deploy_target=old` 且 `run_production_deploy=true` 时，必须同时设置 `run_agentbean_old_production_smoke=true`。CI 会阻止 rollback/old deploy 的反向只切不验。
- production readiness 会检查：
  - `AGENTBEAN_DEPLOY_TARGET=next`
  - `RAILWAY_TOKEN`
  - `AGENTBEAN_NEXT_SESSION_SECRET`
  - `AGENTBEAN_NEXT_DATA_DIR`
  - `AGENTBEAN_NEXT_DATA_DIR` 不使用本地 `.agentbean-next` fallback
  - `@agentbean/contracts` 与 `@agentbean/daemon-next` package manifests 可发布。
  - `@agentbean/daemon-next` 依赖 registry 版 `@agentbean/contracts` 与 `socket.io-client`。
  - canonical `@agentbean/daemon` next release 版本高于当前旧 daemon `0.1.35`。
  - CI 在 build 后执行 daemon install smoke，验证 canonical `@agentbean/daemon` tarball 能在临时空项目安装，并且旧 `daemon` / `agentbean-daemon` bin 能进入 daemon-next CLI。
- external cutover audit 会只读检查 GitHub variables、GitHub secrets、`AGENTBEAN_NEXT_ENTRY_URL` production smoke URL 与 npm registry next package versions。
- public entry smoke 会检查公开入口的 `/healthz`、根页面 HTML 与 Socket.IO client route，防止最终访问入口仍落在旧 Vercel 或临时 harness 页面。
- business smoke 会通过 Socket.IO 注册临时用户/team、连接 daemon、创建 custom agent、发送消息并等待 agent reply，防止只验证入口而没有验证真实业务链路。
- persistence smoke 会在同一个 SQLite data dir 下启动 server-next 两次，验证 token session、current team、channel/message history 能在重启后恢复。
- old entry smoke 会检查公开入口的旧生产 `/healthz` 返回 `{ "status": "ok" }`，并拒绝 AgentBean Next 的 `{ "ok": true, "service": "agentbean-next-server" }` 健康载荷，防止 rollback 后实际仍停在 Next server。

切换前真实外部配置状态：

- GitHub repository variables 当前已有 `AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next`。
- GitHub repository variable `AGENTBEAN_NEXT_ENTRY_URL=https://api.agentbean.dev` 已指向当前 production Railway backend 入口；final flip 后同一入口应返回 AgentBean Next 的 `/healthz` 与业务 smoke。
- GitHub repository secrets 当前已有 `RAILWAY_TOKEN`、`NPM_TOKEN` 与 `AGENTBEAN_NEXT_SESSION_SECRET`。
- npm registry 当前已发布：
  - `@agentbean/contracts@0.2.0`
  - `@agentbean/daemon-next@0.2.0`
  - canonical `@agentbean/daemon@0.2.0`
- GitHub Actions run `27067398886` 已真实运行 `Railway Next env sync` 并通过：
  - production readiness `23/23`
  - Railway preflight `11/11`
  - production volume 存在且覆盖 `/data/agentbean-next`
  - Railway variables 包含 `AGENTBEAN_NEXT_DATA_DIR` 与 `AGENTBEAN_NEXT_SESSION_SECRET`
- 本机当前没有安装 `railway` CLI。

该段记录的是 final flip 前的生产配置证据。final flip 后的生产观察与后续产品缺口，以 `post-flip-gap-audit.md` 与 `post-flip-follow-up-status.md` 为准。

如果已经有可访问的 AgentBean Next 部署 URL，可以先不部署、只运行生产 smoke：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f agentbean_deploy_target=old \
  -f agentbean_npm_publish_target=old \
  -f run_production_deploy=false \
  -f run_railway_preflight=false \
  -f sync_railway_next_runtime_env=false \
  -f run_agentbean_next_production_smoke=true \
  -f agentbean_next_entry_url=https://<production-host>
```

该 job 只运行 `smoke:agentbean-next-entry` 与 `smoke:agentbean-next-business`，不会执行 Railway deploy，也不会发布 npm。

如果需要在回滚或 old-target deploy 后单独验证旧生产入口，可以运行：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f agentbean_deploy_target=old \
  -f agentbean_npm_publish_target=old \
  -f run_production_deploy=false \
  -f run_railway_preflight=false \
  -f sync_railway_next_runtime_env=false \
  -f run_agentbean_next_production_smoke=false \
  -f run_agentbean_old_production_smoke=true \
  -f agentbean_old_entry_url=https://api.agentbean.dev
```

该 job 只运行 `smoke:agentbean-old-entry`，不会执行 Railway deploy，也不会发布 npm。

## 切换前必备配置

### GitHub Actions

已设置：

```bash
gh secret set AGENTBEAN_NEXT_SESSION_SECRET --repo xiaojichao/agentbean
gh variable set AGENTBEAN_NEXT_DATA_DIR --repo xiaojichao/agentbean --body /data/agentbean-next
```

暂时不要设置：

```bash
gh variable set AGENTBEAN_DEPLOY_TARGET --repo xiaojichao/agentbean --body next
```

这一步是最后的 flip。`AGENTBEAN_DEPLOY_TARGET=next` 是 repository variable，不是 workflow dispatch input；CI 会阻止只靠 `agentbean_deploy_target=next` input 的手动 Next production deploy。

## 先发布 Next npm Packages

在 production deploy 仍保持旧 AgentBean 时，已经通过以下命令发布 next npm packages：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f agentbean_deploy_target=old \
  -f agentbean_npm_publish_target=next \
  -f run_production_deploy=false
```

已确认：

- `Publish agent to npm` 会执行。
- `Install and build AgentBean Next npm packages` 会执行。
- 缺失的 next packages 已按顺序发布：
  - `@agentbean/contracts@0.2.0`
  - `@agentbean/daemon-next@0.2.0`
  - canonical `@agentbean/daemon@0.2.0`
- `Deploy production` 未运行，因为 `run_production_deploy=false`。

发布完成后再次运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-cutover
```

pre-flip 时，npm registry、data dir 与 session secret 相关检查已经通过；严格 production flip 仍会因为 `AGENTBEAN_DEPLOY_TARGET=next` 尚未打开而保持红灯。

## 本地重启持久化 Smoke

final flip 前先在本机运行 SQLite 重启持久化 smoke：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run smoke:agentbean-next-persistence
```

预期：

- 脚本创建临时 SQLite data dir。
- 第一次 server-next 启动后写入 session/team/channel/message。
- server-next 关闭并使用同一个 data dir 第二次启动。
- `auth:whoami` 能恢复 token session 与 current team。
- `channel:join` 能恢复 channel/message history。

这个 smoke 证明 server-next 的 SQLite restart 路径可用；它不等同于 Railway production volume 已验证。Railway volume 仍必须在 final flip 后用 production smoke 或等价 one-off 环境复核。

### Railway

需要在当前 production Railway service 上完成：

- 绑定持久化 volume。
- 确认 volume mount path 与 `AGENTBEAN_NEXT_DATA_DIR` 一致。
- 设置 runtime env：
  - `AGENTBEAN_NEXT_SESSION_SECRET`
  - `AGENTBEAN_NEXT_DATA_DIR`
- 确认服务仍使用同一个 production service、project 与 environment。

如果 GitHub Actions 与 Railway runtime env 使用不同来源，必须保持值一致；尤其是 `AGENTBEAN_NEXT_DATA_DIR`。

完成后，先运行只读 preflight，不要部署：

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

预期：

- `Deploy production` 不运行。
- `Publish agent to npm` 不运行。
- `Railway Next preflight` 运行并通过。
- `Run AgentBean Next production readiness checks` 通过。
- `Run Railway AgentBean Next preflight` 通过。
- preflight 日志只输出检查项通过/失败，不输出 `AGENTBEAN_NEXT_SESSION_SECRET` 明文。

如果 preflight 仅缺少 Railway variables，先运行显式 env sync：

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

预期：

- `Deploy production` 不运行。
- `Publish agent to npm` 不运行。
- `Railway Next env sync` 运行。
- `Sync Railway AgentBean Next runtime env` 使用 `--skip-deploys`，不会触发 Railway deploy。
- `Verify Railway AgentBean Next preflight` 通过。

截至 run `27067398886`，上述 env sync 已真实执行并通过。

## 切换前本地验证

在本机或 CI-like 环境运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_DEPLOY_TARGET=next RAILWAY_TOKEN=dummy AGENTBEAN_NEXT_SESSION_SECRET=dummy-secret AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next npm run check:agentbean-next-readiness -- --production
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_ENTRY_URL=http://127.0.0.1:4110 npm run smoke:agentbean-next-entry
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_ENTRY_URL=http://127.0.0.1:4110 npm run smoke:agentbean-next-business
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_OLD_ENTRY_URL=https://api.agentbean.dev npm run smoke:agentbean-old-entry
```

预期：

- 默认 readiness 通过。
- 显式注入 production env 后，production readiness 通过。
- phase tests、packages build 与 preview smoke 通过。
- daemon install smoke 通过：本地 pack contracts 与 canonical daemon tarball，临时安装后验证三个 bin。
- entry smoke 通过：`/healthz` 返回 `agentbean-next-server`，根页面返回 `AgentBean` 产品 preview shell，`/socket.io/socket.io.js` 可访问。
- business smoke 通过：临时用户/team、daemon socket、custom agent、message dispatch 与 agent reply 均可用。
- old entry smoke 在 production 仍指向旧 AgentBean 时通过：旧生产 `/healthz` 返回 `{ "status": "ok" }`，且不是 AgentBean Next server health payload。
- next 目标发布时，npm job 会跳过已存在版本，并只发布缺失版本。
- canonical `@agentbean/daemon` next release package 保留旧 `daemon` 与 `agentbean-daemon` bin。

## 外部 Cutover Audit

在等待用户批准最终开关时，先运行 ready-to-flip audit：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-ready-to-flip
```

预期：

- 除 `AGENTBEAN_DEPLOY_TARGET=next` 之外，GitHub variables、GitHub secrets、production smoke URL 与 npm registry next package versions 全部通过。
- 命令返回成功，表示当前状态已经准备好等待最终开关；它不等同于已经替换旧 AgentBean。

在真正 flip 前运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-cutover
```

预期：

- GitHub variable `AGENTBEAN_DEPLOY_TARGET` 已设置为 `next`。
- GitHub variable `AGENTBEAN_NEXT_DATA_DIR` 指向 production Railway volume path。
- GitHub variable `AGENTBEAN_NEXT_ENTRY_URL` 指向可访问的 production URL，或 workflow dispatch 显式提供 `agentbean_next_entry_url`。
- GitHub secrets 已包含 `RAILWAY_TOKEN`、`NPM_TOKEN` 与 `AGENTBEAN_NEXT_SESSION_SECRET`。
- npm registry 已包含 `@agentbean/contracts`、`@agentbean/daemon-next` 与 canonical `@agentbean/daemon` 的 next version。

pre-flip 外部状态下，严格 cutover audit 预期只会因为 `AGENTBEAN_DEPLOY_TARGET=next` 尚未打开而失败。这个失败项是最终开关，不应在没有用户明确批准时提前设置。

## Production Flip

只有完成 GitHub Actions 与 Railway 必备配置，并获得用户明确批准后，才能执行：

```bash
gh variable set AGENTBEAN_DEPLOY_TARGET --repo xiaojichao/agentbean --body next
```

随后推送一个 no-op 或运行 workflow dispatch 触发 production deploy。

如果使用 workflow dispatch 触发 `agentbean_deploy_target=next` 与 `run_production_deploy=true`，必须先设置 repository variable `AGENTBEAN_DEPLOY_TARGET=next`，并同时设置 `run_agentbean_next_production_smoke=true`。CI 会阻止只靠 workflow input 的临时 Next deploy，也会阻止只切不验的手动 Next production deploy。

如果使用 workflow dispatch 触发 `agentbean_deploy_target=old` 与 `run_production_deploy=true`，必须同时设置 `run_agentbean_old_production_smoke=true`。CI 会阻止反向只切不验的手动 rollback/old production deploy。

如果通过 repository variable `AGENTBEAN_DEPLOY_TARGET=next` 后推送 `main` 触发生产部署，CI 会在 push run 的 deploy 成功后自动运行 `AgentBean Next production smoke`。

部署时必须确认：

- `Validate AgentBean Next` 通过。
- `Railway Next preflight` 已在同一批生产配置上通过。
- `Deploy production` 中的 `Run AgentBean Next production readiness checks` 被执行，不是 skipped。
- `Run AgentBean Next production readiness checks` 通过。
- Railway deploy 成功；如果 Railway CLI 卡住，`timeout 8m railway up` 会让单次尝试有界失败，整个 deploy job 不应无限等待。
- `AgentBean Next production smoke` 在 final flip 前先运行 ready-to-flip audit，确认除最终开关外的外部状态没有漂移。
- `AgentBean Next production smoke` 在 final flip 后先运行 strict cutover audit，确认 repository variable `AGENTBEAN_DEPLOY_TARGET=next` 也已经生效。
- `AgentBean Next production smoke` 成功，至少覆盖 public entry smoke 与 business smoke。

## 生产 Smoke

部署完成后检查：

```bash
curl -fsS https://<production-host>/healthz
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_ENTRY_URL=https://<production-host> npm run smoke:agentbean-next-entry
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_ENTRY_URL=https://<production-host> npm run smoke:agentbean-next-business
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run smoke:agentbean-next-persistence
```

预期：

- `/healthz` 返回健康状态。
- 根页面是 AgentBean Next 的 `AgentBean` 产品 preview shell，不是旧 Vercel web 或 `AgentBean Next Preview` harness。
- Socket.IO client route 可访问。
- 临时用户注册、current team、daemon 连接、custom agent 创建、消息 dispatch 与 agent reply 全部成功。
- 本地 SQLite 重启 smoke 可以恢复 session/team/channel/message。

随后用真实浏览器或等价客户端验证：

- 注册或登录。
- current team 可恢复。
- 创建 custom agent。
- daemon-next 连接到同一 team。
- 发送 human message。
- agent reply 可见。
- 重启 server 后，SQLite volume 中的 session/team/channel/message 仍保留；如果可以在 Railway one-off 环境访问同一个 volume，则用 `npm run smoke:agentbean-next-persistence -- --data-dir "$AGENTBEAN_NEXT_DATA_DIR" --keep-data` 做等价复核。

## Rollback

如果 production smoke 失败，立即切回旧系统：

```bash
gh variable set AGENTBEAN_DEPLOY_TARGET --repo xiaojichao/agentbean --body old
```

随后重新触发 production deploy，并确认：

- `Deploy production` 使用旧 `apps/server` deploy path。
- `Run AgentBean Next production readiness checks` skipped。
- 旧生产 `/healthz` 恢复。
- `Old AgentBean production smoke` 通过。

推荐使用 workflow dispatch 同时部署 old target 并运行 old entry smoke：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f agentbean_deploy_target=old \
  -f agentbean_npm_publish_target=old \
  -f run_production_deploy=true \
  -f run_railway_preflight=false \
  -f sync_railway_next_runtime_env=false \
  -f run_agentbean_next_production_smoke=false \
  -f run_agentbean_old_production_smoke=true \
  -f agentbean_old_entry_url=https://api.agentbean.dev
```

本机也可以直接复核：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_OLD_ENTRY_URL=https://api.agentbean.dev npm run smoke:agentbean-old-entry
```

Rollback 后保留 AgentBean Next 的 Railway volume，不要删除。先保存失败日志和 smoke 记录，再决定是否清理数据。

## 仍未完成

- 用户明确批准 final production flip。
- production deploy flip。
- production browser smoke。
- 如果旧 Vercel web 仍是主要用户入口，需要单独决定用户访问入口是继续使用旧 Vercel、改 Vercel 指向 AgentBean Next，还是由 Railway server-next 托管 preview/正式界面。

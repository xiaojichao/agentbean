# AgentBean Next 生产切换 Runbook

本文档描述如何把生产部署从旧 AgentBean 切换到 AgentBean Next。它是操作清单，不是自动切换脚本。

## 状态更新

截至 2026-06-12，AgentBean Next final flip 已经完成，post-flip strict cutover audit、production entry smoke、business smoke 与 browser smoke gate 已进入主线验证。当前 follow-up 状态见 `post-flip-follow-up-status.md`。

本文后续仍保留切换前 gate、manual deploy、rollback 与 smoke 的历史说明，供回放和审计使用；不要把下方历史 pre-flip 状态误读为当前仍未切换，也不要据此执行 old-target rollback。Release A 当前限制以本文“Rollback”章节为准。

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

以下命令只验证一个已经完成且已经单独批准的 old-target deploy，不授权执行 rollback。Release A 当前 old-target rollback 已冻结，不得先运行部署再用 smoke 补证：

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

## 推进 npm canonical daemon latest 到 daemon-next

canonical npm 包 `@agentbean/daemon` 已发布基于 daemon-next 的 `0.2.0`，且 npm `@latest` dist-tag 已推进到 `0.2.0`（2026-06-17 核对：`latest=0.2.0`，`legacy=0.1.35`）。默认 `npm install @agentbean/daemon` 现在安装 daemon-next；旧守护进程保留在 `legacy` dist-tag 作为 rollback 入口。

默认 npm 安装入口的受控推进使用 gated、按需触发的 workflow；已推进后，该 workflow 仍可作为显式重跑/防回退核验路径：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f promote_agentbean_daemon_latest=true \
  -f agentbean_npm_publish_target=next
```

已确认：

- `Promote canonical daemon npm latest` job 会执行，且仅在 `AGENTBEAN_NPM_PUBLISH_TARGET` 解析为 `next` 时才允许推进（rollback/old 模式会被拒绝）；命令必须同时传入 `agentbean_npm_publish_target=next`，否则 workflow_dispatch 默认值会解析为 `old` 并被 gate 拒绝。
- 如果 `NPM_TOKEN` 缺失，promote job 会失败而不是静默跳过，避免维护者看到绿色 workflow 却没有推进 npm `latest`。
- job 读取 `apps/daemon-next/package.json` 的版本，校验对应 canonical `@agentbean/daemon@<version>` 已发布，再执行 `npm dist-tag add @agentbean/daemon@<version> latest`，最后回读 `dist-tags.latest` 校验已落到 daemon-next。
- promote job 会先把当前旧 `apps/daemon` 版本补打为 `@agentbean/daemon@legacy`，再推进 `latest` 到 daemon-next，确保 `npm install @agentbean/daemon@legacy` 在默认入口切换后仍可作为 rollback 入口。
- 当 `AGENTBEAN_NPM_PUBLISH_TARGET=next` 时，旧 `apps/daemon` 包以 `--tag legacy` 发布，并会对已发布版本显式补打 `legacy` tag，不会再回占 npm `latest`。
- strict cutover audit 在 final flip 后会要求 npm `@latest` dist-tag 已指向 daemon-next；如果只发布了 `@agentbean/daemon@0.2.0` 但没有推进 `latest`，production smoke 会继续失败。

推进前后可用以下命令核对：

```bash
npm view @agentbean/daemon dist-tags --registry=https://registry.npmjs.org
```

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

历史 workflow gate 要求 `agentbean_deploy_target=old` 与 `run_production_deploy=true` 必须同时设置 `run_agentbean_old_production_smoke=true`，但这只防止反向只切不验，不证明 schema rollback 安全。Release A 当前不得触发该 old-target deploy，限制见“Rollback”章节。

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

### Release A 当前限制

Release A 前 global SQLite backup 没有可验证证据，而 production global DB 已应用 `global/0014_device_revocations_team_columns.sql`。因此 **不得** 直接把 `AGENTBEAN_DEPLOY_TARGET` 切为 `old`，也不得按历史 workflow-dispatch 示例把旧 `apps/server` 部署到当前 production volume。实施计划要求旧 binary 回滚时恢复 Release A 前 global DB backup；当前不存在满足该合同的恢复点。

发布后写入同一 production volume 的 SQLite 文件只是观察快照。它们已包含迁移后的 schema，只能在停止写入、确认目标 Next deployment 与该 schema 兼容、并由 operator 明确批准后作为逻辑状态恢复候选；它们不是 old binary rollback point，也不能覆盖 volume 丢失或损坏。当前尚无 off-volume copy、保留期或恢复演练证据。

### 当前允许的事故恢复路径

如果观察期 production smoke、日志或数据校验失败：

1. 停止 Release B 和后续 production deploy，保存失败日志、deployment ID、当前 global/team DB metadata 与 incident 时间线。
2. 保持 `AGENTBEAN_DEPLOY_TARGET=next`。代码回滚只允许选择已知兼容 `0014` schema 的上一成功 AgentBean Next Railway deployment，或 revert 到同样兼容该 schema 的 AgentBean Next commit 后重新部署。
3. 回滚后重新运行 strict cutover audit、public entry smoke、business smoke，以及与故障面对应的 browser/SQLite 验证；把 run/deployment URL 写入验收矩阵的观察台账。
4. 涉及 SQLite 数据恢复时先停止所有写入。只有确认快照时间点、目标 schema、影响范围和恢复命令后才能执行；本 runbook 当前不提供未经演练的 production restore 命令。
5. 若唯一可行方案需要旧 binary，保持服务冻结并升级为人工 incident 决策；必须先建立迁移前兼容备份或经过验证的 reverse migration/restore 方案，完成恢复演练后才可解除 old-target rollback 冻结。

无论采取哪条路径，都保留 AgentBean Next Railway volume，不要删除或覆盖现场数据。`Old AgentBean production smoke` 只用于未来已经满足 schema 恢复前提的受控 old-target 演练；它不能证明当前 old-target rollback 安全。

## Release A 当前生产状态（2026-07-11）

- PR #470 已 squash merge 为 `c31ce9d955d0dfb7f9407a6d5724763568a60b7b`。
- main-push [CI/CD Run #996](https://github.com/xiaojichao/agentbean/actions/runs/29134937662) 已完成且结论为 `success`。
- Railway deployment `58e4c03e-1e73-4513-85c7-74705709b488` 已成功，production service 使用 `/data` volume。
- strict cutover audit `12/12`、entry smoke `4/4`、business smoke `8/8` 均针对 production 通过；GitHub-hosted combined browser gate `39/39` 通过。`2026-07-11 19:09`（Asia/Shanghai）又从最新 `main` `8bd3bbbf646518a154f7ccf8d99f719f8ce0c17e` 对 `https://api.agentbean.dev` 执行 production-host combined browser gate，结果同为 `39/39`，preview/WebUI console clean。
- PR #471、#475、#476 与 #473 均在观察窗口内触发 production deploy；对应 main runs [29136243401](https://github.com/xiaojichao/agentbean/actions/runs/29136243401)、[29146998708](https://github.com/xiaojichao/agentbean/actions/runs/29146998708)、[29147805169](https://github.com/xiaojichao/agentbean/actions/runs/29147805169)、[29149484675](https://github.com/xiaojichao/agentbean/actions/runs/29149484675) 的 deploy 与 production smoke 全部成功。频道 stale Team incident 已由 #475 关闭，完整时间线见验收矩阵观察台账。
- Release A 发布后 SQLite 观察快照位于 `/data/agentbean-next/backups/release-a-observation/`；global/team 两份快照均为 `integrity_check=ok`、权限 `0600`。完整路径、size、SHA256 与 migration ledger 记录在 `phase-minus-1-team-terminology-verification-matrix.md`。
- P-1-05 production inspection 已完成：普通 profile 与 `NULL profile_id` revocation 行均存在，复合主键和 machine index 正确，两类 Device 删除后重连均返回 `DEVICE_REVOKED`；P-1-08 production storage inspection 也已确认旧 key 首次读取后写入 `agentbean.teamPath` 并删除旧键。证据链接见验收矩阵。
- 计划要求的发布前 global SQLite backup 没有可验证证据；发布后快照不能冒充发布前备份，old-target schema rollback 当前冻结。
- 观察窗口为 `2026-07-11 09:41:41` 至 `2026-07-18 09:41:41`（Asia/Shanghai）。窗口结束并满足退出条件前，不执行 Release B。

## 仍未完成

- 7 天观察期内按验收矩阵台账每天及每次 deploy/incident 后检查：旧 Team path 首次迁移、login/device-login redirect 404、Artifact upload 404/403、Admin DTO rendering error、SQLite migration error 和已撤销 Device 重连。
- 补齐 `device-login` redirect 与 production Admin DTO rendering 的独立观察记录；`/login`、Artifact、SQLite migration、production browser、P-1-05 revocation 与 P-1-08 storage migration 已有 production 证据。
- 观察窗口结束后只有在台账完整、所有阈值通过、incident 全部关闭、最终 smoke 复验和 verification-only sign-off 完成时，才决定是否执行 Release B；日期到点本身不是退出证据。
- 如果旧 Vercel web 仍是主要用户入口，需要单独决定用户访问入口是继续使用旧 Vercel、改 Vercel 指向 AgentBean Next，还是由 Railway server-next 托管 preview/正式界面。

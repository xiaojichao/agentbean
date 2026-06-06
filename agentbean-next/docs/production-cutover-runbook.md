# AgentBean Next 生产切换 Runbook

本文档描述如何把生产部署从旧 AgentBean 切换到 AgentBean Next。它是操作清单，不是自动切换脚本。

## 当前状态

截至第四十一切片，仓库内替换前 gate 已具备：

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
- external cutover audit 会只读检查 GitHub variables、GitHub secrets 与 npm registry next package versions。

当前真实外部配置状态：

- GitHub repository variables 当前已有 `AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next`。
- GitHub repository secrets 当前已有 `RAILWAY_TOKEN`、`NPM_TOKEN` 与 `AGENTBEAN_NEXT_SESSION_SECRET`。
- npm registry 当前已发布：
  - `@agentbean/contracts@0.2.0`
  - `@agentbean/daemon-next@0.2.0`
  - canonical `@agentbean/daemon@0.2.0`
- 本机当前没有安装 `railway` CLI。

因此，现在还不能直接 flip 到 `next`。剩余关键门槛是让 `Railway Next preflight` 在 GitHub Actions 中通过，然后再打开 `AGENTBEAN_DEPLOY_TARGET=next`。

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

这一步是最后的 flip。

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

此时 npm registry、data dir 与 session secret 相关检查已经通过；真正 production flip 仍会因为 `AGENTBEAN_DEPLOY_TARGET=next` 尚未打开而保持红灯。

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
  -f run_railway_preflight=true
```

预期：

- `Deploy production` 不运行。
- `Publish agent to npm` 不运行。
- `Railway Next preflight` 运行并通过。
- `Run AgentBean Next production readiness checks` 通过。
- `Run Railway AgentBean Next preflight` 通过。
- preflight 日志只输出检查项通过/失败，不输出 `AGENTBEAN_NEXT_SESSION_SECRET` 明文。

## 切换前本地验证

在本机或 CI-like 环境运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_DEPLOY_TARGET=next RAILWAY_TOKEN=dummy AGENTBEAN_NEXT_SESSION_SECRET=dummy-secret AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next npm run check:agentbean-next-readiness -- --production
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
```

预期：

- 默认 readiness 通过。
- 显式注入 production env 后，production readiness 通过。
- phase tests、packages build 与 preview smoke 通过。
- daemon install smoke 通过：本地 pack contracts 与 canonical daemon tarball，临时安装后验证三个 bin。
- next 目标发布时，npm job 会跳过已存在版本，并只发布缺失版本。
- canonical `@agentbean/daemon` next release package 保留旧 `daemon` 与 `agentbean-daemon` bin。

## 外部 Cutover Audit

在真正 flip 前运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-cutover
```

预期：

- GitHub variable `AGENTBEAN_DEPLOY_TARGET` 已设置为 `next`。
- GitHub variable `AGENTBEAN_NEXT_DATA_DIR` 指向 production Railway volume path。
- GitHub secrets 已包含 `RAILWAY_TOKEN`、`NPM_TOKEN` 与 `AGENTBEAN_NEXT_SESSION_SECRET`。
- npm registry 已包含 `@agentbean/contracts`、`@agentbean/daemon-next` 与 canonical `@agentbean/daemon` 的 next version。

当前外部状态下，此 audit 预期只剩 `AGENTBEAN_DEPLOY_TARGET=next` 一项失败；失败本身就是禁止 production flip 的证据。

## Production Flip

只有完成 GitHub Actions 与 Railway 必备配置后，才能执行：

```bash
gh variable set AGENTBEAN_DEPLOY_TARGET --repo xiaojichao/agentbean --body next
```

随后推送一个 no-op 或运行 workflow dispatch 触发 production deploy。

部署时必须确认：

- `Validate AgentBean Next` 通过。
- `Railway Next preflight` 已在同一批生产配置上通过。
- `Deploy production` 中的 `Run AgentBean Next production readiness checks` 被执行，不是 skipped。
- `Run AgentBean Next production readiness checks` 通过。
- Railway deploy 成功。

## 生产 Smoke

部署完成后检查：

```bash
curl -fsS https://<production-host>/healthz
```

预期返回健康状态。

随后用真实浏览器或等价客户端验证：

- 注册或登录。
- current team 可恢复。
- 创建 custom agent。
- daemon-next 连接到同一 team。
- 发送 human message。
- agent reply 可见。
- 重启 server 后，SQLite volume 中的 session/team/channel/message 仍保留。

## Rollback

如果 production smoke 失败，立即切回旧系统：

```bash
gh variable set AGENTBEAN_DEPLOY_TARGET --repo xiaojichao/agentbean --body old
```

随后重新触发 production deploy，并确认：

- `Deploy production` 使用旧 `apps/server` deploy path。
- `Run AgentBean Next production readiness checks` skipped。
- 旧生产 `/healthz` 恢复。

Rollback 后保留 AgentBean Next 的 Railway volume，不要删除。先保存失败日志和 smoke 记录，再决定是否清理数据。

## 仍未完成

- 真实运行 `Railway Next preflight`。
- production deploy flip。
- production browser smoke。
- 如果旧 Vercel web 仍是主要用户入口，需要单独决定用户访问入口是继续使用旧 Vercel、改 Vercel 指向 AgentBean Next，还是由 Railway server-next 托管 preview/正式界面。

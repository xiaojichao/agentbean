# CI/CD

本仓库使用 GitHub Actions 做校验、npm 发版与生产部署。生产唯一后端/前端入口为 **AgentBean Next**（`server-next` 托管 `web-next`），设备端通过 npm 发布的 `@agentbean/daemon` 接入。

旧实现（`apps/web` / `apps/server` / `apps/daemon`）已从主线退役，流水线不再构建、测试或部署它们。

---

## 工作流一览

| 工作流文件 | 触发 | 作用 |
|------------|------|------|
| `.github/workflows/ci-cd.yml` | PR / push `main` / 手动 `workflow_dispatch` | 校验、npm 发布、Railway 部署、生产 smoke |
| `.github/workflows/pi-sea-compatibility.yml` | 相关路径变更的 PR / push `main`、手动 | Linux / macOS / Windows 上的 PI Management SEA 兼容性 verdict |
| `.github/workflows/daily-changelog.yml` | 定时（上海时区次日 00:10 对应 UTC 16:10）/ 手动 | 更新 `CHANGELOG.md` 与 `releases.generated.ts` 并推回 `main` |

Node 版本固定为 **24.18.0**（与仓库 `engines.node: 24.x` 一致）。

---

## 主流水线（ci-cd.yml）

### 触发与并发

- **Pull Request → `main`**：只做校验；并发组可取消进行中的旧 PR 运行。
- **Push → `main`**：校验通过后，按变更面决定是否 publish / deploy / production smoke；**不**取消进行中的 main 运行（避免中断发版与部署）。
- **手动 `workflow_dispatch`**：可单独打开 preflight、环境同步、生产部署、生产 smoke、提升 npm `latest`、跳过 npm 等开关。

### 变更面检测

`scripts/detect-ci-changes.mjs` 根据 diff 路径输出四个开关：

| 输出 | 含义 |
|------|------|
| `should_validate` | 是否跑完整 Next 校验（测试、构建、非浏览器 smoke） |
| `should_browser_smoke` | 是否跑昂贵的 Chrome 浏览器 smoke |
| `should_publish` | main 是否进入 npm 发布 job |
| `should_deploy` | main 是否进入 Railway 生产部署 |

手动 `workflow_dispatch` 会强制全部为 `true`。纯文档、与 Next 无关的路径可跳过校验。

典型路径归属（摘要）：

- **校验**：`apps/*-next/`、`packages/*`、相关 `scripts/`、`railway.json`、工作流、`package.json` 等
- **浏览器 smoke**：`apps/web-next`、`apps/server-next`、相关 browser smoke 脚本
- **发布**：`apps/daemon-next`、`packages/contracts`、`packages/pi-management-runtime`、发版准备脚本
- **部署**：`apps/server-next`、`apps/web-next`、共享 packages、Railway 配置与生产相关 smoke/审计脚本（生产 Server 会构建并托管 Web）

### Job 依赖关系

```text
validate-agentbean-next
  ├── publish                    （main 且 should_publish，或手动发版）
  │     └── deploy               （main 且 should_deploy，或手动生产部署；publish 可为 skipped）
  │           └── agentbean-next-production-smoke
  ├── railway-next-preflight     （仅手动）
  ├── railway-next-env-sync      （仅手动）
  └── promote-agentbean-daemon-latest （仅手动）
```

### 1. Validate AgentBean Next

当 `should_validate=true` 时依次执行：

1. `npm ci`
2. `npm run check:agentbean-next-readiness`
3. Team 术语检查（`test:team-terminology` + `check:team-terminology`）
4. `npm run test:ci`（包测试 + 保留的 phase 边界）
5. `npm run build:packages`（contracts → domain → pi-management-runtime → server-next → daemon-next → web-next）
6. 校验 `apps/web-next/lib/releases.generated.ts` 与 `CHANGELOG.md` 生成结果一致
7. Daemon 安装 smoke（`smoke:agentbean-next-daemon-install`）
8. Preview 业务 e2e（vitest：runtime capability → custom agent → message → daemon reply）
9. 若 `should_browser_smoke=true`：Chrome 浏览器 smoke（失败自动重试一次，产物上传 artifact）

### 2. Publish（npm）

仅在校验成功且命中发布面时运行。发布顺序：

1. 校验 `@agentbean/daemon` 的 `legacy` dist-tag **固定为** `0.1.35`（历史归档，不可连接 server-next）
2. 构建 contracts、pi-management-runtime、daemon-next
3. `prepare-agentbean-next-daemon-release` 生成 canonical `@agentbean/daemon` 包
4. 按版本是否已存在决定是否 `npm publish`：
   - `@agentbean/contracts`
   - `@agentbean/pi-management-runtime`
   - `@agentbean/daemon-next`（发布前对已发布 contracts 做 dist smoke）
   - `@agentbean/daemon`（canonical 设备安装包）
5. 新发布 canonical daemon 时，将其 `dist-tag` 提升为 `latest` 并轮询确认传播

**版本感知**：若目标版本已在 registry，该包跳过发布并给出 notice/warning。  
**重要**：改了 daemon 代码但未 bump `apps/daemon-next/package.json` 版本时，CI 会“成功”但**不会**发出新包，`agentbean update` 仍停留在旧版本。

缺少 `NPM_TOKEN` 时 **fail closed**（报错退出，不会静默跳过）。

### 3. Deploy production（Railway）

条件（摘要）：

- 校验成功，且 `publish` 为 success 或 skipped
- `main` push 且 `should_deploy=true`，或手动勾选 `run_production_deploy`

部署前：

- 要求 `RAILWAY_TOKEN`（缺失则失败）
- 手动部署时禁止 `skip_npm_publish=true`
- 手动部署时必须同时打开 `run_agentbean_next_production_smoke`
- `check:agentbean-next-readiness --production`（依赖 session secret、PI secret key、data dir 等）

部署命令（根目录，非旧 `apps/server`）：

```sh
railway up . --ci --path-as-root \
  --project c6b70675-f7d5-47a1-a8e7-05b37d13e476 \
  --service 7b1dce9b-b7e7-4cfb-bb3f-ef86d10e8647 \
  --environment e9c1a221-28b1-49c0-b279-be249a428737
```

- 最多 3 次尝试，单次 `timeout 8m`
- 构建/启动由根目录 `railway.json` 定义：`npm run build` / `npm start`，健康检查路径 `/healthz`
- 生产公开域：`https://api.agentbean.dev/`（Server 同时提供 API 与 Web UI）

### 4. Production smoke

在生产部署成功后（或手动仅跑 smoke 且校验通过）执行：

1. `audit:agentbean-next-cutover`（严格 cutover 审计）
2. 轮询 `$AGENTBEAN_NEXT_ENTRY_URL/healthz`（最多约 150s）
3. `smoke:agentbean-next-entry`（公开入口）
4. `smoke:agentbean-next-business`（业务链路）

入口 URL 来源：手动输入 `agentbean_next_entry_url`，否则使用仓库变量 `AGENTBEAN_NEXT_ENTRY_URL`。

### 5. 手动辅助 Job

| Job | 开关 | 说明 |
|-----|------|------|
| Railway Next preflight | `run_railway_preflight` | 只读检查 Railway 变量、卷与 data dir 覆盖，不部署 |
| Railway Next env sync | `sync_railway_next_runtime_env` | 同步 `AGENTBEAN_NEXT_DATA_DIR` / `SESSION_SECRET` / `PI_SECRET_KEY` 到 Railway（`--skip-deploys`），再跑 preflight |
| Promote daemon latest | `promote_agentbean_daemon_latest` | 将已发布的 `@agentbean/daemon@<daemon-next 版本>` 标为 `latest`（不重新 publish） |

---

## 其他工作流

### PI SEA 兼容性（pi-sea-compatibility.yml）

在 Linux x64、macOS arm64、Windows x64 上分别：

1. 初始化 fail-closed platform verdict
2. `npm ci` 后构建并执行 PI management SEA
3. `check:pi-sea-compatibility` 消费 verdict
4. 上传各平台 artifact，最后聚合 fail-closed 总 verdict

相关路径变更（`packages/pi-management-runtime`、contracts、domain、SEA 脚本等）才会触发。

### 每日更新日志（daily-changelog.yml）

1. 解析日期（定时用上海时区「昨天」，手动可用输入）
2. `scripts/update-daily-changelog.ts` 更新 `CHANGELOG.md`  
   - 可选调用 Server 内部摘要端点（`AGENTBEAN_CHANGELOG_SERVER_URL` + `AGENTBEAN_CHANGELOG_SERVER_TOKEN`）；未配置时 fail-open 跳过 LLM 兜底
3. 生成 `apps/web-next/lib/releases.generated.ts`
4. 有 diff 则 commit 并 push `main`（会再触发主 CI；内容-only 场景可用手动 dispatch + `skip_npm_publish`）

---

## GitHub Secrets 与 Variables

在仓库 **Settings → Secrets and variables → Actions** 中配置。

**原则**：密钥进 Secrets；稳定 ID 与非敏感路径可进 Variables 或写死在 workflow（便于 review）。

### Secrets（必填用于生产发版/部署）

| 名称 | 用途 |
|------|------|
| `RAILWAY_TOKEN` | Railway 生产部署、preflight、env sync |
| `NPM_TOKEN` | 发布 `@agentbean/*` 包；使用 scoped 到 `@agentbean` 的 Granular Access Token |
| `AGENTBEAN_NEXT_SESSION_SECRET` | server-next 生产会话密钥；部署 readiness / env sync / smoke 使用 |
| `AGENTBEAN_PI_SECRET_KEY` | PI Provider 凭据加密；Railway 运行时与 preflight 使用 |

### Secrets（可选）

| 名称 | 用途 |
|------|------|
| `AGENTBEAN_CHANGELOG_SERVER_URL` | 每日 changelog LLM 兜底：Server 基址 |
| `AGENTBEAN_CHANGELOG_SERVER_TOKEN` | 每日 changelog LLM 兜底：内部 Bearer |

### Variables（仓库级）

| 名称 | 用途 |
|------|------|
| `AGENTBEAN_NEXT_ENTRY_URL` | 生产 smoke / cutover 审计入口，例如 `https://api.agentbean.dev` |
| `AGENTBEAN_NEXT_DATA_DIR` | 生产 SQLite/存储根路径（须落在 Railway Volume 挂载下，且不能是本地 `.agentbean-next` 回退路径） |

### 写入 workflow 的 Railway 资源 ID

| 项 | 值 |
|----|-----|
| Project ID | `c6b70675-f7d5-47a1-a8e7-05b37d13e476` |
| Service ID | `7b1dce9b-b7e7-4cfb-bb3f-ef86d10e8647` |
| Environment ID | `e9c1a221-28b1-49c0-b279-be249a428737` |
| 公开域名 | `api.agentbean.dev` |

---

## 平台环境变量

### Railway（server-next 生产）

构建与启动见根目录 `railway.json`：

- 构建：`npm run build`（= `build:packages`）
- 启动：`npm start`（= `start:server-next`）
- 健康检查：`GET /healthz`

| 变量 | 说明 |
|------|------|
| `AGENTBEAN_NEXT_SESSION_SECRET` | 生产会话签名密钥（必需） |
| `AGENTBEAN_NEXT_DATA_DIR` | 持久化数据目录（必需，Volume 路径） |
| `AGENTBEAN_PI_SECRET_KEY` | PI Provider 密钥材料（必需） |
| `PORT` | 监听端口；设置后默认 SQLite + 托管 app 入口 |
| `CORS_ORIGIN` | 允许的浏览器 Origin（可逗号分隔） |
| `WEB_URL` | 对外 Web 基址（邀请/加入链接等；可与 API 同域） |
| `AGENT_BEAN_PUBLIC_SERVER_URL` | 设备连接等对外的 Server URL，例如 `https://api.agentbean.dev` |
| `AGENTBEAN_CHANGELOG_INTERNAL_TOKEN` | 内部 changelog 摘要端点 Bearer（可选） |
| `AGENT_BEAN_DAEMON_LATEST_VERSION` | 覆盖 daemon latest 探测（可选） |
| `AGENT_BEAN_DAEMON_NPM_REGISTRY_URL` | npm registry 覆盖（可选） |
| 各类 `AGENTBEAN_*` 特性开关 | 频道文件、预览处理器、message tracer 等 rollout / 运维开关 |

**Volume**：挂载路径须覆盖 `AGENTBEAN_NEXT_DATA_DIR`（例如数据在 `/data/...` 时挂载 `/data`）。

CI 可用 `sync_railway_next_runtime_env` 同步 session secret、PI secret key 与 data dir，再用 `run_railway_preflight` 只读校验。

### Vercel（可选前端预览）

生产 Web **由 Railway 上的 server-next 托管**，不是独立 Vercel 生产站。仓库仍保留 Vercel 配置用于 **Preview**（见 `vercel.json` 的 `ignoreCommand` → `scripts/vercel-ignore-build.sh`）：

- `main` 或触及 `apps/web-next` / `packages/contracts` 等时继续构建
- 文档-only、daemon-only、与前端无关变更可跳过构建

若仍使用 Vercel 项目，典型环境变量：

| 变量 | 说明 |
|------|------|
| `NEXT_PUBLIC_AGENT_BEAN_SERVER_URL` | 指向 API，例如 `https://api.agentbean.dev` |

更细的 ignore 规则见 `docs/deployment/vercel-preview-filter.md`。

---

## 部署后核对清单

向 `main` 推送（或手动生产 dispatch）后：

1. **GitHub Actions**：`CI/CD` workflow 状态；确认 validate / publish / deploy / production smoke 预期是否运行。
2. **Railway**：`curl -sf https://api.agentbean.dev/healthz` 返回成功。
3. **Web**：浏览器打开 `https://api.agentbean.dev/`，确认可登录与加载。
4. **npm**（若触发发布）：
   ```bash
   npm view @agentbean/daemon dist-tags --registry=https://registry.npmjs.org
   npm view @agentbean/daemon-next version --registry=https://registry.npmjs.org
   npm view @agentbean/contracts version --registry=https://registry.npmjs.org
   npm view @agentbean/pi-management-runtime version --registry=https://registry.npmjs.org
   ```
   - `latest` 应指向本次期望的 daemon-next 版本
   - `legacy` 必须仍为 `0.1.35`
5. **设备端**：在 macOS 上使用当前 latest 连接/更新，例如：
   ```bash
   npm install -g @agentbean/daemon@latest
   agentbean device status
   # 或按 Web 对话框中的 device connect 命令
   ```
6. **生产 smoke**：workflow 内 entry + business smoke 应通过；需要时对照 `npm run audit:agentbean-next-cutover`。

完整切换与回滚步骤见 `agentbean-next/docs/production-cutover-runbook.md`。

---

## 注意事项

- **密钥缺失策略**：生产 deploy / publish 在缺少 `RAILWAY_TOKEN` / `NPM_TOKEN` 时会 **失败**，不会静默跳过。
- **npm 版本门禁**：版本已存在则跳过该包发布；有 daemon 行为变更必须先 bump 版本再合入。
- **Railway 偶发 5xx**：可能导致 deploy job 失败，不等于 npm 发布失败；发布状态以 registry 查询为准。
- **不要把真实 `.env` 提交进仓库**；生产密钥放在 GitHub Secrets 与 Railway Variables。
- **Daily changelog push `main`** 会再跑主 CI；若仅文档/changelog 变更，变更面检测可能跳过 publish/deploy。
- **回滚**：
  - 服务端：回滚到 schema 兼容的上一成功 Railway deployment，或 revert 后重部署 Next
  - 设备端：只回滚到经 server-next smoke 验证的 canonical daemon 版本；禁止使用 `legacy` 连接生产

---

## 相关文档

| 文档 | 内容 |
|------|------|
| `README.md` | 产品概览、本地开发与验证命令 |
| `agentbean-next/docs/production-cutover-runbook.md` | 生产切换与回滚 |
| `agentbean-next/docs/verification-matrix.md` | 验证矩阵 |
| `docs/deployment/vercel-preview-filter.md` | Vercel Preview 构建过滤 |
| `docs/agents/pr-merge-gate.md` | PR 合并门禁 |
| `scripts/detect-ci-changes.mjs` | CI 变更面分类源码 |

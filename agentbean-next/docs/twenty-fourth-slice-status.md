# 第二十四切片实现状态

本文记录 AgentBean Next 第二十四切片当前已经落地的 production deploy target gate。

## 已实现

- 根 `package.json`
  - 新增 `build` 与 `start`，让根目录部署可以构建并启动 `server-next`。
  - 新增 `start:server-next`，作为 production start command 的显式入口。
- 根 `package-lock.json`
  - 新增根 workspace lockfile，用于验证根目录部署安装计划。
  - Next 内部包依赖从 `workspace:*` 改为 npm 可解析的本地 `file:` 依赖。
- `apps/server-next`
  - `PORT` 存在时，默认监听 `0.0.0.0:$PORT`。
  - `PORT` 存在且未显式设置 storage 时，默认使用 SQLite，而不是 memory。
- `.github/workflows/ci-cd.yml`
  - `Validate AgentBean Next` 同时缓存根 `package-lock.json` 与旧 server lockfile。
  - validation 增加根 `npm ci --ignore-scripts`，验证 Next 根目录部署安装计划。
  - production deploy 增加 `AGENTBEAN_DEPLOY_TARGET=old|next` gate。
  - 默认仍为 `old`，只有仓库变量显式设为 `next` 时才部署根目录。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm install --package-lock-only --ignore-scripts --fetch-timeout=15000 --fetch-retries=1 --loglevel=notice
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm ci --ignore-scripts --fetch-timeout=15000 --fetch-retries=1 --loglevel=notice
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_HOST=127.0.0.1 PORT=0 AGENTBEAN_NEXT_SESSION_SECRET=production-smoke-secret AGENTBEAN_NEXT_DATA_DIR=/private/tmp/agentbean-next-production-smoke npm run start:server-next
```

上述命令在不含任何 `node_modules` 的临时干净副本中通过，并用该副本生成的 `package-lock.json` 替换仓库根 lockfile。本机根 `node_modules` 中的 `.bun` symlink 会触发 npm Arborist 的 `Cannot read properties of null (reading 'matches')`，因此验证时需要使用干净安装树；CI clean checkout 不包含该本机状态。

production-style smoke 启动后，`/healthz` 返回：

```json
{"ok":true,"service":"agentbean-next-server"}
```

## 暂未实现

这些不属于第二十四切片：

- 真正把 GitHub 仓库变量 `AGENTBEAN_DEPLOY_TARGET` 切到 `next`。
- Railway production data volume 创建、绑定，以及真实 `AGENTBEAN_NEXT_DATA_DIR` 路径配置。
- `apps/web` / Vercel 正式切换到 web-next 产品界面。
- 真实 Codex/Claude/Gemini 交互式 adapter。

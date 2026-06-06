# 第十八切片实现状态

本文记录 AgentBean Next 第十八切片当前已经落地的 server-next 长驻 dev server 入口。

## 已实现

- `apps/server-next`
  - 增加 `startServerNextDevServer`，用于启动真实 HTTP + Socket.IO server。
  - 增加 `/healthz` HTTP endpoint，返回 `{ ok: true, service: "agentbean-next-server" }`。
  - dev server 会挂载现有 `/web` 与 `/agent` Socket.IO namespaces。
  - 增加 `parseServerNextDevConfig`，支持 `AGENTBEAN_NEXT_HOST`、`AGENTBEAN_NEXT_PORT`、`--host` 与 `--port`。
  - 增加 build 后 CLI 入口 `agentbean-next-server`。
  - 修正 package `main`、`types` 与 `exports` 指向实际 `dist/apps/server-next/src/*` 输出路径。
- 根 workspace
  - 增加 `npm run dev:server-next`，先 build server-next，再启动长驻 dev server。

## 已验证

覆盖范围：

- 配置解析可以从 args/env 得到 host 与 port。
- dev server 可以监听 `127.0.0.1:0`。
- `/healthz` 返回稳定 JSON。
- 真实 Socket.IO `/web` namespace 可以执行 `auth:register`，证明 namespace wiring 已挂到长驻 server 上。

本地命令：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:server-next
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- tests/dev-server.test.ts --api.host 127.0.0.1
```

## 暂未实现

这些不属于第十八切片：

- server-next dev server 默认仍使用 in-memory repositories；后续第二十切片已补上可选 SQLite 文件模式。
- web-next 仍缺可视化页面与 browser form。
- daemon-next 与 server-next 的组合启动脚本尚未合并为一条 full preview command。

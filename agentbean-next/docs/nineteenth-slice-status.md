# 第十九切片实现状态

本文记录 AgentBean Next 第十九切片当前已经落地的 web-next 静态 preview 页面。

## 已实现

- `apps/web-next`
  - 增加 `preview/index.html`，作为第一版可视化操作界面。
  - 页面同源加载 `/socket.io/socket.io.js`，连接 server-next 的 `/web` namespace。
  - 页面提供注册、custom agent 创建、消息发送三个主要操作面。
  - 页面展示 devices、runtimes、agents、conversation 与 event ack。
- `apps/server-next`
  - dev server 在 `/` 与 `/preview` 托管 web-next preview 页面。
  - dev-server test 覆盖 `/` HTML 返回与 `/web` namespace 注册流程。

## 已验证

覆盖范围：

- `startServerNextDevServer` 启动后，`GET /` 会返回包含 `agent-create-form` 的 HTML。
- 真实 Socket.IO `/web` client 仍可以通过同一个 dev server 执行 `auth:register`。
- 完整 phase tests、packages build 与 preview smoke 均保持通过。

本地命令：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run dev:server-next
```

启动后访问：

```text
http://127.0.0.1:4100/
```

## 暂未实现

这些不属于第十九切片：

- 页面还没有自动启动 daemon-next；需要另起 daemon-next 进程连接同一个 server。
- 页面没有持久化会话，也没有完整错误态、loading 态或复杂导航。
- SQLite 文件路径模式仍未实现。
- 真实 Codex/Claude/Gemini 交互式 adapter 仍在后续切片。

# 第六十九切片：tasks browser smoke

本文记录 AgentBean Next 第六十九切片把 Tasks 第一版纳入真实浏览器 smoke gate。

## 目标

第六十八切片已经把 `task:list`、`task:create` 与 `task:update` 落到 server-next、SQLite repository、socket binding 与 web-next preview 右侧工作区。但真实 Chrome browser smoke 仍只覆盖核心 chat/custom-agent 与 artifact 链路，tasks 主要依赖 usecase、socket 与 DOM harness 测试。

本切片不扩展 task 产品功能；只把已存在的 preview task create/status update/session restore 路径纳入 `npm run smoke:agentbean-next-browser`。

## 已落地

- `scripts/smoke-agentbean-next-browser.mjs` 新增 task browser exercise：
  - 在真实 Chrome 中通过 `#task-create-form` 创建 task。
  - 点击 task status action，把 task 从 `todo` 更新为 `done`。
  - 刷新页面后等待 session restore 与 `task:list` 重新渲染同一 task。
- browser smoke 新增三条检查：
  - `browser-task-create-visible`
  - `browser-task-status-update`
  - `browser-task-refresh-restore`
- `apps/server-next/tests/browser-smoke-script.test.ts` 覆盖 task browser helper 的 create/update/reload 调用顺序。
- docs 同步 verification matrix、known gaps 与 post-flip follow-up status。

## 验证命令

```bash
npm run test:server-next -- --api.host 127.0.0.1 tests/browser-smoke-script.test.ts
npm run smoke:agentbean-next-browser -- --skip-build --timeout-ms 45000 --json
```

## 剩余边界

- 完整 kanban/list task page、typed assignee、task delete/reorder 与 task 自动生成仍是后续产品切片。
- 当前 browser smoke 只证明 preview shell 内的 task create/status update/refresh restore，不替代未来完整 task page 的浏览器验收。

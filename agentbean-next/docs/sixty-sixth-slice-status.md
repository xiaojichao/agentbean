# 第六十六切片：workspace run detail API 与 URL 恢复

## 目标

上一切片已经让 preview 可以从消息内打开 workspace run 详情面板，但详情仍只依赖当前消息投影。第六十六切片补上授权 HTTP detail route 与 `workspaceRunId` URL 恢复路径，让详情面板可以在刷新或直达 URL 后重新加载。

## 已完成

- server-next 新增 `GET /api/teams/:teamId/workspace-runs/:runId`。
- route 使用 session token 解析当前用户，并复用 usecase 层 team membership 与 channel visibility 授权。
- `ServerNextUseCases.getWorkspaceRunDetail` 返回 workspace run 与该 run 的 artifact projection。
- web-next preview 点击 workspace run 详情入口时写入 `workspaceRunId` query parameter。
- web-next preview 在刷新或直达带 `workspaceRunId` 的 URL 后，会通过 HTTP API 加载详情。
- preview DOM harness 覆盖可分享 URL 加载路径。

## 验证

- `../../node_modules/.bin/vitest run tests/dev-server.test.ts --config vitest.config.ts --api.host 127.0.0.1 -t "workspace run detail"` 通过。
- `../../node_modules/.bin/vitest run tests/preview-page.test.ts --config vitest.config.ts --api.host 127.0.0.1` 通过。
- `npm run test:web-next -- --api.host 127.0.0.1` 通过。
- `../../node_modules/.bin/vitest run tests/first-slice.test.ts --config vitest.config.ts --api.host 127.0.0.1` 通过。
- `../../node_modules/.bin/vitest run tests/sqlite-repositories.test.ts --config vitest.config.ts --api.host 127.0.0.1 -t "associates daemon-reported artifacts"` 通过。
- `npm run build:server-next` 通过。
- `npm run build:web-next` 通过。

## 本地补验

- 此前本机 `better-sqlite3` native build 与 Node ABI 不匹配，导致 SQLite 目标测试未能跑到断言。该本地环境问题已经修复，并已在 Node `v24.15.0` 下补跑通过。

## 后续

- 更完整的 workspace run 专用页面布局、日志/命令展开与跨页面导航仍是产品增强，不再阻塞 artifact/workspace run follow-up 第一版。
- 如果继续产品能力，下一条更适合转向 tasks/search 的最小切片。

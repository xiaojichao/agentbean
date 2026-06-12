# 第六十八切片：tasks 第一版

本文记录 AgentBean Next 第六十八切片在 server-next 与 web-next preview 中补齐轻量任务能力。

## 目标

第六十七切片已经补上 message search 第一版。下一条产品 parity 小切片转向 Tasks：先落地 server-authoritative 的 task data model、create/list/update use cases 与 preview shell 的轻量入口，为后续 typed assignee、完整 task page、delete/reorder 和自动 task generation 留出明确边界。

本切片不迁移旧 Next.js task 大页面，不实现 `task:delete`，也不新增独立 `task:reorder` command。

## 已落地

- contracts 新增 `TaskDto`、`TaskStatus`、`TaskListInputDto`、`TaskCreateInputDto` 与 `TaskUpdateInputDto`。
- `WEB_EVENTS.task.list/create/update` 进入 shared socket event contract。
- server-next 新增 `listTasks`、`createTask` 与 `updateTask` use cases。
- memory 与 SQLite repositories 都实现 task create/get/list/update；SQLite 新增 team migration `0003_tasks.sql`。
- `task:list` 默认只返回 global tasks 与当前用户可见 channels/DMs 关联 tasks。
- `task:create` 与 `task:update` 会验证 team membership、channel visibility、title、status 与 assignee visibility。
- `assigneeId` 第一版支持 team human member 或当前 team 可见 agent。
- web-next preview 右侧工作区新增轻量 task create/list/status update 入口。
- 后续第六十九切片已把 task create/status update/refresh restore 纳入真实 Chrome browser smoke。
- docs 已同步 socket protocol、DTO contract、known gaps、verification matrix 与 post-flip follow-up status。

## 验证命令

```bash
npm run build:contracts
npm run build:server-next
npm run build:web-next
npm run test:server-next -- --api.host 127.0.0.1 tests/first-slice.test.ts tests/socket-handlers.test.ts tests/sqlite-repositories.test.ts -t "tasks|task|persists register, login, message|registers first-slice web events"
npm run test:web-next -- --api.host 127.0.0.1 tests/preview-page.test.ts
```

## 剩余边界

- Typed assignee `{ kind, id }` 仍需产品决策。
- `task:delete`、更完整 reorder semantics 与 task 自动生成仍未落地。
- 完整 kanban/list task page 仍是后续 UI 切片；当前 preview 只提供轻量验证入口。

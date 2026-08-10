# Research: Task ↔ Thread 绑定字段、投影与 socket 事件

- **Query**: task 与 channel thread 的绑定字段、projection、socket 事件；threadId 与 dispatchId/workspaceRunId 的关系
- **Scope**: internal
- **Date**: 2026-08-10

## Findings

### 绑定字段（真相源）

| 方向 | 字段 | 位置 |
|---|---|---|
| Message → Thread | `MessageRecord.threadId` = 讨论串根消息 id（根消息 threadId=自身 id） | `apps/server-next/src/application/usecases.ts:5535`（`threadId: messageInput.threadId ?? messageId`）；management 路径 :2803 |
| Message → Task | `message.meta.taskId`（可选，meta JSON 内） | 写入 :2840（`...(taskId ? { taskId } : {})`）；task-linked 读取 :5491-5494（`linkedRoot.meta?.taskId`） |
| ManagementRun ↔ Thread/Task | `management_runs.rootMessageId` / `rootTaskId` | reservations/run 读取 :2794-2805；审核工作区投影用 `managementRun.rootMessageId` 推导 `threadRootMessageId`（:9268-9283） |
| Task → Channel | `TaskRecord.channelId`（可空） | task-linked-request-handler.ts:118-119（无 channelId 视为不属于本频道，fail closed） |

注意：**没有 task → threadId 的直接列**；从 task 回讨论串走 `taskCoordination.managementRunId → management.runs.rootMessageId`（即 thread 根消息 id）。

### Projection（Server 计算，web 只渲染）

1. **`task:delivery-overview`**（`queryTaskDeliveryOverview`，usecases.ts:9156-9186）
   - 合同 `packages/contracts/src/task-delivery-overview.ts`：`TaskDeliveryOverviewV1`（:103-126）聚合 task/stage/acceptanceContract/responsibilityFocus/delivery{packages,pendingDeliveries,focusPackageId}/availableActions/timeline/asOf/consistencyToken。
   - responsibilityFocus 五态 `none/offer_wait/claim_active/execution_active/review_wait`（:22-29），只由 Offer/claim/execution/delivery/review Server 事实投影（AC10）。
   - timeline 九类事件 `offer/acceptance/claim/execution_start/delivery/human_revision/review/finalization/handoff`（:65-76）。
   - 水位：`ensureOutputPackageConsistency(minimumConsistency)` 未追到 → not_ready（usecases.ts:9167-9169）。
2. **`task:stage-delivery-review-workspace`**（`queryStageDeliveryReviewWorkspace`，usecases.ts:9188-9293）——#1176 审核工作区（#1178 「回到讨论串」的出发地）：
   - 合同 `packages/contracts/src/stage-delivery-review-workspace.ts`：`StageDeliveryReviewWorkspaceV1.threadRootMessageId?`（:104-105）——「管理型根任务存在时指向持久化的来源 Thread；普通阶段任务可为空」。
   - 实现：coordination → managementRun → `rootMessageId`（usecases.ts:9268-9270, 9283）。
   - 入参 exact-key 校验 `parseQueryStageDeliveryReviewWorkspaceInputV1`（:147-173），含可选 `specifiedProjection{packageId, versions[]}`；specifiedProjection.packageId 必须是当前 focusPackageId 否则 NOT_FOUND（usecases.ts:9249-9254）。
3. **`task:channel-workspace`**（`queryChannelTaskWorkspace`，usecases.ts:9295+）——频道 Tasks 标签单次聚合（governance/responsibilityFocus/delivery/review 卡片投影）。

### Socket 事件

| 事件 | 方向 | 说明 |
|---|---|---|
| `message:send` / `message:context` / `message:search` | web→server | socket.ts message 段（:266+） |
| `task:delivery-overview` | web→server query | socket.ts:300 |
| `task:stage-delivery-review-workspace` | web→server query | socket.ts:302 |
| `task:channel-workspace` | web→server query | socket.ts:304 |
| `tasks:snapshot` / `task:updated` | server→web | socket.ts:305-306 |
| `project:updated` / `project:artifacts-updated` / `project:references-updated` | server→web | socket.ts:218/223/230 |
| `project:package-review-updated` | server→web | socket.ts:257 —— **仅合同声明，server-next 无 emit 站点，web-next 无消费**（grep 全仓仅 contracts/socket.ts 命中）；三处投影刷新实际靠 command 响应 + 各自重新 query（带 minimumConsistency） |
| `system-activity:notice` | server→web | 可丢失唤醒；权威走 query/pull-change-feed（socket.ts:307-313 注释） |

### threadId / dispatchId / workspaceRunId 关系（已知坑）

- `threadId` = 根 **Message** id（不是 task id、不是 dispatch id）。
- `workspaceRunId = dispatchId ≠ workspace_runs.id`（memory「#1111 卡片进讨论串」已记录的坑）：`AgentInvocationResultDto.workspaceRunId`（contracts/invocation.ts:99）与 `DependencyResultRefDto.workspaceRunId`（:27）指 dispatch 身份，不要拿去 join `workspace_runs` 表。
- dispatch → message：`dispatches.listByMessage(messageId)`（usecases.ts:2885）；dispatch → task 无直接列，经 message.meta.taskId 或 management run。

### 相关 Spec

- `.trellis/spec/server-next/backend/architecture.md`（socket 三命名空间）
- memory「#1111 卡片进讨论串+内嵌」：workspaceRunId=dispatchId 坑、header Latin-1、内嵌优于移动。

## Caveats / Not Found

- `project:package-review-updated` 是「声明未接线」事件——若 #1178 需要推送刷新 Thread 侧引用卡片，现状是客户端在 command 成功后按新 consistency basis 重查（见 unified-delivery-journey 测试头注释），或需新接 emit。
- task → thread 反查只覆盖「有 coordination 的 tracked task」；普通任务（无 management run）`threadRootMessageId` 为空。

# Research: 阶段详情工作区（#1177 引入）

- **Query**: 阶段详情工作区组件在哪里、组件树、现有按钮/动作、是否已有「回到讨论串」「交给智能体」入口
- **Scope**: internal（apps/web-next + packages/contracts）
- **Date**: 2026-08-10

## Findings

### Files Found

| File Path | Description |
|---|---|
| `apps/web-next/components/StageDeliveryReviewWorkspace.tsx` | 阶段交付审核工作区主组件（#1177，约 800 行） |
| `apps/web-next/app/[teamPath]/chat/page.tsx` | 宿主：`TaskDetailPanel` 内嵌挂载（:4463-4487）；动作回调在 :2876-2931 |
| `packages/contracts/src/stage-delivery-review-workspace.ts` | `StageDeliveryReviewWorkspaceV1` 投影契约（schemaVersion=1，#1176） |
| `apps/web-next/lib/package-review-actions.ts` | mutation 动作辅助：标签/影响文案/校验/提交/幂等键/焦点锁 |
| `apps/web-next/lib/socket.ts:1062-1070,1210` | `projectEvents().queryStageDeliveryReviewWorkspace` socket 查询 |
| `apps/web-next/tests/stage-delivery-review-workspace.test.tsx` | 组件测试（RTL+jsdom，mock projectEvents/taskEvents） |

### 组件树

```
ChatPage (app/[teamPath]/chat/page.tsx)
└── TaskDetailPanel (:4258 起，右侧 420px aside, data-smoke="chat-task-detail")
    └── section[data-smoke="chat-task-detail-delivery"] (:4463)
        ├── stageId 存在 → StageDeliveryReviewWorkspace (:4466-4477)
        └── 否则 → TaskDeliveryOverview (:4479)
```

- `stageId` 来源：`matchingChannelTaskStageId(taskDetailWorkspaceEntry, selectedStageId)`（page.tsx:2882）；`selectedStageId = searchParams.get('stage')`（page.tsx:353）。
- 从 Tasks 页阶段卡片进入：`ChannelProjectProgress.onOpenStage`（components/ChannelProjectProgress.tsx:46,161,224）→ chat page `openProjectStage`（:1397-1411），设置 `taskDetailOnlyTaskId` 并把 `view=project&stage=<id>&task=<id>` 写进 URL（`navigateChannelTasksRoute`）。所以阶段详情 = task-only 模式的 TaskDetailPanel + stage 参数。

### 工作区现有区块与动作（StageDeliveryReviewWorkspace.tsx）

1. **阶段交付审核上下文**（:291-328，data-smoke="stage-review-context"）：阶段名/目标/验收标准/上游阶段/冻结输入/建议审核人/**绑定讨论串**（:326 展示 `workspace.threadRootMessageId ?? '无关联讨论串'`）。
2. **当前 OutputPackage**（:330-379，data-smoke="stage-review-package"）：包身份、Task revision/attempt/delivery 依据、覆盖度统计、成员列表。
3. **成员行 `PackageMemberDetail`**（:457-563）：
   - 四格版本身份 delivered/current/final/specified（:484-489，`VersionIdentity` 组件 :702-721，带 `data-version-policy` 属性）。
   - 审核状态/记录/最终化事实。
   - mutation 按钮（:528-556，data-smoke="package-review-action"）：动作集来自 Server `member.availableActions.actions` 经 `isStagePackageMutationAction` 过滤；包括审核通过（review-and-finalize/set-final）、要求修改（review-changes-requested）、拒绝（review-rejected/review-and-reject-delivery）等；点击开 `MutationConfirmDialog`（:565-700，评论/退回理由 textarea，幂等键 + 焦点恢复 + activeLockKey 防并发）。
4. **Server 阻断事实** `StageReviewBlockers`（:723-743）。
5. **Task 交付验收**（:383-416，data-smoke="stage-delivery-acceptance"）：「验收交付」accept-delivery /「退回交付」reject-delivery 按钮；本地可发现门禁 = 未归档 + status=in_review + nodeKind=root + requiresHumanAcceptance + currentUserId ∈ humanAcceptanceAuthorityIds（:281-287）。
6. **TaskDeliveryOverviewContent**（:418）：嵌入交付概览，`onAction` 透传 `TaskLevelAction`。
7. **导航按钮组**（:420-439，data-smoke="stage-review-navigation"）：
   - **「回到讨论串」已存在**（:421-429）：`disabled={!workspace.threadRootMessageId || !onOpenThread}`，点击 `onOpenThread(workspace.threadRootMessageId)`。
   - 「查看资产来源」（:430-438）：`onViewAssetSource(focusPackage.package.packageId)`。

### 父级回调接线（page.tsx:2876-2931）

- `onOpenThread={(rootMessageId) => { openThread(rootMessageId ?? taskDetailMessage?.id); setThreadInput('要求后续变更：'); }}`（:2895-2900）—— 已会打开 Thread 面板并预填一句固定文案。
- `onDeliveryAction`（:2906-2929）处理 `TaskLevelAction`：
  - `delegate-to-agent`（交给智能体处理）：有 taskDetailMessage → `openThread(taskDetailMessage.id)` + `setThreadInput('@')` + 聚焦 threadTextareaRef；task-only → 回落主 composer `setInput('@')`。
  - `review-package`：#1177 后不再跳 Files，滚动到 `[data-smoke="stage-review-package"]`。
  - `open-task`：关详情切 tasks 标签。

### Props 契约（StageDeliveryReviewWorkspace.tsx:53-67）

`teamId / channelId / stageId / taskId / minimumConsistency / currentUserId / participantName / onOpenThread(rootMessageId) / onViewAssetSource(packageId) / onAction(TaskLevelAction) / onMutationSucceeded`。

### TaskLevelAction（packages/contracts/src/task-delivery-overview.ts:89-94）

当前只有三种：`'open-task' | 'delegate-to-agent' | 'review-package'`。Server 投影 `availableActions: TaskLevelAvailableActionDto[]`（label/disabled/disabledReason）。

## Caveats / Not Found

- 工作区内**没有**「要求修改后继续」这种直接命名入口；现有路径是 package mutation「要求修改」（review-changes-requested，落 Server 审核事实）+ 导航区「回到讨论串」（只跳转 + 预填固定文案「要求后续变更：」）。
- 「回到讨论串」目前只预填文本、不带 package/file selectors，也不展示引用策略选择。

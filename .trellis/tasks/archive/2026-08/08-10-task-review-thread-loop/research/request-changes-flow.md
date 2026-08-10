# Research: 「要求修改」现有实现 —— 新 revision/attempt 与旧事实保留

- **Query**: review 要求修改后如何产生新 revision/attempt，旧 delivery/review 如何保留
- **Scope**: internal
- **Date**: 2026-08-10

## Findings

### 两条「要求修改」路径

**路径 A：对 package 成员版本提 `changes_requested`（不退回 delivery）**
- 命令 `project:submit-package-artifact-review`（合同 package-review.ts:213-215）。
- 只写一条 append-only 的 ArtifactReview（decision=changes_requested），不动 task/delivery/指针。
- 效果：该版本进入「被拒/要求修改」态——current 投影把解析到它的成员标 `current_not_formal` 阻断（output-package-projection-policy.ts:207-215）；task-linked 默认下游输入被 `REVIEW_BASIS_BLOCKED` 挡（task-linked-request-policy.ts:118-130）；显式「基于此修改」（package_members/artifact_version 显式版本）豁免。

**路径 B：审核 + 退回 Task delivery 原子提交**
- 命令 `project:submit-package-review-and-reject-delivery`（decision 必须 changes_requested/rejected，否则 `review-required-before-reject`；rejectReason 必填，合同 :221-229）。
- handler：`apps/server-next/src/application/package-review-handler.ts` `applyTaskRejectInUnitOfWork`（:490-582），同一 taskCoordinationUnitOfWork 事务内完成 review 记录 + task 状态/版本变更 + claim 失效 + 事件追加；任一失败整体回滚（PackageReviewAbort，:584-588）。

### 新 revision / attempt 语义（路径 B）

**Subtask**（coord.nodeKind === 'subtask'，:514-541）：
- task.status 必须 `in_review`（否则 `delivery-not-reviewable`）；
- `waitingForUser = attempt >= maxAttempts || requiresHumanIntervention(reason)`；
- 未等用户：`attempt + 1`（同 revision 新尝试），task 回 `todo`；
- 等用户：attempt 不变，task 回 `todo`；
- `invalidateCapturedClaim` 失效当前 claim（:538-539）；
- 事件 `task-state-changed{from:in_review,to:todo,reason}`。

**Root**（:543-581）：
- run 必须 `in_review`；`evaluateRejectRevision(task.revision)` 算 nextRevision；
- `tasks.updateAtRevision{expectedRevision, nextRevision, reasonCode:'HUMAN_REJECTED_ROOT_DELIVERY'}` CAS 把 status 置 `in_progress`（:554-559）；
- coordination 更新为 `{taskRevision: nextRevision, attempt: 1}`（:560-562）——**root 退回 = revision bump + attempt 重置 1**；
- 事件 `task-revised{previousRevision, taskRevision, criterionIds, reason}` + `task-state-changed{in_review→in_progress}`；management run 回 `running`（:580）。
- 结果 DTO `PackageReviewRejectDeliveryResultDto.task{taskId, taskRevision, taskAttempt, status}`（package-review.ts:179-187）。

### 旧事实如何保留

| 旧事实 | 保留方式 |
|---|---|
| 旧 review | ArtifactReview **append-only**（无 update/delete；package-review.ts:136-137「append-only 历史」）；读取侧按 createdAt 取最新（task-linked-request-handler.ts:254-261 / task-claim-broker.ts:1181-1188） |
| 旧 delivery/package | package 与其冻结成员**创建后不可变**（project-reference.ts:183「package 本身不可变」）；旧 package 仍在 listOutputPackages 历史中 |
| 旧 claim | `invalidateCapturedClaim` 置失效（事件留痕），claim lease 记录保留 |
| 旧版本内容 | 新版本经 `save-artifact-version-revision`（#1062，`artifact-revision-handler.ts:95`）基于明确 base 版本原子产生新 ProjectArtifactVersion 并移动 current——旧 version 记录不动，collection.revision 推进（这正是各 fence 检测漂移的机制） |
| 退回理由 | `rejectReason` 进 review.comment / 事件 payload（AC6「意见保留」） |
| receipt | `PackageReviewReceiptRecord.resultJson` 存完整 review 快照，同 key replay 可恢复（package-review-handler.ts:452-487） |

### 「基于此修改」loop 的既有片段

- web 卡片「基于此修改」→ `package_members` selection 显式选 rejected/changes_requested 版本（project-reference.ts:108-111）；domain 不过 review 闸（project-reference-policy.ts:259-261 注释「用户显式意图优先」）。
- 人类修订 → `project:save-artifact-version-revision` 产生新版本移动 current。
- unified-delivery-journey.test.ts 头注释描述的闭环：文件包出现 → Task 审核 → Files 核对 → 基于此修改（新版本移动 current）→ finalization。

### Domain 策略

`packages/domain/src/package-review-policy.ts`：三类事实独立（review / delivery 验收 / finalization），authority 分离判定（`evaluatePackageArtifactReviewAuthority` :75+，复用 #824 owner/admin/projectLead/stageReviewer；Agent/PI Manager 一律拒）；finalization 只指向有有效 approved review 的版本，人工编辑/Agent 修订/Task 状态变化均不自动移动 final（头注释 :7-21）。

### 测试

- `apps/server-next/tests/package-review-command.test.ts`（7 测试，三命令 + fence + 拒绝码）
- `apps/server-next/tests/project-artifact-review-finalization.test.ts`
- `apps/server-next/tests/root-delivery-review-wiring.test.ts` / `subtask-delivery-service.test.ts`

## Caveats / Not Found

- 路径 B 的「要求修改」目前只发生在 delivery 已提交、task `in_review` 时；#1178 「从审核工作区回讨论串要求修改后继续」若要在 delivery 未成包/任务非 in_review 时发起，现命令不适用（`delivery-not-reviewable`）。
- subtask 的 changes_requested 不退 revision 只退 attempt；root 退 revision。两者语义不对称是既有设计（与 kernel 对齐，:489 注释）。

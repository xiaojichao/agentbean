# Research: stale basis fail-closed —— expected-revision 校验模式全集

- **Query**: stage edge / collection / bundle revision 变化时旧 offer/invocation basis 如何被拒绝；现有 expected-revision 校验模式（如 expectedCollectionRevision）
- **Scope**: internal
- **Date**: 2026-08-10

## Findings

仓库已有六层 fence 模式，全部 fail closed（绝不静默换版本/静默降级）。#1178 的「stale stage edge、collection/bundle revision 变化 fail closed」可直接对号复用。

### 模式 1：文档/包成员 expectedRevision（发送路径，乐观并发）

- 合同：`ProjectDocumentExpectedRevisionDto{documentId, revisionId}`（project-reference.ts:45-48）、`ProjectPackageMemberExpectedRevisionDto{collectionId, revision}`（:89-92）。
- 裁决：domain `evaluateSelectionEligibility`——文档 `expectedRevisionId !== document.revisionId` → `revision_stale`（project-reference-policy.ts:374-376）；package current/final 逐成员 fence 缺失/不符/多余 → `revision_stale`（:217-235）。
- 提交点复核（第二道）：仓储事务内 `reference_fact_conflict`（sqlite repositories.ts:6060-6110 / memory repositories.ts:2830-2870）——collection.revision 未漂移、document.currentRevisionId 未变、package 归属有效；冲突 → 整事务回滚，消息不落库。

### 模式 2：Offer 冻结 fence（acceptance 路径）

- Offer 发布时冻结 `taskRevision/taskAttempt/manifestRevision`（agent-exposure.ts:364-376；publishTaskLinkedOffers task-linked-request-handler.ts:176-194）。
- acceptance 事务内：`task.revision !== offer.taskRevision || coordination.attempt !== offer.taskAttempt || status 非法` → `TASK_CLAIM_OFFER_STALE` 回滚（task-claim-broker.ts:1151-1154）——「task 已变 → 回滚，不留 accepted 无 claim」。
- Offer TTL：`offerExpiresAt` 超过未有效接受 → expired（computeOfferValidity）。

### 模式 3：frozen inputs basis（acceptance 路径，#1064 AC6/AC8）

- task-claim-broker.ts:1159-1201：频道归档 → `TASK_CLAIM_CHANNEL_ARCHIVED`；版本不存在或 collection 归属变化 → `TASK_CLAIM_FROZEN_INPUT_STALE`；**isFinal/reviewState 快照与当前不符**（被拒/重审/新 final）→ `TASK_CLAIM_FROZEN_BASIS_CHANGED`。任一命中不建部分 claim/grant。

### 模式 4：stage edge / stage-auto offer fence（#829）

- 合同：`ProjectStageInputFenceDto{stageId, inputs[]}`（project.ts:157-160）——「随 Offer/Invocation 冻结的精确项目输入身份；任何字段变化都使旧决定失效」；`ProjectStageRequiredInputRuleDto.source`（:36-55）显式稳定来源，缺失一律视为未满足，绝不猜。
- stage-auto offer（objective.constraints 含 `PROJECT_STAGE_AUTO_CONSTRAINT`）accept 时必须 `projectStageAutoOfferStillCurrent`（task-claim-broker.ts:1525-1559）：重算当前 fence（`resolveProjectStageOfferFence`）与 offer 冻结的 fence 字符串（`PROJECT_STAGE_FENCE_PREFIX` 前缀存在 objective.inputs 里）精确相等，且 policy.autoCoordinationEnabled、piAutomationAvailable、execution gate 未 blocked、strict agent 仍唯一；不满足 → offer 置 `invalidated` + `TASK_CLAIM_PROJECT_STAGE_FENCE_STALE`（:1038-1052 预检、:1110-1126 锁内、:1202-1205 事务内共三道）。
- Invocation 创建前置：`assertProjectStageExecutionAllowed`（invocation-gateway.ts:192）；intent 携带 `projectStageInputFence`（:171-176）入 intentHash。
- stage 投影侧：`ProjectStageDto.executionAllowed` / `blockingReasons` / `missingRequiredInputs`（project.ts:96-108）。

### 模式 5：command 级 expectedRevision fence（review/finalize 命令）

合同 `packages/contracts/src/package-review.ts`：

- `submit-package-review-and-finalize` 带 `expectedCollectionRevision`（:216-220）——「集合 revision fence：并发 finalization/append 已推进 → conflict」。
- `submit-package-review-and-reject-delivery` 带 `expectedTaskRevision` + 可选 `expectedTaskAttempt`（:221-229）。
- 结构化拒绝码：`collection-revision-stale` / `task-revision-stale` / `task-attempt-stale`（:77-81）。
- 执行：`package-review-handler.ts` `applyTaskRejectInUnitOfWork`——`task.revision !== expectedTaskRevision` → abort `task-revision-stale`（:505-507）；subtask attempt 不符 → `task-attempt-stale`（:515-517）；coordination update 用 `expectedTaskRevision` CAS（:524-528, :560-564）；root 用 `updateAtRevision` CAS + `evaluateRejectRevision`（:551-559）。

### 模式 6：workspace / projection 水位（读路径）

- `minimumConsistency` + `ensureOutputPackageConsistency` → not_ready（见 output-package-projections.md）。
- workspace materialize 用 revisionId fence（#968，contracts `project:materializeWorkspace` 族）。

### 失效码 canonical 化

`TASK_OFFER_INVALIDATION_REASON_CODE`（agent-exposure.ts:444-450）：EXPIRED / TASK_REVISION_CHANGED / MANIFEST_SUPERSEDED / NOT_OPEN——server 投影/审计共享，消除字符串漂移。

## 对 #1178 的映射（事实陈述，非建议）

- 「stale stage edge」→ 模式 4（stage fence 字符串精确比对 + execution gate）。
- 「collection revision 变化」→ 模式 1（expectedMemberRevisions）+ 模式 3（frozen basis）+ 模式 5（expectedCollectionRevision）。
- 「bundle revision 变化」→ 模式 1 的文档 expectedRevisions（bundle 成员逐个 document revisionId fence；bundle 本身创建后不可变，无 bundle revision 概念——只有成员 document 的 revision）。
- 「发送前不得创建事实 + acceptance 后才建 claim」→ 现成两段式：发送前只读复验（evaluateTaskLinkedRequestContext，handler 注释 :70-73 明确「可在事务内调用、不创建任何事实」）+ acceptance 事务二次复验（模式 2/3）。

## Caveats / Not Found

- stage edge 本身无 revision 列（ProjectStageEdgeDto 只有 createdAt/updatedAt，project.ts:63-76）；edge 变化的 fail-closed 是经由「重算 fence 字符串 + execution gate」而非 edge revision 比对。
- Offer TTL 15s（task-linked-request-handler.ts:159）对人工审核回路可能偏短——现状如此。

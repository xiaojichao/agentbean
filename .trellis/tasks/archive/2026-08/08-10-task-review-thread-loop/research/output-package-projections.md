# Research: OutputPackage 投影到 Tasks / Files / Thread 三处（delivery-overview 聚合）

- **Query**: delivery/review/finalization 事实如何投影到 Tasks/Files/Thread 三处（#1065/#1072 delivery-overview 聚合）
- **Scope**: internal
- **Date**: 2026-08-10

## Findings

### 核心原则（#1065 AC6/AC7）

三处（讨论串卡片 / Task 详情 / Files 库）**消费同一组 Server projections**，web 只渲染不推断；查询带 `minimumConsistency` 水位，投影未追到 → `projection_not_ready`，不以旧数据伪装成功。

### 共享 Server 事实源

| 事实 | 仓储 | 说明 |
|---|---|---|
| OutputPackage + 冻结成员 | `repositories.outputPackages`（listPackagesByChannel/getPackageById） | package 创建后不可变；成员含 deliveredVersionId/requiredForFinal/shortLabel/sequence |
| ArtifactVersion / Collection | `repositories.channelProjects.listArtifactVersions/listArtifactCollections` | collection 有 currentVersionId/finalVersionId/revision（指针移动推进 revision） |
| ArtifactReview（append-only） | `repositories.channelProjects.listArtifactReviews` | 同 version 多条 review，按 createdAt 取最新（task-claim-broker.ts:1181-1188 同款模式） |
| Finalization | `repositories.channelProjects.listArtifactFinalizations` | 独立事实，指向有有效 approved review 的版本 |
| pendingDeliveries | `listPendingOutputDeliveries`（usecases.ts:9090-9094） | committed 且有 provenance 但尚未形成 package 的交付；差集基于全频道 publishId（分页不漏判） |

聚合函数：`summarizeOutputPackages`（usecases.ts:9083，listOutputPackages 与 Task 视图共用）；`buildTaskDeliveryOverview`（usecases.ts:9170，:9340）；`computeOutputPackageProjection`（:9128，get-output-package 按策略解析）；`buildStageDeliveryReviewPackage`（:9257，审核工作区包块）。

### 三处投影入口

1. **Files / 讨论串卡片**：`project:list-output-packages`（usecases.ts:9053-9102）与 `project:get-output-package`（:9104-9154）
   - `getOutputPackage` 返回 `{package, availableActions, projection?, asOf, audienceScope}`；projection 按 `delivered/current/final/specified` 解析（:9127-9135），`availableActions` 按当前用户计算（:9139-1145，current/final/specified 解析到非冻结成员版本时只给修订动作，package 审核/最终化 authority 严格基于冻结成员）。
   - **引用卡片**：消息上的 `referenceSet`（ProjectReferenceSetDto）随消息 DTO/历史投影下发——usecases.ts:13928-13940（`getMessage` 类投影）、:14225/:14340（`projectReferenceSets` 批量随频道历史）；Thread 视图渲染卡片读 message.referenceSet，不重解析。
2. **Task 详情**：`task:delivery-overview`（见 task-thread-linkage.md）——`delivery.packages/pendingDeliveries/focusPackageId` + `acceptanceContract.requiredReviewCoverage{requiredForFinalCount, finalizedCount, complete}`（task-delivery-overview.ts:53-62）。
3. **Tasks 看板**：`task:channel-workspace`（usecases.ts:9295+）——每卡 `delivery{packageCount, pendingDeliveryCount, focusPackageId, focusMemberCount, focusReviewState}` + `review{reviewerIds, latest}`（task-delivery-overview.ts:138-168）。
4. **审核工作区**：`task:stage-delivery-review-workspace`——`focusPackage.projections{delivered, current, final, specified?}` 四投影同时给出 + `members[]`（逐成员 delivered/current/final/specified 身份 + review{state, covered, records[]} + finalization）+ `coverage` + `blockers[]`（stage-delivery-review-workspace.ts:85-114）。

### 一致性水位

- `ensureOutputPackageConsistency(repositories, minimumConsistency)`：usecases.ts:9168、9069、9116、9210、9302 统一调用；合同 `ConsistencyTokenV1`（contracts/system-activity.ts）。
- `audienceScope = ${teamId}:${channelId}:${userId}`（usecases.ts:9152、9289）。

### delivery/review/finalization 写入侧（产生投影事实的命令）

| 命令（socket） | usecase | 说明 |
|---|---|---|
| `project:submit-package-artifact-review` | `submitPackageArtifactReview`（usecases.ts:8960 区域） | 单版本审核，append-only |
| `project:submit-package-review-and-finalize` | :8975-8989 → `outputPackageService.finalize` | 一个事务写 review + finalization + 指针移动；带 `expectedCollectionRevision` fence |
| `project:submit-package-review-and-reject-delivery` | :8991-9007 → `outputPackageService.rejectDelivery` | 审核（changes_requested/rejected）+ 退回 Task delivery 原子提交；带 expectedTaskRevision/Attempt fence |
| `project:save-artifact-version-revision` | :7534-7541 → `artifact-revision-handler.ts:saveArtifactVersionRevisionCommand`(:95) | #1062 基于明确 base 版本保存 Markdown 修订：原子产生新版本并移动 current |

服务层：`apps/server-next/src/application/output-package-service.ts`（87 行薄壳）→ `output-package-handler.ts`（668 行）/ `package-review-handler.ts`（592 行）。

### 推送

- `project:package-review-updated`（socket.ts:257）合同注释为「审核/最终版事实变化后的推送（三投影刷新）」，但**当前无 emit 实现**（全仓仅声明处命中）。三处刷新实际依赖 command 响应（receipt 含新 revision）+ 客户端按新 consistency basis 重查。
- 测试佐证：`apps/server-next/tests/unified-delivery-journey.test.ts` 头注释——「任一 command 成功后所有 surface 以新的 consistency basis 显示同一 identity、revision 与结果（AC6）；不伪造旧数据」。

### 测试

| 文件 | 覆盖 |
|---|---|
| `tests/unified-delivery-journey.test.ts` | #1065 AC13 贯穿旅程 + AC6 三处一致（双后端） |
| `tests/task-delivery-overview.test.ts` | delivery-overview 聚合（13 测试） |
| `tests/output-package-consistency.test.ts` | 水位/not_ready |
| `tests/output-package-formation.test.ts` | #1060 package 成形 |
| `tests/root-delivery-review-wiring.test.ts` / `tests/subtask-delivery-service.test.ts` | 交付审核接线 |

## Caveats / Not Found

- `project:package-review-updated` 声明未接线（见 task-thread-linkage.md 同名 caveat）。
- `pendingDeliveries` 只在 listOutputPackages 返回；get-output-package 无。

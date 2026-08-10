# Research: ProjectReferenceSet 定义、四种引用策略解析与冻结

- **Query**: ProjectReferenceSet 定义在哪、current/final/delivered/specified 四种策略解析逻辑、何时冻结为 artifactVersionId、相关测试（#1063/#1064）
- **Scope**: internal
- **Date**: 2026-08-10

## Findings

### 合同层（packages/contracts）

`packages/contracts/src/project-reference.ts`（#826 引入，#1063 扩展整包引用）：

- `PROJECT_REFERENCE_SET_CONTRACT_VERSION = 1`（:20）。三层区分：**选择请求**（发送前意图，仅一次请求有效）→ **冻结项**（发送时刻事实，含 revisionId/versionId）→ **引用集**（与 Message 原子写入，历史消息与 Invocation 永远读它，不重解析指针）。
- 六种 selection source kind（:23-39）：`bundle_all` / `bundle_subset` / `document` / `artifact_version` / `package_delivered` / `package_current` / `package_final` / `package_specified`。
- 四种整包策略（:81-83）：`PROJECT_REFERENCE_PACKAGE_PROJECTION_POLICIES = ['delivered','current','final']`；`specified` 刻意不在指针策略里，走 `package_members` arm。
- 请求 DTO：
  - `ProjectReferencePackageProjectionRequestDto`（:100-105）：`{kind:'package_projection', packageId, policy, expectedMemberRevisions?}`。delivered 无需 fence；current/final 必须带逐成员 `expectedMemberRevisions`（UI 从 `project:get-output-package` 的 projection 响应拿到成员 collection revision 原样回传）。
  - `ProjectReferencePackageMembersRequestDto`（:117-122）：`{kind:'package_members', packageId, members:[{collectionId,versionId}]}` —— 单选/多选/「基于此修改」，显式版本不过 review 闸。
  - 文档类 arm 带 `expectedRevisions`/`expectedRevisionId` 乐观并发 fence（:45-68）。
- 冻结 item：`ProjectArtifactVersionReferenceItemDto`（:154-167），`collectionRevision?` 仅当 item 由 current/final 指针解析而来时携带（解析当刻 basis），delivered/specified 不带。
- `ProjectReferenceSetDto`（:205-214）：`{id, contractVersion, teamId, channelId, messageId, selections[], createdBy, createdAt}`。
- 结构化失败：`ProjectReferenceFailureReason`（:217-223）+ `ProjectReferenceRejectionDto`（:238-246，含 memberBlockers）。
- exact-key 运行时校验（禁 zod）：`parseProjectReferenceSelectionRequestV1`（:386-443）/ `parseProjectReferenceSelectionRequestsV1`（:446-451），哨兵 `PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID`（:330）。

### Domain 纯策略（packages/domain）

`packages/domain/src/project-reference-policy.ts`：

- `evaluateSelectionEligibility(selection, channel, scope)`（:140-345）——fail-closed 裁决主入口，拒绝码 `ProjectReferenceSelectionRejectionCode`（:24-40）含 `revision_stale` / `package_projection_blocked` / `version_not_in_package` 等。
- package_projection arm（:183-257）：先 `resolveOutputPackageProjection`，非 ready → `package_projection_blocked` + memberBlockers（:199-211）；ready 后对 current/final 校验 fence——每个参与解析的成员必须有匹配 `expectedMemberRevisions` 且与解析当刻 collection.revision 一致，多余/缺失 fence 都拒（:217-235）；delivered 无 fence。指针解析的 item 携带 `collectionRevision` basis（:253）。
- package_members arm（:261-305）：逐项 `resolveProjectPackageMemberVersion` 校验成员归属与可见性，不过 review 闸，保序。
- 短编号解析：`resolveReferenceOrdinal`（:417，bundle 焦点）/ `resolvePackageReferenceOrdinal`（:468，package 焦点，F1↔position 1，解析结果即 package_members/specified 语义）。

`packages/domain/src/output-package-projection-policy.ts`：

- `resolveOutputPackageProjection({members, collections, versions, reviewStateByVersionId, policy, specifiedVersions?})`（:89-257）——四策略语义：
  - `delivered`：还原 package 创建时冻结的 `deliveredVersionId`，不读 collection 指针（:168-183）；
  - `current`：逐成员解析 `collection.currentVersionId`，解析结果 reviewState 为 rejected/changes_requested → `current_not_formal` 阻断（:195-217）；
  - `final`：必需成员（requiredForFinal）缺 finalVersionId → `missing_final` 阻断；非必需无 final → 进 `omitted` 明确省略，绝不以 current 补齐（:219-248）；
  - `specified`：逐项校验版本属于成员 collection，否则 `version_not_in_package`；不过 review 闸（:123-164）。
- 成员归属判定 `resolveProjectPackageMemberVersion`（:74-87）返回 hit/not_in_package/not_visible。
- 解析出的 member DTO 携带 `collectionRevision`（:119）——即 fence 快照来源。

### Server 装配与冻结点（apps/server-next）

`apps/server-next/src/application/usecases.ts`：

- `resolveAndFreezeSelections(repositories, {userId, teamId, channelId, channel, selections})`（:15984-16042）：先 exact-key parse，再逐项 `loadProjectReferenceSelectionCandidate`（:16044+，从仓储读同快照事实）+ `evaluateSelectionEligibility`；任一拒绝 → `VALIDATION_ERROR` + `selections_rejected` + rejections 清单。message:send 与 `project:resolve-references` 共用。
- **冻结时机**：`message:send` 成功路径内——`usecases.ts:5470` 在 channelCoordinationUnitOfWork 事务里调 `resolveAndFreezeSelections` 得到 `frozen.selections`；:5531 写 Message；:5548-5558 `persistFrozenProjectReferences`（:15834-15927）把 previews 落成 `ProjectReferenceSetRecord` + selections + items（含 collectionRevision basis），**与 Message 同一事务**。
- **提交点复核**（双后端）：仓储 `projectReferenceSets.create` 在事务内复核事实未漂移，否则返回 `reference_fact_conflict`：
  - SQLite：`apps/server-next/src/infra/sqlite/repositories.ts:6060-6110`——document.currentRevisionId 未变、package 属于本 Team/Channel、带 collectionRevision 的 item 对应 collection.revision 未漂移（current 移动与 final 移动都推进 revision）；
  - 内存：`apps/server-next/src/infra/memory/repositories.ts:2830-2870` 同语义。
  - 冲突经 `ProjectReferenceCommitConflictError`（usecases.ts:15828-15832）映射为 `'Project references changed before the message could be committed; refresh and retry'`（:5603-5609）。
- 幂等：message meta 存 `projectReferenceRequestFingerprint`（usecases.ts:5545），同 clientMessageId replay 比对 fingerprint 后返回原 referenceSet（:5453-5467）。
- 预览查询 usecase：`resolveProjectReferences`（:9632 起）也走 `resolveAndFreezeSelections`（只读，不落库）。
- 旧版根消息路径（management router 路径）同样冻结：usecases.ts:2739/2846-2856。

### 持久化

- migration：`apps/server-next/src/infra/sqlite/migrations/team/0079_project_reference_package_selections.sql`（#1063 package selection 列）。
- 记录类型：`ProjectReferenceSetRecord` / `ProjectReferenceSelectionRecord` / `ProjectReferenceItemRecord` 与 `ProjectReferenceSetRepository` 见 `apps/server-next/src/application/project-repositories.ts`（:466 冲突结果联合类型）。

### 测试

| 文件 | 覆盖 |
|---|---|
| `apps/server-next/tests/project-reference.test.ts` | #826 基础引用（8 测试） |
| `apps/server-next/tests/output-package-reference.test.ts` | #1063 整包四策略/fence/阻断（11 测试） |
| `apps/server-next/tests/task-linked-request-offer.test.ts` | #1064 task-linked 冻结输入 + Offer（见 offer-acceptance-claim.md） |
| `packages/domain` 测试 | project-reference-policy / output-package-projection-policy 单测（packages/domain/tests/ 镜像结构） |

### 相关 Spec / ADR

- `.trellis/spec/contracts/backend/index.md` — exact-key 校验纪律
- `docs/adr/0064-subtasks-publish-atomic-contracts-and-use-channel-scoped-offers.md`

## Caveats / Not Found

- 「发送前不得创建 Message」在 #1178 语境是新要求：现有 message:send 路径是「复验→同事务写 Message+ReferenceSet→事务外发 Offer」；#1064 的复验（evaluateTaskLinkedRequestContext）已在事务内、失败时消息不落库（见 offer-acceptance-claim.md），但 Message 与 ReferenceSet 仍是原子同写，不存在「只冻结引用不写消息」的现成路径。
- `project:resolve-references`（预览）不落库、不产生任何事实，是「发送前解析」的现成只读通道。

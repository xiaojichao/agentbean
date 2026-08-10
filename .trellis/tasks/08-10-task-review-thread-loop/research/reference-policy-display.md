# Research: 引用策略 current/final/delivered/specified 的 web 端类型与展示

- **Query**: 四种引用策略在 web 端是否已有展示/类型定义
- **Scope**: internal（apps/web-next + packages/contracts）
- **Date**: 2026-08-10

## Findings

### 类型定义

1. **整包投影策略（三策略）**：`apps/web-next/lib/output-package-reference.ts:27`
   ```ts
   export type PackageProjectionPolicy = 'delivered' | 'current' | 'final';
   ```
   与 contracts 的 `OUTPUT_PACKAGE_PROJECTION_POLICIES` 一致（文件头注释 :26）。

2. **socket 查询层（含 specified）**：`apps/web-next/lib/socket.ts:1041`
   ```ts
   projection?: { policy: 'delivered' | 'current' | 'final' | 'specified'; versions?: { collectionId: string; versionId: string }[] };
   ```
   即 `getOutputPackage` 的 projection 参数类型已支持 specified（需附带显式 versions 列表）。

3. **阶段工作区投影（含 specified）**：`packages/contracts/src/stage-delivery-review-workspace.ts`
   - `StageDeliveryReviewMemberV1.specified?`（:40-41，「仅在查询显式提交 specified selection 时出现」）。
   - `StageDeliveryReviewPackageV1.projections: { delivered, current, final, specified? }`（:87-92）。
   - blocker 的 policy 联合 `'delivered' | 'current' | 'final' | 'specified'`（:75）。
   - 查询输入 `QueryStageDeliveryReviewWorkspaceInputV1.specifiedProjection?: { packageId, versions: {collectionId, versionId}[] }`（:122-125），exact-key 校验 :162-171。

4. **选择（selection）层**：`ProjectReferenceSelectionRequestDto` 的 `package_projection` kind 带 `policy`（delivered/current/final）；显式成员版本用 `package_members`（members: {collectionId, versionId}[]）——specified 语义在 composer 选择层由 `package_members` 表达，不是 policy 值。已冻结集合的 sourceKind 有 `package_specified`（见下）。

### 展示现状

| 位置 | delivered | current | final | specified |
|---|---|---|---|---|
| 阶段工作区成员四格 `VersionIdentity`（StageDeliveryReviewWorkspace.tsx:484-489, 702-721） | 有（fallback=冻结 artifactVersionId） | 有 | 有（空='未设置'） | 有（空='未选择'）；各格带 `data-version-policy` 属性 |
| 共享策略标签 `POLICY_LABELS`（lib/delivery-labels.ts:17-21） | '交付版' | '当前版' | '最终版' | **无** |
| 整包引用入口（OutputPackageCard / ProjectFilesBoard 工具栏 / lib/output-package-reference） | 有 | 有 | 有 | **无入口**（构建层 `PackageProjectionPolicy` 只有三值） |
| 已冻结 chips `SOURCE_LABEL`（components/project/ProjectReferenceChips.tsx:11-20） | package_delivered='交付版整包' | package_current='当前版整包' | package_final='最终版整包' | package_specified='包内显式选择' |
| composer 选择 chips label `projectReferenceSelectionLabel`（chat/page.tsx:4694-4713） | package_projection → '交付版'/'current'/'final' 后缀 | 同左 | 同左 | package_members → '<包短编号> · N 项' |

### 关键语义（lib/output-package-reference.ts 文件头 :8-16）

- 整包投影引用先经 `getOutputPackage(projection policy)` 向 Server 询问解析结果；不可用返回 null，调用方不产生选择。
- status=ready → `package_projection` 选择；**current/final 携带逐成员 collectionRevision 的 expectedMemberRevisions fence**（:77-82），delivered 是冻结事实无 fence。
- status=not_ready → blockers 清单，不产生选择。
- 成员单选/多选/「基于此修改」→ `package_members` 显式选择，顺序由发送方给定，Server 不重排。

## Caveats / Not Found

- UI 入口层（卡片/Files 工具栏/composer chips）目前只暴露 delivered/current/final 三策略；specified 只在「阶段工作区投影 + socket 查询参数 + 已冻结 sourceKind 标签」三层存在。若新需求要在 composer 展示 specified 策略，POLICY_LABELS 与 projectReferenceSelectionLabel 都没有现成文案，需要新增（或直接复用 package_members 的「N 项」语义）。
- 阶段工作区组件当前**未传** `specifiedProjection` 查询参数（StageDeliveryReviewWorkspace.tsx:114-120 只传 minimumConsistency），所以成员 `specified` 格在当前 UI 流程下恒为空（展示「未选择」）。

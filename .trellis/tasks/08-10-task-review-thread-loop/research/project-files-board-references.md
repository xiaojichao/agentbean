# Research: Files「继续处理/引用」入口与版本标签（#1174 相关）

- **Query**: ProjectFilesBoard 相关组件、引用入口、版本标签展示
- **Scope**: internal（apps/web-next）
- **Date**: 2026-08-10

## Findings

### Files Found

| File Path | Description |
|---|---|
| `apps/web-next/components/project/ProjectFilesBoard.tsx` | 文件库「逻辑产物」视图主组件（左卡右表，约 1100 行） |
| `apps/web-next/lib/file-group-model.ts` | 左栏卡片聚合纯函数（buildFileGroupCards/filter/summaryLines/withAgentNames/withPackageFinalStates） |
| `apps/web-next/lib/output-package-reference.ts` | 整包/成员引用构建层（#1063/#1065 抽取，卡片与文件库共用） |
| `apps/web-next/lib/delivery-labels.ts` | 共享文本标签（POLICY_LABELS/REVIEW_STATE_LABELS/TIMELINE_KIND_LABELS，#1065 AC11） |
| `apps/web-next/components/project/ProjectReferenceChips.tsx` | 已冻结 ProjectReferenceSet 展示 chips（含 package_specified='包内显式选择'标签 :17） |
| `apps/web-next/components/OutputPackageCard.tsx` | 讨论串文件包卡片（整包/单选/多选/继续 @Agent 入口） |
| `apps/web-next/tests/project-files-board.test.tsx`、`chat-files-surface.test.ts`、`output-package-reference*.test.*` | 对应测试 |

### 挂载与数据流

- chat page Files 标签挂载 `ProjectFilesBoard`（chat/page.tsx:2749-2762+），props：`packages=outputPackages`、`pendingDeliveries`、`library=projectArtifactLibrary`、`stages`（channelProjectOverview 派生）、`dataRevision=projectDataRevision`、`onAddReference=addFilesBoardReference`（:947-966，落主 composer，按包/版本互斥去重）。
- 组件头注释（ProjectFilesBoard.tsx:47-70）完整描述数据原则：卡片模型来自 lib/file-group-model 纯函数；包详情经 `getOutputPackage(projection current)` 懒加载 Map 缓存（:84-89, :211-238），dataRevision 递增整缓存失效；「有 final」用 final projection ready 判定（:242-259）。

### 引用入口（工具栏 + 行内）

工具栏（:439-523，顺序与原型一致：搜索/角色/状态/多选/final/current）：

- 「多选引用」（data-smoke="files-ref-multi" :494-502）→ 行复选 → 「引用所选」（files-multi-confirm :474-482）→ `buildPackageMembersSelection`（:378-388）。
- 「引用最终版包」（files-ref-final :503-511）→ `addProjectionReference('final')`。
- 「引用当前包」（files-ref-current :512-520）→ `addProjectionReference('current')`。
- 整包引用统一走 `loadPackageProjection` → `buildPackageProjectionSelection`（:348-361）：ready → selection 进 composer；not_ready → 阻断清单（data-smoke="files-ref-blockers" :555-571，文案含 missing_final/current_not_formal/collection_unavailable/version_not_in_package）。

行内动作（七列表「动作」列 :709-823）：

- 「引用」/「引用以修改」（files-row-ref :711-719）：审核未通过行（rejected/changes_requested）标签变「引用以修改」（`referenceRequiresRevisionContext`），只能显式引用为修改依据。
- 「预览/编辑」（files-row-preview-edit）：包行 → OutputPackagePreviewModal 浮窗（onOpenPackagePreview，:720-737）；Markdown 集合行 → onOpenRevisionEditor（:740-756）；非 Markdown 集合行 → ArtifactViewer 只读（:757-767）。
- 「基于此修改」（files-row-revise）：集合行 :768-786、包行 :802-821；`canRevise` 由 Server availableActions('revise-version')/最新审核记录给出，basisReviewId 冻结（包行 :1008 来自 availableActions.latestReviewId，集合行 :1068 来自最新审核记录；#1062 不从历史猜）。
- 「详情」展开区（集合行 :787-799）→ CollectionVersionDetail 复用 ProjectArtifactLibrary 的 VersionDecisionPanel + FinalizationHistory（审核/设最终版，:847-877）。
- 左栏底部「提升为逻辑产物版本」（canPromote=project-lead，:593-602 + PromoteArtifactForm :544-551）。

### 版本标签展示

- 表格七列（:627-637）：名称 / 类型·阶段 / 来源 / 当前版 / 最终版 / 审核 / 动作。
- 当前版列（:681-690）：`v<N> current` 徽章 + `server revision r<N>` 副行（packageProjectionRows :993-994）。
- 最终版列（:691-699）：`v<N> final` 绿徽章或「未设置」（:995-1000）。
- 审核列（:700-708）：reviewStateLabel 徽章（待审核/已通过/要求修改/已拒绝，delivery-labels.ts:9-14），data-smoke="file-row-review-state"。
- 左栏卡片：kind 徽章（输出包/文件集合/等待上游）+ chips（含审核态，data-smoke="output-package-review-state"）+ summaryLines（包短编号版本摘要 :927-933）+ pending-delivery 卡「Workspace revision 已提交,package 形成中」（:934-939）。

### 引用策略标签

`POLICY_LABELS`（lib/delivery-labels.ts:17-21）：delivered='交付版'、current='当前版'、final='最终版'——#1065 AC11 三处 surface（Chat/Task/Files）共享；**没有 specified 标签**。已冻结集合的 sourceKind 标签在 ProjectReferenceChips.tsx:11-20（package_delivered/package_current/package_final/package_specified='包内显式选择' 等）。

## Caveats / Not Found

- ProjectFilesBoard 的引用全部落**主 composer**（onAddReference），没有落 thread composer 的路径；thread composer 的引用入口是 ThreadPanel 自己的 @ 选择器与讨论串卡片 onAddSelection。
- 「继续处理」语义在 Files 面没有独立按钮；等价能力是行内「引用以修改」/「基于此修改」（落主 composer 引用或开修订编辑器）。

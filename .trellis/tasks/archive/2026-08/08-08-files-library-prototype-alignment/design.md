# 技术设计:文件库原型对齐呈现层

## 架构与边界

纯 web-next 呈现层改造。零 contracts / server-next / daemon 变更。
所有数据沿用既有 socket 通道:`projectEvents().listOutputPackages` /
`getOutputPackage(含 projection)` / `artifactCollections` / `overview`,
以及 `onArtifactsUpdated` / `onDocumentBundlesUpdated` 订阅。

核心原则:**Server 事实不下客户端推断**。聚合 reviewState、per-member current
projection、final blockers、availableActions 全部用 Server 返回值;客户端只做
展示排序/筛选/搜索(纯呈现,不写入)。

## 组件结构

```
chat/page.tsx (接线:state + socket 调用,≤150 行新增)
  └─ ProjectFilesBoard                      新组件(components/project/ProjectFilesBoard.tsx)
       ├─ FilesBoardToolbar                 搜索 + 筛选 chip + 引用当前包/最终版包/多选 + 提升入口
       ├─ FileGroupRail(左)               混排卡片:PackageGroupCard / CollectionGroupCard / WaitingUpstreamCard
       └─ FileVersionTable(右)            七列文件表(§8.7),行内动作
```

- `ProjectFilesBoard` 替换 page.tsx:2501-2535 的 OutputPackageList+ProjectArtifactLibrary
  堆叠渲染;「文件/逻辑产物」子切换与 ConversationFiles 不动。
- `ProjectArtifactLibrary` 不删除:其 `VersionDecisionPanel`(审核/设最终版)、
  `FinalizationHistory`、`VersionSource`、`PromoteArtifactForm` 抽取为可复用件
  (移入 components/project/ 或导出),新表格行展开区复用;旧组件本体的去留由
  迁移完整性决定——若新表格全量覆盖其能力,则删除旧组件并迁移测试;否则暂保留
  为集合卡的次级视图。**默认方案:全量覆盖后删除**,避免双份真相。
- `OutputPackageList` 被 PackageGroupCard 取代后删除(先 grep 引用方:task 详情
  交付视图可能复用它——若有复用则保留导出,仅文件库换用新组件)。

## 数据流

1. 左栏三类卡片统一为 `FileGroupCardModel`:
   `{ kind: 'package'|'collection'|'waiting', id, title, chips[], summaryLines[], lastActivityAt, payload }`,
   由 page.tsx 的 useMemo 从 outputPackages + projectArtifactLibrary.collections +
   channelProjectOverview.stages 聚合。排序 = lastActivityAt 倒序
   (package: createdAt;collection: 最新版本/审核/finalize 时间 max;waiting: 排尾)。
2. 输出包短编号摘要:选中或卡片进入视口时 `getOutputPackage({projection:{policy:'current'}})`
   懒加载,`Map<packageId, {detail, projection}>` 缓存;`onArtifactsUpdated` 与
   packages 列表刷新时失效。版本摘要行 = members 逐条 `F{seq} v{versionNumber}`。
3. 右栏:
   - 选中输出包 → 成员行:名称(filename+collectionId)、类型·阶段(集合类型+
     stages 映射)、来源(agentId→agents 名 + sourcePath + delivered 版本)、
     当前版(projection member 的 versionNumber + collectionRevision)、最终版
     (availableActions.isFinalVersion / 集合 finalVersionId)、审核(Server
     reviewState)、动作。
   - 选中集合 → 版本行:同七列,数据来自 collection.versions。
   - 选中等待上游 → 右侧展示阶段目标/期望产物的占位说明。
4. 引用(R5):把 OutputPackageCard 内投影预览+选择构建抽成
   `lib/output-package-reference.ts` 纯函数/ hook:
   `buildPackageProjectionSelection(pkg, policy, projectionResult)` →
   ready 时产出带 expectedMemberRevisions fence 的 ProjectReferenceSelectionRequestDto;
   not_ready 返回 blockers 供 UI 展示。OutputPackageCard 改为调用同一实现(纯移动,
   行为不变,其现有测试应原样通过)。多选 → package_members 选择,复用同一抽取层。
5. 选择落点:`setProjectReferenceSelections`(主 composer),与现有文件库引用一致;
   发送路径(page.tsx:1571)不变。

## 关键取舍

- **不做 server 摘要 DTO 扩展**:卡片摘要靠懒加载详情。包量级小(每频道数十),
  换来零后端变更、零发版耦合。
- **左栏不引入虚拟滚动**:数据量小,保持简单。
- **表格窄屏横向滚动**(`overflow-x:auto`),不做响应式重排(用户已确认严格按原型)。
- **预览/编辑复用现有浮窗**:Markdown → 现有 revision 编辑器(openArtifactRevisionEditor
  流,带 expectedCollectionRevision fence);图片/其他 → ArtifactViewer 只读。
  不新造第三套预览。
- **「基于此修改」**沿用 #1062 ReviseVersionRequest(latestReviewId 来自
  availableActions,不从历史猜)。

## 兼容与回滚

- 兼容:无协议变更;旧 web 与新 server、新 web 与旧 server 均可工作(只读使用既有接口)。
- 测试迁移:OutputPackageList/ProjectArtifactLibrary 现有测试断言需映射到新组件
  (data-smoke 选择器保留同名:output-package-item、project-artifact-collection 等,
  降低迁移面);`channel-files-view-*`、`channel-files-tab` 不动。
- 回滚:单 PR revert 即可,无数据/迁移牵扯。

## 风险

- page.tsx 体积与接线复杂度:新增 state(选中卡片、详情缓存、筛选)控制在小组;
  聚合逻辑放 lib 纯函数便于单测。
- 抽取 OutputPackageCard 引用逻辑时的行为漂移:以现有测试原样通过为门槛,
  禁止顺手改语义。
- 删除 ProjectArtifactLibrary 前必须确认审核/设 final/提升三能力在新 UI 可达,
  且对应 smoke 断言已迁移(防 #836 幽灵绿:跑 tsc + 全量 vitest,非子集)。

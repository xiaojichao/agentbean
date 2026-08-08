# PRD:文件库对齐原型——文件组卡片混排 + 文件表呈现层

## 背景与目标

频道聊天页的「文件」标签页(文件库)呈现形态与原型差距大。Server 事实层
(OutputPackage / ProjectArtifactCollection / current/final/审核事实,#823/#1060–#1065)
已全部就绪;本任务只做 **web-next 呈现层** 的原型对齐,不改任何 Server 写入路径。

参照物:
- 原型:`docs/superpowers/prototypes/2026-07-28-chat-task-file-package-flow-prototype.html`
  (`screen-files` 段,约 line 1558–1674)
- 设计文档:`docs/superpowers/specs/2026-07-17-project-task-file-management-design.md`
  §7.3(文件库)、§8.7(文件页字段契约)、§5.5(多文件选择)

用户价值:项目负责人进入文件库,能按「文件组」(输出包/文件集合/等待上游)一眼看到
最近活跃的产物及其 current/final/审核状态;选中文件组后按文件行查看名称/类型·阶段/
来源/当前版/最终版/审核/动作七列;并能在文件库直接发起整包/多选/final 包引用,
不必回到讨论串找卡片。

## 已确认事实(代码证据)

- 文件标签页主体在 `apps/web-next/app/[teamPath]/chat/page.tsx:2482-2587`;
  子切换 `channelFilesView`('files'|'artifacts')默认 `'artifacts'`(page.tsx:369-371)。
- 逻辑产物视图现状 = `OutputPackageList`(components/project/OutputPackageList.tsx,
  纯展示行:memberCount/reviewState/Task rX·attempt/createdAt,无标题、无短编号、
  不可交互)+ `ProjectArtifactLibrary`(components/ProjectArtifactLibrary.tsx,
  集合卡片:当前版/历史版本/final badge/审核/设最终版/基于此修改/引用选择/提升表单)。
- `OutputPackageSummaryDto`(packages/contracts/src/output-package.ts:287)不含标题、
  短编号摘要、阶段;成员明细(shortLabel/filename/artifactVersionId/collectionId)在
  `getOutputPackage` 详情(`OutputPackageDto.members`,output-package.ts:203-221)。
- `getOutputPackage` 支持 `projection: {policy:'current'|'final'|...}`(lib/socket.ts:1031-1046),
  返回 per-member 解析版本(versionNumber 等)+ blockers(final 缺失/被拒 current 阻止)。
  卡片短编号摘要与右侧表格均可由它驱动,**无需 contracts 变更**。
- 引用选择机制:文件库引用进主 composer `projectReferenceSelections`
  (page.tsx:2396/1571,发送时冻结为消息 ProjectReferenceSet)。整包(delivered/current/
  final 三入口)/单选/多选引用逻辑已在 `components/OutputPackageCard.tsx` 实现
  (投影预览 ready→产生带 expectedMemberRevisions fence 的选择;not_ready→阻断清单),
  可抽取复用。
- 阶段数据:`channelProjectOverview.stages` 已下发;集合带阶段归属
  (ProjectArtifactLibrary 的 VersionSource 展示「阶段」)。
- 讨论串 composer 有独立 selections + onAddSelection(ThreadPanel,page.tsx:4291-4294);
  本任务文件库引用落点沿用主 composer 现有机制,不动线程 composer。

## 已决产品决策(2026-08-08 用户拍板)

- D1 布局:**严格按原型左右分栏**(左侧文件组卡片 + 右侧七列文件表)。
- D2 子切换:**保留双视图**——「逻辑产物」承载新原型布局;「文件」保留
  ConversationFiles 现有目录浏览/文档包/普通附件能力,不重构。
- D3 范围:**纳入**工具栏包级引用(引用当前包/引用最终版包/多选引用)。
- D4 范围:**纳入**「等待上游」占位卡。

## 需求

- R1 「逻辑产物」视图重排为左右分栏:左侧文件组卡片列表,右侧文件行表格;
  选中左侧卡片过滤右侧内容。实现为独立组件(不继续堆进 6700 行的 chat/page.tsx)。
- R2 左侧卡片混排三类,默认按最近活跃排序(卡片内最新活动时间倒序):
  - 输出包:成员数、聚合审核态、Task rX·attempt、短编号+版本摘要(F1 v4 / F2 v3,
    由 getOutputPackage + projection current 懒加载并缓存);
  - 文件集合:名称、类型、阶段、当前版、final 指针、审核态(来自 artifactCollections);
  - 等待上游:有阶段但无产物集合/输出包的占位卡(来自 stages 与集合/包的纯前端差集)。
- R3 轻量筛选 chip:全部 / 待审核 / 有 final / Agent 输出;搜索框按文件名、
  文件组名、Agent、版本号过滤左侧卡片(对已加载数据的客户端过滤)。
- R4 右侧文件表七列(§8.7):名称(+collection id)/ 类型·阶段 / 来源(Agent、
  人工修改、WorkspaceRun/消息摘要)/ 当前版(vN current + server revision)/
  最终版 / 审核 / 动作。输出包选中时列成员(current projection);集合选中时列版本行。
- R5 工具栏:搜索 + 状态筛选 + 引用当前包 / 引用最终版包 / 多选引用
  (作用于当前选中的输出包)。复用从 OutputPackageCard 抽取的投影预览与选择构建逻辑;
  final 包有成员缺 final 时按 Server blockers 阻止并列出缺失项,不静默混用。
  引用加入主 composer `projectReferenceSelections`,发送时冻结 ProjectReferenceSet。
- R6 行动作:预览/编辑(Markdown 走现有编辑器冲突流 saveArtifactVersionRevision;
  图片等走只读预览)、引用(单行稳定引用)、基于此修改(#1062 冻结 basis)。
  集合版本的审核/设最终版能力不得回归(沿用现有 Server 驱动动作)。
- R7 「提升为逻辑产物版本」入口(project-lead 限定)在新布局中保留,形式可为
  工具栏按钮 + 现有表单。

## 验收标准

- AC1 文件库默认视图(有项目数据时)为左右分栏:左侧混排输出包/文件集合/等待上游
  卡片并按最近活跃排序,右侧为七列文件表;无项目数据时仍回落 ConversationFiles;
  「文件/逻辑产物」子切换保留且 ConversationFiles 行为不变。
- AC2 输出包卡片显示短编号摘要(如 F1 v4 / F2 v3),点击选中后右侧表格列出包成员,
  每行含 §8.7 七列;数据来自 getOutputPackage(含 projection current),与讨论串卡片
  同源 Server 事实。
- AC3 筛选 chip(全部/待审核/有 final/Agent 输出)与搜索框作用于左侧卡片列表,
  结果即时可见。
- AC4 选中输出包后,工具栏「引用当前包/引用最终版包/多选引用」可用;final 包有成员
  缺 final(或被拒 current)时阻止并展示 Server blockers 缺失清单;产生的引用出现在
  主 composer 待发送区,可随消息发送冻结为 ProjectReferenceSet。
- AC5 右侧表格行动作:Markdown「预览/编辑」打开编辑器,保存走
  saveArtifactVersionRevision 冲突流(basis 只传 sourceVersionId,遵循 #1131 修复);
  「基于此修改」沿用 #1062 冻结 sourceVersion/basis;非 Markdown 可只读预览。
- AC6 集合版本的审核、设最终版、提升为逻辑产物版本能力在新布局中仍可到达,
  不丢现有 smoke 断言语义(选择器可迁移,但能力不回归)。
- AC7 零 contracts/server-next 变更;`apps/web-next` 测试全绿 + tsc 无错。

## 非目标

- 不改 Server 事实模型、命令、迁移、投影 DTO;不改讨论串卡片(OutputPackageCard)
  既有行为(仅抽取共享逻辑,纯移动)。
- 不做文件内容 diff、自定义包/另存为包、跨频道文件库。
- 不重构 ConversationFiles;不做窄屏响应式特化(表格容器横向滚动即可)。
- 讨论串 composer 引用落点不变(文件库引用只进主 composer)。

## 风险与延期项

- 卡片短编号摘要需要逐包 getOutputPackage 懒加载:频道包数量小,可接受;
  用 packageId 缓存 + artifactsUpdated 订阅失效。
- chat/page.tsx 已约 6700 行:新视图必须落独立组件,page.tsx 只做数据接线。
- 审核/设最终版面板目前在 ProjectArtifactLibrary 内部:抽取或导出时需同步迁移
  其测试,避免 #836 式「幽灵绿」。

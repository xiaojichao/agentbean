# 执行计划:文件库原型对齐呈现层

## 前置

- 分支:从最新 main 切独立分支 `feat/files-library-prototype`(修复纪律:独立分支)。
- 先 `grep -rn "OutputPackageList\|ProjectArtifactLibrary" apps/web-next --include="*.tsx" --include="*.ts" -l`
  确认全部引用方(task 详情交付视图可能复用 OutputPackageList),决定删除或保留导出。

## 检查清单(按序)

1. [ ] **抽取引用构建逻辑**:`OutputPackageCard` 的投影预览+选择构建 →
   `apps/web-next/lib/output-package-reference.ts`;OutputPackageCard 改调用,
   其现有测试原样通过(纯移动,不改语义)。
2. [ ] **聚合模型 + 纯函数**:lib 新增 `file-group-model.ts`(或并入现有 lib):
   packages+collections+stages → `FileGroupCardModel[]`(混排、lastActivityAt 排序、
   waiting 差集、筛选/搜索谓词)。RTL/纯函数单测先行。
3. [ ] **ProjectFilesBoard 骨架**:左栏三类卡片 + 右栏七列表格 + 工具栏;
   data-smoke 沿用 output-package-item / project-artifact-collection 等旧名;
   fixture 驱动渲染测试(首帧断言用 renderToString,遵循 web-next 测试惯例)。
4. [ ] **page.tsx 接线**:选中卡片 state、getOutputPackage 懒加载缓存 +
   artifactsUpdated 失效、筛选/搜索 state;替换 2501-2535 堆叠渲染。
5. [ ] **工具栏引用三入口**:引用当前包/引用最终版包(投影预览→选择或 blockers
   清单)/多选引用(package_members);落 projectReferenceSelections。
6. [ ] **行动作**:预览/编辑(Markdown→现有 revision 编辑器;图片→ArtifactViewer)、
   单行引用、基于此修改(#1062 request);集合版本行展开复用抽取出的
   VersionDecisionPanel/FinalizationHistory。
7. [ ] **提升入口**:工具栏「提升为逻辑产物版本」(project-lead 限定)复用
   PromoteArtifactForm。
8. [ ] **收尾清理**:删除被取代的 OutputPackageList/ProjectArtifactLibrary(若第 0 步
   确认无其他引用方),迁移其测试断言到新组件。
9. [ ] **spec 更新**:trellis-update-spec 同步 web-next spec(文件库新结构)。

## 验证命令

```bash
cd apps/web-next && npx tsc --noEmit        # 类型( barrel/幽灵导出盲区,必跑 )
cd apps/web-next && npm test                # web-next 全量 vitest
npm run test:ci                             # 收尾前全量(子集绿灯不算数)
```

## 风险文件 / 回滚点

- `apps/web-next/app/[teamPath]/chat/page.tsx`(6700 行,接线 diff 控制在 ~150 行内;
  大文件编辑注意括号配平,必要时分段编辑)。
- `components/OutputPackageCard.tsx`(抽取只允许移动;每步跑其测试)。
- `components/ProjectArtifactLibrary.tsx`(删除前核对审核/设 final/提升能力已迁移)。
- 回滚点:步骤 1-2(纯新增+抽取)可随时独立提交;步骤 4 接线前为最后一个安全点。

## 完成后检查

- [ ] AC1-AC7 逐条对照(prd.md)。
- [ ] `npm run test:ci` 全绿;tsc 无错。
- [ ] data-smoke 选择器清单与测试同步,无悬空断言。

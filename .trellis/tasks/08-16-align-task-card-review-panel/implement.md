# 执行计划：任务页待审核卡片内嵌审核面板

前置：从 `origin/main`（`94f4d580`）切分支 `feat/task-card-review-panel`。当前工作区在 `fix/package-preview-basis`（落后 main），实现须在 main 基线分支上进行。

## 切片顺序（每步可独立验证，commits ≤ 3 原则分批推送）

### Step 1：分支与基线
- [ ] `git checkout main && git pull && git checkout -b feat/task-card-review-panel`
- [ ] `pnpm -C apps/web-next exec tsc --noEmit`（基线绿确认）
- 验证：本地基线无红

### Step 2：TaskCardReviewPanel 组件（R1/R2 核心）
- [ ] 新建 `apps/web-next/components/TaskCardReviewPanel.tsx`：焦点包投影加载 + 三组动作 + help 文案 + 意见对话框
- [ ] `apps/web-next/lib/package-review-actions.ts`：提取 `submitPackageBatchReview`（批量成员决策提交）；`OutputPackagePreviewModal` batch 路径改用该函数（行为不变）
- [ ] 单测 `apps/web-next/tests/task-card-review-panel.test.tsx`：
  - availableActions 投影驱动按钮可见性
  - 通过/通过并设最终版直接提交；要求修改/拒绝弹对话框且意见必填
  - 回到讨论串不改状态（无 mutation 调用）
- 验证：`pnpm -C apps/web-next exec vitest run tests/task-card-review-panel.test.tsx`

### Step 3：ProjectWorkCard 接线（R2/R3）
- [ ] review lane 卡片接入 TaskCardReviewPanel；待审核输出区升级为成员清单（投影未就绪回落摘要）
- [ ] 移除「任务卡片只做状态摘要和入口」区块与「查看交付文件与审核」按钮
- [ ] active lane「交给智能体处理」→ 定位讨论串预填（不打开侧边栏）；complete lane「查看交付与 final」→ Files 页定位
- [ ] timeline 升级（焦点包 review 记录 + 交付时间，无新查询）
- [ ] 测试更新 `tests/channel-project-progress.test.tsx`：旧按钮断言替换为动作组断言
- 验证：vitest run channel-project-progress + tsc

### Step 4：侧边栏入口退役 + 区块删除（R3/R4/#1225）
- [ ] `chat/page.tsx`：`openProjectStage` → `locateProjectTask`（卡片滚动定位，不 set task-only）；TaskDetailPanel 渲染条件移除 task-only 分支；`task=task:` 深链回落卡片定位
- [ ] `TaskDetailPanel` 删除六区块及其私有 hooks/工具函数；props 收窄
- [ ] 检查 `taskDetailOnlyTaskId`/`taskDetailMessages` 等状态的残余引用（grep 清零）
- [ ] 测试：新增两种 URL 形态渲染一致性断言（区块不存在）；更新受影响快照/查询
- 验证：`pnpm -C apps/web-next exec vitest run && pnpm -C apps/web-next exec tsc --noEmit`

### Step 5：全量验证
- [ ] 仓库根 `pnpm run test:ci`（完整跑，不用子集——既有纪律）
- [ ] 手动冒烟（本地 dev server + 真实数据频道）：卡片动作提交→摘要刷新、回到讨论串定位、深链回落
- 验证：CI 绿 + 冒烟记录到任务目录

### Step 6：收尾
- [ ] PR：`feat/task-card-review-panel` → main，body 含 `Closes #1225`（收口说明）+ 原型/设计文档引用
- [ ] `.trellis` spec 更新（若有新惯例：批量提交共享函数）
- [ ] 交付观察结论格式收尾

## 回滚点

- Step 2/3 相互独立可单独 revert
- Step 4 动了 god file，单独 commit，revert 即恢复侧边栏

## 风险与对策

| 风险 | 对策 |
|---|---|
| chat/page.tsx 删区块牵连隐藏引用 | tsc 兜底 + grep 残余清零清单 |
| 卡片 N 查询（13 包） | getOutputPackage 轻量 socket 查询，与 Files 页同量级；review lane 才查 |
| vitest 绿但 tsc 红（幽灵导出教训） | 每步都跑 tsc，不只 vitest |
| 批量动作误伤可选成员 | 批量范围=必需成员（requiredForFinal），与预览弹窗 batch 语义对齐 |
| 深链失效 | Step 4 显式处理 `task=task:` 回落并测试 |

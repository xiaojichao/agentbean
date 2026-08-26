# 技术设计：任务页待审核卡片内嵌审核面板

对应 prd.md。基线：origin/main `94f4d580`（实现分支从 main 切出）。

## 1. 现状结构与改动点

```
ChannelProjectProgress.tsx        项目工作台三列看板（active/review/complete lane）
  └ ProjectWorkCard               卡片：meta-grid + 摘要 + 单按钮 onOpenStage → 【改：内嵌 review-panel】
chat/page.tsx (7661 行)
  ├ openProjectStage              设置 task=task:<id> → 渲染侧边栏 → 【改：不再打开侧边栏，卡片定位】
  ├ TaskDetailPanel (L4571)       任务详情侧边栏 → 【改：删除原型没有的区块】
  │   ├ 任务消息/Task DAG/最新结果/状态历史/环境信息/附件  → 【删】
  │   ├ StageDeliveryReviewWorkspace (stageId 有值)     → 【留，聊天页消息入口仍用】
  │   └ TaskDeliveryOverview (task-only)                 → 【留】
  └ TaskDetailPanel 渲染条件 (L3073)                     → 【改：任务页入口不再触发】
StageDeliveryReviewWorkspace.tsx  阶段交付审核工作台（不动，保留在侧边栏/消息入口）
TaskDeliveryOverview.tsx          task 级概览+动作（不动；其数据形状被卡片复用）
package-review-actions.ts        文件级动作提交基建（复用；提取批量提交为共享函数）
OutputPackagePreviewModal.tsx    预览+审核弹窗（不动；批量审核先例参考）
```

## 2. 卡片内嵌 review-panel（核心新组件）

新组件 `apps/web-next/components/TaskCardReviewPanel.tsx`：

```tsx
interface TaskCardReviewPanelProps {
  channelId: string;
  taskStatus: string;                 // 'in_review' 才渲染动作
  focusPackageId: string | null;      // entry.delivery.focusPackageId
  archived: boolean;
  onBackToThread: (threadRootMessageId?: string) => void;
  onMutationSucceeded: () => void;    // 刷新 workspace 投影
}
```

- 挂载时用 `getOutputPackage({channelId, packageId})` 拉焦点包 availableActions（`OutputPackageCard` 同款通道，含成员明细）；订阅 `projectEvents().onArtifactsUpdated/onUpdated` 刷新
- 动作组渲染（原型文案）：
  - 审核结论：`通过审核`（solid 蓝主按钮）/ `要求修改`（pill）/ `拒绝此版本`（danger）→ 批量作用于全部必需成员（对齐预览弹窗 batch review：`buildPackageMembersSelection` 全成员）
  - 版本选择：`通过并设为最终版`（amber 实心）
  - 继续协作：`回到讨论串继续`（pill）→ `onBackToThread(包投影 threadRootMessageId)`
- 按钮可见性 = Server availableActions 投影（成员级 actions 取并集；Server 未投影任何 action 时按钮组整体隐藏，不留死按钮）
- 意见收集：`要求修改`/`拒绝此版本` 弹轻量确认对话框（复用 `MutationConfirmDialog` 交互模式，comment 必填）；`通过审核`/`通过并设为最终版` 直接提交（无意见）
- 提交走 `package-review-actions.ts` 既有 `submitDeliveryMutation`/包级 mutation 通道（把批量决策扩展为该 lib 的导出函数 `submitPackageBatchReview`，预览弹窗 batch 逻辑同步改用，避免两份实现）

## 3. 卡片内容升级（ProjectWorkCard 内）

- review lane：`待审核输出` 摘要区升级为成员清单（`F1 文件名 v3 · 来源`），数据与 review-panel 同一焦点包投影；投影未就绪时回落现有文字摘要（不阻塞卡片渲染）
- timeline：review/complete lane 的时间线从单行改为事件列表（数据源 `TaskDeliveryOverviewV1.timeline`；卡片懒加载——仅当 entry 投影无 timeline 时按需查询，避免列表页 N 查询；首版直接用 workspace entry 已有摘要 + 焦点包 review 记录，不新增查询）
  - 决策：首版 timeline 数据用焦点包投影的成员 review 记录 + 交付时间（来自现有投影），不额外拉 TaskDeliveryOverview——把查询预算留给 review-panel 的 availableActions
- 移除 review lane 的「任务卡片只做状态摘要和入口」amber 区块与「查看交付文件与审核」按钮（原型无此文案）
- active lane：保留「交给智能体处理」（onOpenStage → 定位讨论串预填 @，复用 #1178 delegate 语义，不再打开侧边栏）
- complete lane：保留「查看交付与 final」入口 → 改为定位 Files 页（原型：交付与 final 以卡片事实为准，明细在文件页）

## 4. 侧边栏退役与区块删除（R3/R4）

### 4.1 任务页入口

- `openProjectStage` 改名 `locateProjectTask`：不再 `setTaskDetailOnlyTaskId`，只做卡片滚动定位（`data-task-id` 锚点，复用现有 selectedStageId 滚动 useEffect）+ URL 保留 `stage=` 定位参数
- URL `task=task:<taskId>`（无消息锚定）不再触发侧边栏：渲染条件 `(taskDetailMessage || (taskDetailOnlyTaskId && taskDetailTask))` 中移除 task-only 分支；`task=task:` 参数保留解析但仅用于卡片定位（深链兼容：`useEffect` 观测后滚动到对应卡片，清参数）
- 消息锚定形态（聊天页打开）保留侧边栏

### 4.2 TaskDetailPanel 区块删除

删除区块（两种形态统一）：任务消息、Task DAG、最新结果、状态历史、环境信息（含 workspaceRunDetail 状态与加载逻辑）、附件（artifacts 汇总）、相关未用工具函数与 import（`uniqueArtifacts`/`workspaceRunHistory` 等仅服务这些区块的，一并清理，tsc 兜底）
保留：header、状态徽章/创建者/负责人、描述/tags、交付视图（`StageDeliveryReviewWorkspace` / `TaskDeliveryOverview`）、底部任务状态操作（managed 任务的具名关闭操作，原型任务状态契约 §8.4 范畴内）
连带：`taskDetailMessages`（relatedMessages）仅用于已删区块 → props 收窄为 `message`（锚定态 header 摘要用）；`matchingChannelTaskStageId` 保留

### 4.3 #1225 收口

- 现象载体（消息上下文区块）删除 → 两种形态渲染一致，矛盾空态文案消失
- #1225 在 PR body 写 `Closes #1225`，说明收口方式为「入口收敛 + 区块移除」而非反查源消息
- 若 reviewer 认为仍需显式 taskId 反查消息上下文，那是被否决的备选方案（见 §7）

## 5. 数据流与查询预算

- review lane 每张卡 1 次 `getOutputPackage`（availableActions + 成员）；13 张卡 ≈ 13 次轻量 socket 查询，与 Files 页 `listOutputPackages` 同量级，可接受
- 卡片卸载停止订阅；`onArtifactsUpdated(channelId)` 刷新时按 packageId 命中刷新
- 提交成功 → `onMutationSucceeded` → 父级重拉 channelTaskWorkspace（lane 归属变化，卡片可能移列）+ 本卡投影刷新

## 6. 兼容与回滚

- Server/contracts 零改动；纯 web-next 变更
- 深链 `task=task:<id>` / `stage=<id>` 行为兼容（定位回落）
- 风险点：`chat/page.tsx` 7661 行 god file 内删除区块牵连 hooks/状态——以 tsc + 既有测试（`tests/` 内 task-detail 相关）兜底；回滚 = revert 单 PR

## 7. 被否决方案

- **给 task-only 形态反查源消息修 #1225**：治标；且原型根本不要侧边栏承载消息上下文（讨论串才是消息容器），修出来也是要删的区块
- **卡片动作打开 OutputPackagePreviewModal 完成审核**：实现最省，但保留「按钮→弹窗」中介，违背原型「动作在卡片上」的交互意图
- **卡片拉 TaskDeliveryOverview 补 timeline/动作**：查询翻倍且与焦点包投影重复；Server 的 task 级动作（accept-delivery 等）属于 Task 验收语义，不在原型 review-panel（文件版本审核）范围

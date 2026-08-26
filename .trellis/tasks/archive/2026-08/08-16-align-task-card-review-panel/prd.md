# 对齐任务页待审核卡片与原型：内嵌审核面板，移除任务详情侧边栏

## Goal

任务页（频道任务标签 → 项目工作台）的待审核任务卡片按 2026-07-28 交互原型对齐：审核动作组内嵌在卡片中，点击「查看交付文件与审核」打开的任务详情侧边栏从该入口退役；侧边栏中原型没有的区块移除。同时以入口收敛方式处理 #1225。

- 原型：`docs/superpowers/prototypes/2026-07-28-chat-task-file-package-flow-prototype.html`（`screen-task` 三列看板）
- 架构设计：`docs/superpowers/specs/2026-07-17-project-task-file-management-design.md`（§7 产品界面期望、§8 交互与状态契约）
- 依据 Issue：#1222（任务卡片对齐原型第一轮）、#1225（任务详情侧边栏两种 URL 形态消息上下文不一致）

## 现状（2026-08-16 生产观察实证）

- 待审核卡片只有一个「查看交付文件与审核」按钮 → `openProjectStage` 设置 `task=task:<taskId>` URL → 渲染 `TaskDetailPanel` 侧边栏（`apps/web-next/app/[teamPath]/chat/page.tsx:4571`）
- `TaskDetailPanel` 含原型没有的区块：任务消息、Task DAG、最新结果、状态历史、环境信息（Workspace Run）、附件
- 侧边栏在 `task=task:<taskId>`（task-only）形态下 `message=null`、`relatedMessages=[]`，上述区块缺失且「最新结果」空态文案与执行链矛盾（#1225）
- 审核动作基建已完备：文件级 `review-approved` / `review-changes-requested` / `review-rejected` / `review-and-finalize`（`apps/web-next/lib/package-review-actions.ts`，label 与原型按钮文案一致）；Task 级 `accept-delivery` / `reject-delivery` / `delegate-to-agent` 等（`TaskLevelAvailableActionDto`）

## Requirements

### R1 待审核卡片内嵌审核面板（原型 `review-panel`）

- review lane 卡片呈现三组动作（原型文案与层级）：
  - **审核结论**：`通过审核`（主按钮）、`要求修改`、`拒绝此版本`；作用于焦点包当前交付版本（全部必需成员）
  - **版本选择**：`通过并设为最终版`（一次事务写审核通过 + finalVersionId）
  - **继续协作**：`回到讨论串继续`（不改任何状态，定位到绑定讨论串输入框）
- 每组附原型 help 文案
- 动作可用性消费 Server 投影的 availableActions（可发现性门禁与 Server 复验 authority 的既有边界不变）
- 要求修改/拒绝需意见填写，复用确认对话框模式；通过类动作一步提交

### R2 卡片内容升级（原型 `mini-package` + `timeline`）

- 待审核输出区展示焦点包成员清单：`F1 文件名 vX（来源摘要）`（数据来自焦点包投影）
- 时间线从单行摘要升级为多事件时间线（交付/审核/final 等事实）
- 保留既有：task-type、标题、meta-grid（负责人/建议或实际审核人/输出/状态）、缺失输入与阻塞提示

### R3 任务页入口不再打开侧边栏

- 任务页（项目工作台 + 普通任务视图）卡片点击不再设置 `task=task:<taskId>` 也不渲染 `TaskDetailPanel`
- 「查看交付文件与审核」按钮移除（动作已内嵌）；已结束/进行中卡片的入口按原型收敛（已结束卡展示 final 摘要；进行中卡保留「交给智能体处理」定位讨论串）
- `task=task:<taskId>` 深链行为保持可解析（不 404）：回落到任务页卡片定位/滚动，不打开侧边栏

### R4 移除侧边栏中原型没有的区块（#1225 收口）

- `TaskDetailPanel` 删除：任务消息、Task DAG、最新结果、状态历史、环境信息、附件区块
- 保留：header（标题/状态）、状态徽章与创建者/负责人、交付视图（`StageDeliveryReviewWorkspace` / `TaskDeliveryOverview`）
- 聊天页消息入口（消息锚定形态）打开的任务详情同样只保留上述区块；消息上下文回讨论串查看（原型语义：讨论串是消息容器）
- 删除区块后两种 URL 形态渲染一致，#1225 的现象与矛盾文案消失

## 非目标

- 不改 Server 命令与 contracts（动作基建已存在，仅 Web 接线）
- 不做原型文件页/讨论串的重构（已按 #1135/#1136 等对齐）
- 不改普通任务看板（plain 视图）的状态管理交互
- 深链 `stage=<stageId>` 定位滚动逻辑保留

## Acceptance Criteria

- [ ] AC1：review lane 卡片内嵌三组审核动作，文案与层级对齐原型 `review-panel`；通过/要求修改/拒绝/通过并设最终版提交后 Server 事实变更且卡片摘要刷新
- [ ] AC2：「回到讨论串继续」定位到绑定讨论串输入框，不产生任何 Server 写入
- [ ] AC3：待审核输出区展示焦点包成员（短编号+文件名+版本+来源摘要）；时间线呈现多事件
- [ ] AC4：任务页卡片点击不再打开任务详情侧边栏；页面无「查看交付文件与审核」按钮
- [ ] AC5：`TaskDetailPanel` 不再渲染任务消息/Task DAG/最新结果/状态历史/环境信息/附件；消息锚定与 task-only 两种形态渲染一致（#1225 现象消失）
- [ ] AC6：`task=task:<taskId>` 深链不 404，回落任务页卡片定位
- [ ] AC7：`test:ci`（web-next vitest + tsc）全绿；新增/修改组件有测试覆盖（动作提交、区块移除断言、深链回落）

## Notes

- 复核提示：动作仍由 Server 复验 authority，卡片按钮只是可发现性投影——不得在前端自行推断权限（沿 #1177 nodeKind 同构门禁教训）
- 批量审核已有先例：`OutputPackagePreviewModal` 的 batch review panel（全部通过/全部要求修改/全部拒绝）

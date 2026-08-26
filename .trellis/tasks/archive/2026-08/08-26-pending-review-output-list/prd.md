# 待审核任务卡片输出列表化

## Goal

让项目频道“任务”页的待审核任务卡片更易扫读：在不改变 Server-owned 审核事实、任务状态或审核入口的前提下，将“待审核输出”中的逐文件摘要改为语义化无序列表，并继续与项目任务与文件管理架构契约保持一致。

## Background

- 架构设计要求待审核任务卡片只承担本次交付摘要、文件审核覆盖、交付验收状态和处理入口，不在卡片内展开完整审核工作台（`docs/superpowers/specs/2026-07-17-project-task-file-management-design.md:306-313,354,372`）。
- 输出包是冻结成员容器而不是审核对象；每个成员的审核状态必须来自 Server projection，并按具体文件版本展示（同文档 `179-190,304-313`）。
- 当前组件在 `apps/web-next/components/ChannelProjectProgress.tsx:379-455` 已读取焦点输出包成员和 Server-projected 审核态，但把所有成员通过分号拼成一个字符串。

## Requirements

- 仅在待审核 lane 的“待审核输出”区域，把焦点输出包成员按一个文件一项渲染为语义化无序列表。
- 每一项保留现有信息结构：短编号、文件名，以及 Server projection 可用时的审核状态标签。
- 不新增或修改审核、最终版、Task 交付验收、讨论串、文件页入口或权限推导逻辑。
- 当焦点包投影尚未就绪或成员为空时，继续回退到现有交付摘要文本，不伪造成员或审核状态。
- 保持卡片为摘要入口，视觉密度与现有卡片一致，并避免长文件名撑破卡片宽度。

## Acceptance Criteria

- [x] 焦点输出包包含多个成员时，“待审核输出”区域渲染一个 `ul`，每个成员对应一个 `li`，顺序与 Server projection 的成员顺序一致。
- [x] 每个列表项展示短编号、文件名和可用的审核状态标签；状态仍由 `availableActions` 对应的当前版本事实决定。
- [x] 投影缺失或成员为空时仍显示现有 `deliverySummary`，且不渲染空列表。
- [x] 现有查看文件、审核文件、打开讨论串入口与任务卡片其他事实展示保持不变。
- [x] `apps/web-next/tests/channel-project-progress.test.tsx` 覆盖列表语义、逐项内容和回退行为。
- [x] 定向 web-next 测试通过，且 `npm run build:web-next` 通过。

## Out of Scope

- 不改变输出包、文件版本、审核或 Task delivery 的后端模型与接口。
- 不调整任务卡片的三个入口、泳道、筛选器、事实网格或时间线文案。
- 不在任务卡片中新增逐文件审核操作、批量审核、最终版设置或其他功能。

## Technical Notes

- 直接改造 `projectReviewMemberList` 的返回形态，避免再生成分号拼接字符串；具体实现由现有 React/Tailwind 模式决定。
- 本任务是单组件与单测试文件的轻量前端改动，PRD-only 足够，不新增 `design.md` 或 `implement.md`。

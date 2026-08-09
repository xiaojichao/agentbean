# 调整任务状态信息分层

## Goal

减少频道聊天主线中的任务状态流水噪音，同时保留可审计的任务状态历史，并让任务讨论串通过既有的 System activity 投影展示少量关键里程碑。

用户价值：频道主线继续承担人类与 Agent 的沟通叙事；需要追溯时进入任务详情；需要了解关键进展时在任务讨论串看到克制的里程碑卡。

## Background and Confirmed Facts

- 当前 `task-status-updated` 系统消息会通过 `shouldHideSystemMessage` 留在频道主线，见 `apps/web-next/lib/system-messages.ts:15-16` 与 `apps/web-next/tests/system-messages.test.ts:28-31`。
- ChatPage 的频道主线、Thread 回复和回复计数都从 `visibleMessages` 派生，见 `apps/web-next/app/[teamPath]/chat/page.tsx:1702-1711`。
- TaskDetail 的“状态历史”同样依赖这些状态事件；若直接在 Server/Contracts 序列化边界删除，前端将无法恢复完整历史。当前关联逻辑见 `apps/web-next/app/[teamPath]/chat/page.tsx:1712-1725`。
- 关键里程碑投影已经存在：`in_review`、`delivery_accepted` 等会进入 `thread_card`，见 `packages/domain/src/system-activity-policy.ts:30-42,82-101`。
- `TaskSystemActivitySection` 已能查询 Thread 活动卡，但频道 Chat 的 `ThreadPanel` 尚未消费该卡；Chat 当前只引入责任收件箱，见 `apps/web-next/components/TaskSystemActivitySection.tsx:21-75` 与 `apps/web-next/app/[teamPath]/chat/page.tsx:30,4301,4611`。

## Requirements

1. `task-status-updated` 系统事件继续保留为客户端可用的任务事实，但不出现在频道主时间线、Thread 回复列表或回复计数中。
2. 任务详情继续展示同一 Task 的完整状态历史，包含状态、时间与原有顺序，不因频道过滤而丢失。
3. 频道中的任务根消息和现有任务状态徽标继续显示当前状态；本次不改变状态写入权限或生命周期规则。
4. 任务关联的频道讨论串复用现有 `thread_card` 查询和 `SystemActivityPanels` 视觉组件，展示既有稀疏关键里程碑。
5. 普通非任务讨论串不得发起 Task 活动卡查询，也不得出现空的里程碑占位。
6. 讨论串里程碑不得重新序列化为 Message，不新增 PI/系统聊天身份，不复制一套新的状态事实。
7. Activity/责任收件箱继续只承载与接收者责任相关的 attention/action_required；普通状态流水不得迁入 Activity。
8. 消息搜索不得继续返回已从聊天投影隐藏的任务状态流水；历史 `?message=` 链接若指向任务状态事件，应打开对应 TaskDetail，而不是落到不可见锚点。

## Acceptance Criteria

- [x] 修改 Task 状态后，频道主线不新增“任务……状态更新为……”药丸消息。
- [x] `task-status-updated` 不进入 Thread 回复列表，也不增加 Thread 回复数。
- [x] 打开对应任务详情仍能看到完整“状态历史”，连续多次状态切换均可追溯。
- [x] 打开任务关联的频道讨论串时，若 Server 已有 `thread_card`，根消息下方显示现有 Task 活动卡。
- [x] `in_review` 与验收完成（现有 `delivery_accepted` 语义）沿用现有 System activity 策略进入关键里程碑；不新增 Server lifecycle fact。
- [x] 普通讨论串不展示 Task 活动卡，也不发起对应查询。
- [x] 搜索结果不包含 `task-status-updated`；已有状态事件深链仍可到达对应任务详情。
- [x] 新增或更新回归测试，且 `apps/web-next` 针对性 Vitest 与 `npm run build:web-next` 通过。

## Out of Scope

- Agent 在线、忙碌、连接中、错误、离线等 Agent availability 状态。
- 改造 Task 生命周期、状态权限、Server command 或数据库结构。
- 新建 `done` fact；本次沿用 `delivery_accepted` 表示验收完成。
- 重设计 Activity 页面、责任收件箱或任务详情整体布局。
- 把历史状态事件迁移、删除或改写为新的数据类型。

## Open Questions

无阻塞问题。

## Notes

- 本任务改动集中在 `apps/web-next`，属于同一信息分层行为调整，采用轻量 PRD-only Trellis 任务。
- 实现时应在 Web 对话投影层隐藏状态事件，而不是扩展 `packages/contracts/src/message.ts` 的 Server 序列化过滤，否则会破坏 TaskDetail 历史。

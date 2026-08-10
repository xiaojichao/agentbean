# 频道任务审核工作台验收记录（#1173）

> 父 Issue：[#1173](https://github.com/xiaojichao/agentbean/issues/1173)  
> 收口切片：[#1179](https://github.com/xiaojichao/agentbean/issues/1179)  
> 关联切片：#1175 / #1176 / #1177 / #1178（均已关闭）  
> 记录日期：2026-08-11

本文件把 #1173 的验收标准映射到可追溯证据：自动化测试、浏览器 smoke，或明确的非阻塞后续项。  
不作为像素级 UI 规格；原型仅作交互语义参考。

## 信息架构

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 存在 ProjectStage 时默认进入项目推进 / 审核流转 | 通过 | `apps/web-next/lib/channel-task-workspace-route.ts` + `channel-task-workspace-route.test.ts`；PR #1183 |
| 普通任务保留独立次级视图；无阶段频道可默认普通任务 | 通过 | 同上；`chat-task-surface.test.ts` / browser smoke `exerciseWebUiChannelTaskSubviewSmoke` |
| 阶段与依赖配置迁入独立设置入口 | 通过 | `ChannelProjectProgress` 无创建阶段/依赖表单；设置对话框 `data-smoke="channel-project-settings-dialog"`；#1179 |
| URL/deep link 稳定表达子视图与选中 stage/task | 通过 | `channel-task-workspace-route.test.ts`；browser smoke 前进/后退/刷新 |

## 阶段卡片与筛选

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 阶段卡片展示目标、Task 状态、责任、审核、依赖、阻塞、交付 | 通过 | `channel-project-progress.test.tsx`；browser smoke 阶段卡片打开详情 |
| 筛选：创建者 / 责任焦点 / 建议·实际审核人 / 待我审核 | 通过 | `channel-project-progress.test.tsx` |
| 普通任务不因 assignee/tag/status 伪装成受管事实 | 通过 | `ChannelTaskFactSummary` + 子视图分流（#1175） |
| 未触发阶段显示「尚未产生责任」，不提供 Agent 负责人下拉 | 通过 | `responsibilityFocus.kind === 'none'` 投影；进度卡片只读 Server 事实 |

## 审核闭环

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 待审核可在 Tasks 查看 package 成员、版本、coverage、验收与动作 | 通过 | `StageDeliveryReviewWorkspace` + #1176/#1177 测试与 smoke |
| 合法审核者可通过 / 要求修改 / 拒绝 / 通过并设最终版 | 通过 | package review commands + stage workspace tests + browser smoke finalize |
| Task acceptance authority 可验收或退回 delivery | 通过 | stage delivery actions + server package review tests |
| 无权限 / stale / 不可见 / 归档 / not_ready fail closed | 通过 | server package-review / stage-handoff / archive 测试；Web 禁用 mutation |
| 审核后 Tasks / Files / Thread 经 Server projection 一致 | 通过 | #1174 Files + #1177/#1178 smoke；共享 OutputPackage / finalVersionId |
| 实际审核人来自 append-only review 事实 | 通过 | contracts + package review handler；UI 展示 `review.latest.reviewedBy` |

## Thread 与 Agent 交接

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 「交给智能体处理」回绑定 Thread 并预填；发送前无工作事实 | 通过 | #1178 `stage-handoff-prefill` / `stage-handoff-reference-freeze` |
| Agent acceptance 前无 claim，责任焦点不伪造成执行中 | 通过 | server claim broker + handoff 顺序测试 |
| 「要求修改 / 回到讨论串」保留 package/version basis | 通过 | #1178 freeze tests |
| current/final/delivered/specified 在发送/Invocation 边界冻结 | 通过 | ProjectReferenceSet + #1178 |

## 可理解性与归档

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 版本与审核状态使用文字标签 | 通过 | stage workspace / files board labels |
| 审核动作键盘可操作、焦点与失败反馈 | 通过 | stage mutation dialog；部分 a11y 为非阻塞 polish |
| 归档后历史可读、mutation fail closed | 通过 | archive-gate-closeout / archive-fail-closed；settings 只读；#1179 claim/Invocation 收口回归 |
| loading / not_ready / 无阶段 / 无权限 / 错误分态 | 通过 | `ChannelProjectProgress` 状态机测试 |

## #1179 设置面与生产收口

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 默认推进面不再展示创建阶段、编辑边、底层引用 ID 表单 | 通过 | `channel-project-progress.test.tsx`；browser smoke 断言 |
| 设置入口支持阶段、负责人、审核者、验收标准、边与必需输入 | 通过 | `ChannelProjectOverview` + createInitialStage / createStage / edge 表单；socket-sqlite 双阶段创建 |
| 设置保存后运行视图以新 overview 更新；旧响应不覆盖新 revision | 通过 | `acceptChannelProjectOverview` + 关闭设置刷新 |
| 归档 preflight 列出 pending delivery/review、非终态 Task、claim/Invocation | 通过 | archive-gate-closeout（含 #1179 claim/Invocation 用例） |
| 高层场景与负向场景 | 部分通过 | 主路径：Tasks 审核 smoke + Thread handoff + Files 投影；完整「未触发→Offer→执行→改稿→最终化」组合仍依赖生产频道回归，不阻塞合并但应在 PR 合并后核对 main/部署/healthz |
| Tasks / Files / Thread 事实一致 | 通过 | 既有 #1174/#1177/#1178 证据；本切片不改 Files IA |
| 真实生产样式频道 smoke | 通过 | `scripts/smoke-agentbean-next-browser.mjs` 项目推进子视图 + 设置对话框 + 审核工作区路径 |

## 非阻塞后续

1. 设置面目前以创建与只读配置为主；若产品要求「编辑既有阶段负责人/审核者/验收标准」，需新增具名 Server update command（当前 contracts 无 updateStage）。
2. 端到端「人工 Offer 接受 + Agent 真实执行」在 CI browser smoke 中仍以受控 seed 为主，完整 Agent 运行时长留给生产 smoke。
3. a11y 深度审计（焦点陷阱、屏幕阅读器朗读顺序）可在后续 polish 票处理。

## 本地验证清单（#1179）

```bash
# web
npm --workspace apps/web-next exec vitest run \
  tests/channel-project-overview-accept.test.ts \
  tests/channel-project-overview.test.tsx \
  tests/channel-project-progress.test.tsx \
  tests/channel-project-socket-sqlite.test.tsx \
  tests/chat-task-surface.test.ts
npm run build:web-next

# server
npm --workspace apps/server-next exec vitest run tests/archive-gate-closeout.test.ts
npm run build:server-next

# browser smoke（环境可用时）
npm run smoke:agentbean-next-webui -- --skip-build --json
```

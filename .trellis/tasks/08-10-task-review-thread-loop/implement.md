# 实施计划：#1178 从任务审核工作区回到讨论串并冻结修改依据

设计见 design.md（核心判断：接线切片，Server 零新命令）。

## 前置

- [x] worktree `.claude/worktrees/task-review-thread-loop`，分支 `feat/task-review-thread-loop`（基于 origin/main）
- [x] hooks 已复制进 worktree（subagent 派发不受 PreToolUse 挡）
- [ ] 首次跑测试前处理 node_modules：worktree 复用姿势=本地建 dist+逐项 symlink（见 memory: worktree node_modules @agentbean 解析）；先用 `cd apps/web-next && npx vitest run tests/task-delegate-prefill.test.ts` 验证环境可用

## 切片 1：「交给智能体处理」预填升级（web）

TDD：先写/改 `tests/task-delegate-prefill.test.ts`（或新 `stage-handoff-prefill.test.tsx`）

- [x] 1.1 测试：delegate 后 thread 打开 + text 含意图文案与 @ + threadSelections 含 focusPackage current 策略 + 焦点恢复 + 无 message:send emit
- [x] 1.2 测试：threadRootMessageId 为空时回落主 composer（现有行为锁定）
- [x] 1.3 实现：chat/page.tsx `onDeliveryAction('delegate-to-agent')` 增强；StageDeliveryReviewWorkspace 需把 focusPackage 上下文随 action 传出（或 action 携带 payload）
- [x] 验证：tsc（web-next）exit0 + 相关 4 文件 43/43 绿

## 切片 2：「要求修改后继续」新入口（web）

- [x] 2.1 测试：可见条件矩阵（changes_requested / delivery 被退回 / 终态隐藏 / 归档隐藏 / 无 focusPackage 隐藏）
- [x] 2.2 测试：点击后预填 `package_members` 显式选择（成员版本=工作区 delivered 投影 Server 事实；delivered not_ready 时不带 selections）+ 意图文案 + @ + 焦点；不落事实
- [x] 2.2a 设计修正（切片 4 实证）：delivered 指针在 changes_requested 后被 REVIEW_BASIS_BLOCKED 拒 → 预填改走 package_members 显式钉版（design.md §2.3）
- [x] 2.3 实现：StageDeliveryReviewWorkspace 导航区新按钮（data-smoke="stage-review-continue-handoff"），可见条件从 workspace Server 事实推导
- [x] 验证：tsc + 单测试文件绿

## 切片 3：composer 冻结提示 + 关联保持（web）

- [x] 3.1 测试：thread composer 含 selections 时渲染「发送时冻结」提示行（data-smoke）
- [x] 3.2 测试：打开 thread 后 URL 同时含 view/stage/task/thread，刷新首帧关联保持（renderToString）
- [x] 3.3 实现：ThreadPanel composer 提示行
- [x] 验证：tsc + 相关测试文件绿

## 切片 4：Server 集成测试（apps/server-next）

- [x] 4.1 新测试文件 `tests/stage-handoff-reference-freeze.test.ts`（双后端 variants，对标 task-linked-request-offer.test.ts:44-62 样板）：
  - 冻结可追溯（AC4）、漂移不影响历史（AC7）、acceptance 间 fence 变化拒绝（AC8）、归档/无权限/不可见/水位未追上（AC9）、reject 后 delivered basis 交接（AC6）、三处投影一致（AC10）
- [x] 4.2 若 4.1 揭示 server 缺口（不允许擅自改设计）→ 回设计文档评审
- [x] 验证：新测试 16/16 + 相关族全绿

## 切片 5：全量验证 + 收尾

- [x] 5.1 `npx tsc --noEmit` 全仓相关包（contracts/server-next/web-next）
- [x] 5.2 web-next 全量 `npx vitest run`；server-next 相关测试族
- [x] 5.3 完整 test:ci（memory: 子集测试漏集成路径——声明全绿前跑完整套件）
- [ ] 5.4 浏览器 smoke 手动路径（本地三服务）：Tasks→阶段详情→要求修改→继续→预填→发送→接受→新交付→回 Tasks
- [ ] 5.5 /code-review（superpowers:requesting-code-review，独立 lane）
- [ ] 5.6 spec 更新（trellis-update-spec：若学到新惯例）
- [ ] 5.7 提交 feat/task-review-thread-loop；PR body 含「Closes #1178」（memory: 否定关键词陷阱——不要写「暂不 Closes」）

## 回滚点

- 每切片独立可 revert；无 DB/合同变更，无数据迁移风险。

## 审阅门

- 本计划经用户审阅后才 `task.py start`。
- 切片 4 若发现 Server 需功能改动 → 停下回设计。

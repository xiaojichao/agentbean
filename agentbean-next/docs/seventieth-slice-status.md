# 第七十切片：web thread UI 与 browser E2E

本文记录 AgentBean Next 第七十切片把 Threads 第一版的 web UI 与真实浏览器 E2E 落到 preview shell。

## 目标

Thread 协议层早在前序切片就已落地：`MessageDto.threadId?`、`message:send` 接受 `threadId`、新 root message 的 `threadId = message.id`、agent reply 继承原 human message 的 `threadId`、dispatch request 的 `history` 用 `listThreadBefore` 只取同一 threadId 的历史、SQLite 持久化 `thread_id`。但 web/preview 完全没有 thread UI——`renderMessages` 扁平渲染、`message:send` 不带 `threadId`、无法发送或查看讨论串回复。

本切片是纯 web/preview UI + browser E2E slice，**服务器零改动**：复用 `message:send` + `threadId` 字段（不引入新的 `thread:*` socket event）。

## 已落地

- `apps/web-next/preview/index.html`：
  - 重构 `renderMessages`：按 `threadId` 分组，root（`threadId` falsy 或 `=== message.id`）按时间序平铺，reply（`threadId !== message.id`，含继承 `threadId` 的 agent reply）缩进嵌套在对应 root 的 `.thread-replies` 容器；孤儿 reply（root 尚未到达）平铺兜底。
  - 提取 `renderMessage(message, { threaded, replies })` helper；逐字不动既有 `renderMessageArtifacts`（workspace output / message attachment 分组、`data-workspace-run-id` 详情入口）。
  - root message 渲染「回复讨论串」按钮（`data-thread-id`）；reply 不渲染该按钮（第一版只支持一级嵌套）。
  - `state.replyThreadId`；`message-form` 内新增默认隐藏的 `#message-reply-indicator`（含取消按钮）；合并 `#messages` click handler 增加 `data-thread-id` 分支；`message:send` 在回复态携带 `threadId`，提交后清空。
- `apps/web-next/tests/preview-page.test.ts`：新增两条 DOM 测试——发送 thread reply 并嵌套、agent reply 经 `channel:message` 继承 threadId 后嵌套；harness element id 列表补充 `message-reply-indicator` / `message-reply-cancel`。
- `scripts/smoke-agentbean-next-browser.mjs`：新增 `exerciseThreadBrowserSmoke`（点击 root reply 按钮 → 断言 indicator → 输入 thread reply → 提交 → 断言 reply 可见且 `.thread-reply` 嵌套），并在主 smoke 流程接入，push `browser-thread-reply-nested` check。
- `apps/server-next/tests/browser-smoke-script.test.ts`：为 `exerciseThreadBrowserSmoke` 补单测（fake page 捕获 click / setInputValue / submit / waitForText / 三个 waitForFunction 表达式）。
- docs：verification matrix 新增 P4-26 与 E2E-10，E2E gate 收敛备注同步；known-gaps 把 Threads「Web thread UI 与 browser E2E」标记为已收敛；post-flip-follow-up-status 的 DM/thread 第一版补 web thread UI 覆盖。

## 验证命令

```bash
npm run build:web-next
npm run test:web-next
npm run test:server-next
npm run smoke:agentbean-next-browser -- --skip-build
```

## 剩余边界

- 第一版只支持一级嵌套（root + reply 列表），reply 上不渲染 reply 按钮；多级嵌套、thread 专页、更丰富的 thread 产品流仍是后续切片。
- 当前 browser smoke 只验证 human thread reply 的发送与嵌套渲染；agent 在 thread 内的真实 dispatch 继承由服务器测试与 DOM 测试覆盖。
- `state.replyThreadId` 仅内存，刷新清空（符合预期）。

# 坑：消息覆盖、成员详情重挂、dispatch hint、tsconfig 排除、归因丢失

## 何时适用

触碰频道消息状态、改成员/Agent 详情路由、修 dispatch 失败提示、改 `src/` 或 `lib/` 类型、给接消息路径加归因字段时。先读这一篇，避免重蹈已修复的 bug。

## 坑 1：applyChannelHistory 整数组替换 → 抹掉客户端 dispatchStatus

**症状**：切频道/切页面再回来，Agent 正在处理的消息「正在处理…」状态消失。

**根因**：`dispatchStatus`/`dispatchError`/`dispatchId` 是客户端由 `message:dispatch-status` 事件累积的派生态，不在服务端 `MessageDto` 里。早期 `applyChannelHistory` 整数组替换 `messagesByChannel[channelId]`，把客户端 running 态清成 undefined。

**正解**：`apps/web-next/lib/store.ts:338-343` 的 `applyChannelHistory` 改调 `mergeChannelHistory(msgs, existing)`。`apps/web-next/lib/chat-scope.ts:158-192` 的 `mergeChannelHistory`：incoming 对集合/顺序/内容权威，但按 id 保留 client 的 dispatch 三件套（`message.dispatchStatus ?? existing.dispatchStatus`，`:170`），并暂留仍在 pending 且在历史时间窗内的 current-only 消息。

**反模式**：任何形式地把 `messagesByChannel[channelId]` 整体赋值成服务端 history 数组。要改合并语义，改 `mergeChannelHistory`，不要绕过它。

**验证**：`cd apps/web-next && npx vitest run tests/chat-scope.test.ts`。

## 坑 2：成员详情重挂载 flaky（#853）——route segment 别名导致整树 unmount

**症状**：成员列表点详情后，浏览器 smoke 流程在 `waitForWebUiHumanMemberAction` 命中之后、`page.click` 之前，详情按钮（`data-smoke="member-role-promote-admin"` 等）消失。

**根因**：`app/[teamPath]/human/[userId]/page.tsx` 与 `app/[teamPath]/agent/[agentId]/page.tsx` 是独立 route segment，其 page 体只是 `return <MembersPage />`。从 `/members` 跳到 `/human/[userId]` 会让 `MembersPage` **整树 unmount/remount**，所有 `useState` 清零。旧实现 `useState(null)` + passive effect 从路由参数补回 selectedId，导致「新路由已 commit」到「effect 再 commit」之间存在一帧 EmptyState——详情子树（含各 `data-smoke` 按钮）不在 DOM。

**正解**（`apps/web-next/app/[teamPath]/members/page.tsx:61-80`）：selectedId 从路由派生（`routeAgentId`/`routeUserId` 从 `useParams()` 读，`:72-73`；`routeSelectedId = routeAgentId ?? (routeUserId ? 'user:' + routeUserId : null)`，`:78`；`selectedId = routeSelectedId ?? optimisticSelectedId`，`:80`）。`optimisticSelectedId` 只服务「点击后、导航落地前」的即时高亮。

**判定要点**：要判断一个选中态是否属于这类回归风险，看它是否由「page 体 = `return <XPage />` 的 route segment」驱动。是 → 路由派生 + renderToString 首帧测试（见 [testing.md](./testing.md) §5）。

**反模式**：`useState(null)` 初值 + `useEffect` 里从路由参数 `setSelectedId(...)`。

**验证**：`cd apps/web-next && npx vitest run tests/members-page-route-selection.test.tsx`（renderToString 首帧断言）。

## 坑 3：dispatch-failure hint 只喂 errorCode 没喂 detail → 全落「Agent 处理失败」

**症状**：频道里 dispatch 失败的可执行提示永远兜底成通用「Agent 处理失败」，分类器没识别到具体原因（Missing environment variable / usage limit / node not found 等）。

**根因**：server 把失败原因写进 `dispatches.error_message`，经 socket 以 `dispatch.error` 下发，前端存进 `msg.dispatchError`。该值可能是 errorCode 风格串（`WORKSPACE_RUN_FAILED`），也可能是诊断文本。而 `@agentbean/contracts` 的 `classifyDispatchFailure` 的诊断正则**只作用于 `detail`**，`errorCode` 只匹配少数已知码。若只把 `dispatchError` 喂给 `errorCode`，诊断文本永远进不了正则。

**正解**：`apps/web-next/lib/dispatch-failure.ts:48-58` 的 `buildFailedDispatchHintInput` 把 `dispatchError` 同时喂进 `errorCode` **与** `detail`：

```ts
return {
  status: 'failed',
  errorCode: input.dispatchError,
  detail: input.metaDispatchErrorDetail ?? input.dispatchError,  // 双喂
};
```

`metaDispatchErrorDetail`（server 未来显式下发的结构化 detail）优先；否则用 `dispatchError` 兜底，让诊断文本能被正则识别。把 errorCode 串也喂给 detail 是安全的：`classifyFromText` 对已知码返回 null，再由 errorCode 分支命中，不会被正则误判（docblock `:43-47`）。

**反模式**：只填 `errorCode` 或只填 `detail`。改这个映射时同步看 contracts 的 `classifyDispatchFailure`。

**验证**：`cd apps/web-next && npx vitest run tests/dispatch-failure.test.ts`（若存在）；或 grep 调用方确认 `buildFailedDispatchHintInput` 的使用。

## 坑 4：tsconfig 排除 src/ 与 tests/ —— 改 src/ 不进 next build

**症状**：改了 `apps/web-next/src/index.ts`，`next build` 没生效；或以为 `app/` 能 import `src/`。

**根因**：`apps/web-next/tsconfig.json:43-47` 的 `exclude` 显式列了 `node_modules`、`tests`、`src`。Next 应用构建（`build:app = next build`）只看 `app/`、`components/`、`lib/`。`src/` 是独立公共入口，只经 `tsconfig.lib.json:13`（`include: ["src/**/*"]`、`outDir: "dist"`）编进 `dist/`，给 daemon 等复用（`src/index.ts` 导出 `WebSocketTransport` 类型）。

**正解**：改 `src/` 后跑 `npm run build:client`（= `tsc -p tsconfig.lib.json`）让 `dist/` 更新；改 `app/components/lib` 跑 `npm run build:app` 或 `next build`。两者独立。

**反模式**：在 `app/`/`components/`/`lib/` 里 `import` 来自 `src/...`；或改了 `src/index.ts` 不重建 `dist/` 就发布。

**验证**：`cd apps/web-next && npm run build:client && npm run build:app`。

## 坑 5：ChatMessage.teamId 可选 → 接新消息路径时静默丢归因

**症状**：归因/审计逻辑在新消息路径上拿不到 `teamId`，却编译通过、测试绿灯。

**根因**：`apps/web-next/lib/schema.ts:74-76`：

```ts
export interface ChatMessage {
  // ...
  teamId?: string;   // 可选
}
```

`teamId` 是可选字段。接任何「新消息 → 归因/投影」的路径时，若直接 `msg.teamId` 不做 `undefined` 守卫，编译器和 vitest 都不会报错，但运行时归因会静默丢失（参考 MEMORY 中 #965 的 gotcha：`ChatMessage.teamId` 可选会静默藏归因，曾让 tsc red 在 vitest 绿灯下隐藏）。

**正解**：在新消息处理路径上把 `teamId` 当成可能缺失的值处理——显式守卫 `if (!msg.teamId) return ...;` 或从可信上下文（`currentTeamId`/频道归属）回填，而不是假设它一定在。改归因相关代码后**必跑 tsc**（不只 vitest），因为幽灵导出/可选字段问题在 vitest 下可能绿灯。

**反模式**：`msg.teamId!` 非空断言；或在新归因路径上不跑 `npx tsc --noEmit -p tsconfig.json`。

**验证**：

```bash
cd apps/web-next && npx tsc --noEmit -p tsconfig.json   # 审归因 PR 必跑
cd apps/web-next && npx vitest run tests/chat-scope.test.ts tests/chat-message-text.test.ts
```

## 坑 6:内嵌卡片 vs 独立卡片的视图收敛(#1111)

output-package 卡片有两种载体:独立 system 消息(commit 时创建,兜底)与 agent 回复的 `meta.outputPackageCard`(结果回报时内嵌)。两者会**同时存在**于消息集合(实时窗口:卡片先到、回复后到)。`visibleMessages` 必须用 `mergedStandalonePackageCardIds`(lib/system-messages.ts)隐藏被内嵌吸收的独立卡片,否则双卡并存。判定跨消息(同 packageId),不能只靠单消息 `shouldHideSystemMessage`。

ChatBubble 内嵌渲染:`outputPackageFromMeta(msg.meta) ?? inlineOutputPackageFromMeta(msg.meta)`——顶层 meta 与嵌套 `outputPackageCard` 都要认。

## 坑 7:卡片级审核动作只消费 Server 投影,批量语义按命令能力选型(#1222 后续/原型对齐)

任务卡片内嵌审核动作（`components/TaskCardReviewPanel.tsx`）的两条硬边界：

- **按钮可见性只来自 `getOutputPackage` 返回的 `availableActions`**（成员级 `PackageMemberAvailableActionsDto.actions`）。前端不得从 reviewState/角色/状态推断「可审核」——投影空 = 按钮不渲染，而不是禁用。这沿用 #1061 AC11「客户端只渲染 Server 给的动作」。
- **批量动作选命令按原子性能力**：`submit-package-artifact-reviews`（#1199）是全有或全无的批量决策，三种 decision（approved/changes_requested/rejected）可用；**没有批量 finalize 命令**。多成员「通过并设为最终版」必须逐成员走 `submit-package-review-and-finalize`（#1061 单成员原子），串行提交并透明汇报 N/M——不要伪造整包原子性，也不要为此新增批量 Server 命令（final 是 per-collection 指针）。

另外：`getOutputPackage` 客户端响应带 `threadRootMessageId`（Server 从 package provenance 解析），「回到讨论串」类导航直接用它，不需要从消息缓存反查。

## 佐证文件一览

| 坑 | 主佐证 |
|---|---|
| 1 消息覆盖 | `lib/store.ts:338-343`、`lib/chat-scope.ts:158-192,170` |
| 2 成员详情重挂 | `app/[teamPath]/members/page.tsx:61-80`、`app/[teamPath]/human/[userId]/page.tsx`、`app/[teamPath]/agent/[agentId]/page.tsx`、`components/member-detail.tsx:602,687` |
| 3 dispatch hint | `lib/dispatch-failure.ts:36-58`（docblock `:43-47`） |
| 4 tsconfig 排除 | `tsconfig.json:43-47`、`tsconfig.lib.json:13`、`src/index.ts` |
| 5 teamId 可选 | `lib/schema.ts:74-76` |
| 7 卡片动作投影 | `components/TaskCardReviewPanel.tsx`、`lib/package-review-actions.ts`（`submitPackageBatchReview`/`submitPackageReviewAndFinalizeMember`） |

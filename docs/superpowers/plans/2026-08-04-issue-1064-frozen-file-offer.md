# #1064 从 Task 讨论串把冻结文件交给下游 Agent — 实现计划

- Issue: [#1064](https://github.com/xiaojichao/agentbean/issues/1064)
- 父规格: #1059（§6 引用冻结与下游 Agent、§9 Command registry、§11 失败/并发/审计）
- 前置已合: #1060（OutputPackage）、#1061（review/finalization basis）、#1063（ProjectReferenceSet 包选择冻结）
- 日期: 2026-08-04

## 1. 规格要点（来自 #1059 §6/§9/§11 + issue AC）

1. Task 页"交给 Agent 处理"只导航到关联 Thread，预填 Task linkage、package/file selectors 与说明文本，焦点移 composer；**未发送不创建任何 Message/Offer/claim/Invocation/负责人事实**（AC1/AC2）。
2. 发送 Task-linked `@Agent` 请求时 Server 复验：Channel membership、Task authority、Task revision/attempt、Agent eligibility、Team visibility、operation restriction、Artifact visibility、input binding、review/final basis、Channel archive（AC3）。
3. Tracked task 只按既有 allocation 合同发布 targeted/candidate-set Offer；Offer 只披露最小 preview，不授予输入访问、不建立 claim、不创建 Invocation（AC4/AC5/AC9）。
4. Acceptance 事务重校验 Task、manifest、eligibility、capacity、package/version basis，原子建立 claim + execution context grant（AC6）。
5. Invocation 创建时复验 claim、revision/attempt、stable input fence、ProjectReferenceSet，写 immutable intent（artifactVersionId、review/finalization basis、input binding）；执行期不重新解析（AC7）。
6. Offer 过期、权限/版本/basis 变化、归档时 fail closed，不留部分事实、不替换输入版本（AC8/AC11/AC12）。
7. Simple agent request 与 escalation 继续走既有唯一 authority path，不建第二套 dispatch/handoff 协议（AC9）。
8. Task 责任焦点只由 Offer/acceptance/claim/execution start/delivery/review wait 等 Server 事实投影（AC10）。
9. 测试：Server 集成覆盖 Offer→acceptance→claim→Invocation 的权限/原子性/幂等/frozen input；Web 测试证明预填不创建事实、accept 前后责任焦点一致（AC13）。

## 2. 现状（已具备，直接复用）

| 能力 | 位置 |
|---|---|
| Offer 全生命周期（原子创建 #948-B、TTL、hardSpecified、requirementConfirmation、accept/reject/needs_info/counter_proposed、CAS 单赢家） | `apps/server-next/src/application/management/task-claim-broker.ts` `respondToOffer` @1029；`task-coordination-kernel.ts` `publishForClaim` @464 |
| Eligibility 解析（含 operation restriction=agent exposure restriction、Team visibility、channel/依赖/阶段门禁） | broker `resolveCandidates` @263；`agent-exposure-service.ts` |
| Claim/Lease/grant：acquire/renew/release/relinquish、executionStarted、manifestRevision+workspaceRevisionId 冻结、撤销链 | broker @595-1370；`task-execution-grant-policy.ts` |
| Invocation 校验：authority/revision/attempt/claim fence/projectStageInputFence/intentHash | `invocation-gateway.ts` `resolveTaskInvocationAuthority` @391、`validateAuthoritativeTarget` @527、`validateFrozenIntent` @647 |
| review/finalization basis：`humanAcceptanceAuthorityIds` + `reviewPolicy` | `task-coordination-kernel.ts` @238/328；`package-review-policy.ts`；migration 0078 |
| ProjectReferenceSet 冻结：6 臂 selection（含 package_projection/package_members）、exact-key 校验、message:send 时冻结 | `packages/contracts/src/project-reference.ts`；#1063 |
| Task coordination：revision/attempt fence、authority、input binding gate | kernel `authorizeCommand` @1109、`assertExpectedRevision` @1517、`requireInputBindingsResolved` @1454 |
| Channel membership/archive 门禁 | sendMessage 既有 |
| Web: package selection chips、composer selections state、Thread 面板、Task 页 TaskThreadPanel | `apps/web-next/app/[teamPath]/chat/page.tsx`、`tasks/page.tsx` |

## 3. 缺口（#1064 要建）

1. **无 task-linked request 通道**：用户消息不能触发 Offer（只有 PI 工具与 stage-auto 两条内部路径）。
2. **Offer 不冻结输入版本**：`publishForClaim` 建 offer 时 `objective.inputs: []`；TaskOfferRecord 无 frozen inputs 字段。
3. **Invocation intent 无 frozen inputs**：`AgentInvocationIntentV1` 无 artifactVersionId/input binding/review-final basis。
4. **acceptance 不重校验 package/version basis**。
5. **Web 无"交给 Agent 处理"预填导航**。

## 4. 设计决策

- **D1 预填 selection**：Task 页"交给 Agent 处理"默认预填该 task 最近一个 OutputPackage 的 `package_projection(delivered)` selection（`OutputPackageSummaryDto` 无 member collection revisions，delivered 无 fence 要求且语义="交付的冻结版本"）；多个 package 时预填最近交付（packages 数组首项）。composer 里 chips 可删改、可换 policy（复用现有 OutputPackageCard 选择 UI）。
- **D2 task-linked 检测**：`message.send` 时满足 ①消息 meta 带 taskId（或 asTask 新建）②mentions 含 agent ③selections 非空 → task-linked @Agent request。
- **D3 接入点**：在 `usecases.ts` sendMessage 消息提交成功后（referenceSet 已冻结、task 已建、management routing 已发生）插入 `requestTaskAgentWork` 钩子：复验失败 → `makeFailure`（结构化原因，web 保留草稿，符合 §11）；成功 → 按既有 allocation 合同发布 Offer。
- **D4 Offer 发布方式**：复用既有 `TaskOfferRecord` 合同与 broker 下发/接受机制（不建第二套协议）。targeted（用户显式 `@Agent`=主执行者约束）→ 单 offer；候选集 → resolveCandidates + 既有 decideOfferAllocationPolicy。offer 上冻结 `frozenInputs`（来自已冻结 referenceSet 的 artifact_version items）。
- **D5 frozen inputs 合同**：新 `FrozenProjectInputItemDto { collectionId, artifactVersionId, versionNumber, filename, isFinal, reviewState }`；`TaskOfferRecord` 加 `frozenInputs` 列（JSON，migration 0080）；`AgentInvocationIntentV1` 加 `frozenInputs`。
- **D6 acceptance 复验**：`respondToOffer` accepted 分支加 frozen inputs 复验（每个 artifactVersionId 仍存在且属于 offer 的 collection、Agent 仍可见该 collection）——失败 fail closed（not_accepted，不建 claim）。
- **D7 Invocation intent**：Invocation 创建时从 claim 关联的 offer.frozenInputs 写入 intent.frozenInputs（不重新解析 current/final）；intentHash 计算纳入。
- **D8 幂等**：offer 发布幂等键 `task-link:${clientMessageId}:${taskId}:${agentId}`；replay 查 offer 已存在即 no-op。消息同 key replay 不重复发 offer。
- **D9 复验链实现**：新 domain 纯函数 `evaluateTaskLinkedRequest`（task-linked-request-policy.ts）做 authority/eligibility/review-basis/input-binding 判定，server handler 装配 repositories 数据（与 #1061 package-review-policy 同构）。
- **D10 simple request 不变**：非 task-linked（无 taskId 或非 tracked）消息走既有 dispatch 路径。

## 5. 切片与改动清单

### Slice 1: Web 预填导航（AC1/AC2）

- `apps/web-next/app/[teamPath]/tasks/page.tsx`
  - `TaskThreadPanel`（@1025）header 按钮区加"交给 Agent 处理"按钮（在"在频道中查看"旁）；`TaskOutputPackageSummary` 返回当前 task packages（现有 `packages` state）。
  - 新 prop `onDelegateToAgent(packageId)`；点击 → 生成 `{ kind:'package_projection', packageId, policy:'delivered' }` selection + 模板文本 `请基于交付文件包继续处理任务「{task.title}」：`（@Agent 由用户补）→ `router.push('/${np}/${routeKind}/${channelId}?thread=${channelId}:${rootId}&compose=${encodeURIComponent(JSON.stringify({ text, selections }))}')`。
  - 仅当有 packages 且有 root 时按钮可用。
- `apps/web-next/app/[teamPath]/chat/page.tsx`
  - query 解析区（@271-277）加 `composeParam = searchParams.get('compose')`。
  - 新 effect（在 thread/message effect 旁）：activeChannel 就绪后解析 compose（JSON：`{text, selections}`），设置 `setInput(text)` + `setProjectReferenceSelections(selections)`，`textareaRef.current?.focus()`；随后 `history.replaceState` 移除 compose 参数（消费一次，刷新不重复填充）；线程面板打开（threadParam 由 tasks 页同时携带）。
  - selections 渲染走现有 chips（@2156-2186）——预填后自动显示，可删改。
- 测试：`apps/web-next/tests/task-delegate-prefill.test.tsx`（源码扫描：按钮存在、URL 带 compose 参数；RTL：预填后 input/chips 状态、发送前无网络调用）。

### Slice 2: Contracts + Domain frozen inputs（AC3/AC7 合同前置）

- `packages/contracts/src/task-coordination.ts`（或新文件 `frozen-input.ts`）：`FrozenProjectInputItemDto`、`TaskOfferDto.frozenInputs`。
- `packages/contracts/src/invocation.ts`：`AgentInvocationIntentV1.frozenInputs`。
- `packages/contracts/src/message.ts`：`SendMessageAck` 加 `taskLinkedOffer` 结果（offersPublished / 结构化 failure reason）。
- `packages/domain/src/task-linked-request-policy.ts`（新）：纯函数 `evaluateTaskLinkedRequest`：
  - Task authority（sender 是 task.creatorId/requester 或 coordination.humanAcceptanceAuthorityIds 之一）
  - revision/attempt fence（expectedTaskRevision/Attempt）
  - review/final basis（frozen 时：rejected/changes_requested 的 current 作为默认输入 → 阻断码；显式 specified 放行）
  - input binding（可选：coordination.inputBindings 与 selections 一致性）
  - 结果：`{ ok: true } | { ok: false; code: ... }`
- 测试：`packages/domain/tests/task-linked-request-policy.test.ts`。

### Slice 3: Server task-linked 复验 + Offer 发布（AC3/AC4/AC5/AC9）

- `apps/server-next/src/infra/sqlite/migrations/team/0080_task_offer_frozen_inputs.sql`：`task_offers` 加 `frozen_inputs_json TEXT`；`agent_invocations`（或 intent 存储表）加列（视 invocation 存储方式定）。
- `apps/server-next/src/application/task-coordination-repositories.ts`：`TaskOfferRecord.frozenInputs?` + 读写。
- `apps/server-next/src/application/task-linked-request-handler.ts`（新）：`requestTaskAgentWork(deps, input)`：
  1. 复验链：channel membership/archive（复用 sendMessage 已验；再验 task 归属 channel）、task authority/revision/attempt（domain 纯函数 + assertExpectedRevision 风格）、agent eligibility（`broker.resolveCandidates` 复用——含 operation restriction/team visibility）、artifact visibility（frozenInputs 的 collection 属于 channel）、review/final basis（domain）、input binding（domain）、frozenInputs 与已冻结 referenceSet 一致性。
  2. 通过 → 按 allocation（targeted=显式 @Agent 单发；否则候选集）创建 `TaskOfferRecord`（带 frozenInputs、objective.inputs=文件名摘要=最小 preview）。
  3. 幂等：查 `task-link:${clientMessageId}:${taskId}:${agentId}` 已存在 offer 即 no-op。
- `apps/server-next/src/application/usecases.ts`：sendMessage 成功路径插入钩子（D3/D8）。
- 测试：`apps/server-next/tests/task-linked-request-offer.test.ts`（memory+sqlite 双后端）：复验通过发布 offer（frozenInputs 冻结）；authority 失败/eligibility 失败/archive/revision stale → 消息发送失败结构化原因；replay 幂等不重复 offer；simple request 不走 offer。

### Slice 4: acceptance 复验 + Invocation immutable intent（AC6/AC7）

- `apps/server-next/src/application/management/task-claim-broker.ts`：`respondToOffer` accepted 分支加 frozen inputs 复验（artifactVersionId 仍存在、归属不变、agent 仍可见）→ 失败 not_accepted（fail closed，无部分 claim/grant）。
- `apps/server-next/src/application/management/invocation-gateway.ts`：Invocation 创建时从 claim→offer.frozenInputs 写入 intent.frozenInputs + review/final basis + input binding 快照；`intentHash` 纳入 frozenInputs。
- `packages/domain/src/task-execution-grant-policy.ts` 或新纯函数：frozen inputs 复验判定。
- 测试：`apps/server-next/tests/task-linked-request-offer.test.ts` 扩展：acceptance 复验失败 fail closed；Invocation intent 冻结 artifactVersionId、执行期 current/final 变化不改变 intent。

### Slice 5: fail closed / 幂等 / 责任焦点（AC8/AC10/AC11/AC12）

- Offer 过期、frozen 版本变化、Channel 归档 → not_accepted/invalidated（既有 TTL 过期机制 + 新复验）；无部分 claim。
- Web：发送失败（rejected/freshness_hold/conflict）保留 input+selections（现有失败不清空逻辑）；错误文本区分原因。
- AC10 验证：Task 页 assignee 显示来源为 task.assigneeId（dispatch/claim 投影）；无自授负责人 UI。
- 测试：Slice 3/4 测试覆盖各失败路径 + 同 key replay。

### Slice 6: 收尾（AC13 + 质量门）

- 全量 `test:ci`（packages + retained-boundaries）。
- `/code-review` 双轴审查；修问题。
- commit 到 `impl-1064-task-thread-frozen-file-offer`。

## 6. 风险与注意

- `sendMessage` 是超大函数（usecases.ts），钩子插入位置要最小侵入；复验失败返回 makeFailure 会拒绝整条消息——语义上符合 §11"调用方保留草稿"。
- offers 表迁移须走 migration 静态注册（`applyTeamMigrations`，记忆：新 migration 加到 applyGlobal/TeamMigrations）。
- worktree 内跑 vitest 须 `cd` 进包目录；contracts/domain 改动后重建 dist（@agentbean 软链解析本地 dist）。
- #1061 gotcha：socket 事件/ack 形状变化须同步 `socket-handlers.test.ts` 事件清单（若改 socket schema）。
- 不改 daemon-next（本票 Server+Web 范围，同 #1059 切片口径）。

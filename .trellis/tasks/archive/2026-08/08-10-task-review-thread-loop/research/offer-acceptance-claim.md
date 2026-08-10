# Research: Offer / acceptance / claim / Invocation 命令链路

- **Query**: offer 如何创建、agent 如何 accept、claim 何时建立、Invocation 输入如何绑定冻结版本；已有命令名与文件
- **Scope**: internal
- **Date**: 2026-08-10

## Findings

### 总览（#1064 既有实现即 #1178 的直接前身）

链路：Thread composer 发 `@Agent + @文件包 + 指令`（带 threadId + selections）→ message:send 事务内复验+冻结引用 → 事务外发布 targeted Offer（冻结 frozenInputs，**不建 claim/Invocation**）→ Agent `task-claim:respond` accepted → broker 事务内二次复验 + CAS offer→accepted + 建 ClaimLease（同事务）→ Invocation 创建时把 accepted offer 的 frozenInputs 写入 immutable intent。

### 1. Task-linked 请求复验与 Offer 发布

`apps/server-next/src/application/task-linked-request-handler.ts`：

- `evaluateTaskLinkedRequestContext(deps, input)`（:88-145）——**只读复验，可（且实际）在 sendMessage 事务内调用，不创建任何事实**。复验链：频道归档、Task authority（creator 或预绑定 humanAcceptanceAuthorityIds）、task revision/attempt fence、Agent eligibility（注入 `resolveEligibleAgentIds`，复用 resolveCandidates 的 operation restriction/Team visibility/渠道门禁）、artifact visibility（frozen inputs 的 collection 必须属于本频道）、review/final basis（rejected/changes_requested 版本不得作默认下游输入，显式选择除外）、input binding resolved。返回 `not_task_linked`（无 coordination → 走旧 simple 路径）/ `rejected(code)` / `ready{coordination, frozenInputs, explicitVersionIds}`。
- `buildFrozenInputs`（:225-280）：把 preview 里的 artifact_version items 解析成 `FrozenProjectInputItemDto[]`（collectionId/artifactVersionId/versionNumber/artifactId/filename/isFinal/reviewState 快照）；review 历史 append-only，按 createdAt 取最新决策（:254-261）。显式版本（package_members/artifact_version arm）记入 explicitVersionIds 免 review 闸。
- `publishTaskLinkedOffers(deps, input, evaluation)`（:153-201）——**事务外、消息提交后**调用。每个显式 @Agent 一个 Offer：`taskRevision`/`taskAttempt`/`manifestRevision` 冻结、`offerTtlMs = 15_000`（:159）、`hardSpecified: true`、`frozenInputs` 随 record 持久化；objective.inputs 只披露文件名摘要（最小 preview，:313-329）。幂等防线：同 task+agent+revision 且 frozenInputs JSON 相同的 open Offer 已存在则跳过（:163-171）；同 clientMessageId 的 message replay 不会走到这里（消息级幂等=offer 级幂等）。
- 已知边界（注释 :36-38）：消息提交后、offer 发布前崩溃会留「消息存在、offer 缺失」窗口；replay 不补发。

Domain 纯裁决：`packages/domain/src/task-linked-request-policy.ts` `evaluateTaskLinkedRequest`（:76-132），失败码 `TASK_NOT_FOUND/TASK_CHANNEL_MISMATCH/TASK_AUTHORITY_DENIED/TASK_REVISION_STALE/TASK_ATTEMPT_STALE/TASK_NOT_OPEN/AGENT_NOT_ELIGIBLE/ARTIFACT_VISIBILITY_DENIED/INPUT_BINDING_UNRESOLVED/REVIEW_BASIS_BLOCKED/CHANNEL_ARCHIVED`（:20-31）。

sendMessage 接线：`apps/server-next/src/application/usecases.ts`：

- 触发条件（:5486-5490）：`messageInput.threadId && agentMentions.length>0 && selections.length>0 && frozen.selections.length>0`。
- 经 threadId 找 root message → `meta.taskId` → task + coordination（:5491-5499）。
- 复验在**消息提交事务内**执行（:5517-5523），失败 → 整条消息 rejected（消息未创建，客户端保留草稿与引用）；fence 用提交点快照，事务外漂移由 Offer 冻结的 taskRevision/attempt 在 acceptance 二次比对兜底（注释 :5507-5509）。
- 复验通过后消息+ReferenceSet 落库，事务外 `publishTaskLinkedOffers`（:5618-5624）。

### 2. Offer 记录与合同

- DTO：`packages/contracts/src/agent-exposure.ts` `TaskOfferDto`（:364 起）——`taskRevision`/`taskAttempt`/`manifestRevision` 发布时冻结作 accept fence；`frozenInputs?`（:391-395）「acceptance 复验 package/version basis（AC6），Invocation intent 写入（AC7）；offer 本身不授予输入访问」。
- Offer 状态机含 `open/accepted/rejected/needs_info/counter_proposed/expired/overtaken/invalidated`；失效码 `TASK_OFFER_INVALIDATION_REASON_CODE`（:444-450）。
- Task 视图投影 `TaskOfferProjectionDto`（:455-470，刻意不含 fence 大字段）。
- 持久化：migration `apps/server-next/src/infra/sqlite/migrations/team/0080_task_offer_frozen_inputs.sql`（`frozen_inputs_json` 列）；仓储 `apps/server-next/src/application/task-coordination-repositories.ts`（offers.create/updateStatus CAS/listByTask）。
- 推送：daemon 类 agent 经 `offerTaskClaims` → `AGENT_EVENTS.taskClaim.offer`（`task-claim:offer`）emitWithAck 推送（`apps/server-next/src/transport/socket-server.ts:1033-1050`）；web 侧经 Task DAG/详情投影 `offers` 字段（`packages/contracts/src/task-coordination.ts:146-147`）。

### 3. Acceptance → claim（同事务）

`apps/server-next/src/application/management/task-claim-broker.ts` `respondToOffer`（:1030+）：

- 入口 wiring：`apps/server-next/src/transport/socket-server.ts:976-977`（agent 命名空间 `task-claim:respond` → broker.respondToOffer）。
- 前置：offer 存在且属于该 agent（:1032-1035）；`computeOfferValidity`（TTL/manifest/task 漂移）；stage-auto offer 额外 `projectStageAutoOfferStillCurrent`（:1038-1052，见 stale-basis-fail-closed.md）。
- 非 accepted 响应（rejected/needs_info/counter_proposed）：CAS open→终态，不产 Lease（:1055-1073）。
- accepted 路径：
  - Requirement-confirmation Offer 需 attestation（:1079-1106，#947 PR2，fail-closed 直到 attestation ⊇ required 且硬门槛通过）；
  - `withTaskLock` 串行化后在 `taskCoordinationUnitOfWork` 事务内二次复验（:1148-1201）：
    - **task.revision === offer.taskRevision && coordination.attempt === offer.taskAttempt && status ∈ {todo,in_progress}**，否则 `TASK_CLAIM_OFFER_STALE` 回滚（:1151-1154）——「不留 accepted 无 claim」；
    - **frozen inputs 复验**（:1159-1201）：频道未归档（否则 `TASK_CLAIM_CHANNEL_ARCHIVED`）、每个冻结版本仍存在且 collection 归属不变（否则 `TASK_CLAIM_FROZEN_INPUT_STALE`）、isFinal/reviewState 快照与当前一致（否则 `TASK_CLAIM_FROZEN_BASIS_CHANGED`）——**review/final basis 变化即 fail closed，不建部分 claim/grant**；
    - stage-auto fence 事务内再查（:1202-1205）；
  - `evaluateOfferAcceptance`（domain）裁决 claim_granted/overtaken/not_accepted（:1210-1238）；
  - **CAS offer open→accepted 与 lease 落库同事务**（:1240-1249），任一失败整体回滚（AC#4）。
- 冲突类型 `TaskClaimConflict`（:1639-1646）。

### 4. Invocation 绑定冻结版本

`apps/server-next/src/application/management/invocation-gateway.ts`：

- `invokeTaskAgent`（:89+）：创建时 `resolveClaimFrozenInputs`（:776-791——取该 claim 对应 accepted offer 的 frozenInputs 原样继承）→ 写入 `AgentInvocationIntentV1.frozenInputs`（:145-177）。
- intent 还含 `taskContext{taskId, taskRevision, taskAttempt, claimLeaseId}`（:161-167）、`projectStageInputFence`（:171-176）；`intentHash = hashIntent(intent)`（:187）——frozenInputs 属于 immutable intent 与 intentHash，执行期间不重解析 current/final。
- 创建前置 `assertProjectStageExecutionAllowed`（:192）与幂等 replay 校验 `assertTaskInvocationReplay`（:129）。
- 合同：`packages/contracts/src/invocation.ts` `AgentInvocationIntentV1.frozenInputs`（:53-57）、`AgentInvocationTaskContextV1`（:30-36）。
- 冻结输入 DTO：`packages/contracts/src/frozen-project-input.ts`（全文 27 行，FrozenProjectInputItemDto 含 isFinal/reviewState basis 快照）。

### 5. 既有命令/事件名汇总

| 名称 | 位置 | 说明 |
|---|---|---|
| `message:send` | socket.ts message 段 | 携带 threadId + selections + mentions |
| `project:resolve-references` | socket.ts:229 | 发送前只读预览冻结结果 |
| `task-claim:offer` / `task-claim:respond` / `task-claim:acquire/renew/release/expired/relinquish` | socket.ts:429-435 | AGENT 命名空间 |
| `task:list/dag/...` + `tasks:snapshot` / `task:updated` | socket.ts:287-306 | WEB Task 投影 |
| `submit-package-review-and-reject-delivery` 等 | socket.ts:253-257 | review 命令（见 package-review 文件） |

### 测试

- `apps/server-next/tests/task-linked-request-offer.test.ts`——#1064 主 seam，memory+SQLite 双后端；覆盖复验通过发 Offer、authority/eligibility/归档 fail closed、clientMessageId replay 不重发、REVIEW_BASIS_BLOCKED 与显式放行。
- `apps/server-next/tests/task-claim-broker.test.ts`——acceptance/claim 状态机。
- `apps/server-next/tests/task-offers-persistence.test.ts`——offer 持久化（含 frozen_inputs）。

## Caveats / Not Found

- #1064 现有顺序是「消息落库 → 事务外发 Offer」，**Offer 发布在消息提交之后**。#1178 要求「发送前不得创建 Message/Offer/claim/Invocation」，与现顺序不同——现成可复用的是事务内只读复验（evaluateTaskLinkedRequestContext）与只读预览（resolveAndFreezeSelections），落库顺序需新设计。
- Offer TTL 只有 15s（task-linked-request-handler.ts:159），「交给智能体处理」类场景若 agent 响应慢会 expired；这是既有常量。

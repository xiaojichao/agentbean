# #1065 贯通 Chat、Task 与 Files 的一致项目交付视图 — 实现计划

- Issue: [#1065](https://github.com/xiaojichao/agentbean/issues/1065)
- 父规格: #1059（§10 一致项目交付视图、§11 失败/并发/审计）
- 前置已合: #1060（OutputPackage）、#1061（review/finalization/availableActions）、#1062（revision/conflict 闭环）、#1063（ProjectReferenceSet 选择冻结）、#1064（Task→Thread 预填与 frozen input Offer）
- 日期: 2026-08-04

## 1. 规格要点（13 个 AC 浓缩）

1. Chat/Thread 文件包卡片展示稳定 package identity、来源 Agent/Task/attempt/Invocation/WorkspaceRun、delivered/current/final 状态、成员短标识、版本、review 状态与结构化阻断原因（AC1）。
2. Chat/Thread 提供预览、单选、多选、整包引用、基于此修改、**打开审核 Task**、**继续 @Agent** 入口，全部提交既有具名 command 或导航（AC2）。
3. Task 展示 ProjectStage 目标、依赖、acceptance contract、当前责任焦点、当前 delivery/package、required review coverage、合法 availableActions、完整活动时间线（AC3）。
4. Task 卡片只显示当前责任焦点；详情保留 Offer→acceptance→claim→execution start→delivery→人工修改→review/final→Agent 交接的可审计执行链（AC4）。
5. Files 明确区分 OutputPackage 与 ProjectArtifactCollection，展示 versions/current/final/reviews/finalizations/**package membership**/history/provenance（AC5）。
6. 任一 surface 完成保存/审核/验收/finalization/引用/交接后，其余 surfaces 经新 Server projection 显示同一 identity、revision、结果（AC6）。
7. Query 使用版本化 runtime schema、audience scope、asOf watermark、opaque cursor、consistency token；投影未追上最低 token 显示 not_ready，不以旧数据伪装成功（AC7）。
8. 重连、分页、并发请求按 Server revision/consistency basis 去重排序，旧响应不覆盖新状态（AC8）。
9. availableActions 只是可发现性投影；客户端不根据角色/按钮可见性/本地缓存推导 authority，command 提交时完整复验（AC9）。
10. 客户端不乐观推进 TaskStatus/review/final；applied/replayed、freshness_hold、conflict、rejected、temporarily unavailable、outcome unknown 均有一致可恢复反馈（AC10）。
11. current/final/delivered/approved/changes_requested/rejected/缺失项/不可用原因都有文本标签，不只依赖颜色/图标/悬停（AC11）。
12. 文件选择、审核、预填、冲突处理支持键盘、清晰焦点顺序、选择计数、取消与焦点恢复；窄屏/宽度变化不改变 command 与业务语义（AC12）。
13. Web 贯穿测试：文件包出现→Task 审核/修改→Files 版本核对→消息引用→下游 Agent handoff，以及 final 缺失、不可用 current、Markdown conflict、stale response（AC13）。

## 2. 现状（已具备，直接复用）

| 能力 | 位置 |
|---|---|
| OutputPackage 详情+投影四策略+availableActions（Server 计算）+ list 聚合 reviewState | `apps/server-next/src/application/usecases.ts` getOutputPackage @8962 / listOutputPackages @8891 / computePackageMemberAvailableActions @16055 / computeOutputPackageProjection @15928；契约 `packages/contracts/src/output-package.ts` |
| consistency 机制（ConsistencyTokenV1、asOf、audienceScope、opaque cursor、not_ready、projection_not_ready） | `packages/contracts/src/system-activity.ts`；`ensureConsistency` `apps/server-next/src/application/system-activity-handler.ts` @318；`checkMinimumConsistency` `packages/domain/src/system-activity-policy.ts` @480；通用 `system_activity_watermarks` 表（stream_kind/stream_id/revision，migration 0072） |
| Task 阶段详情（ProjectStageDto：目标/依赖/aggregateStatus/blockingReasons/executionAllowed/stableInputs） | `getChannelProjectOverview` → `buildChannelProjectOverview`（usecases.ts @7609）；契约 `packages/contracts/src/project.ts` @90-178 |
| review/finalization basis（humanAcceptanceAuthorityIds、reviewPolicy、requiredForFinal） | `task-coordination-kernel.ts` @238/328；migration 0078；`package-review-policy.ts` |
| Task 协调数据（offer/claim/lease/executionStarted/attempt/revision、invocation intent） | `apps/server-next/src/application/management/task-claim-broker.ts`、`task-coordination-repositories.ts`、`invocation-gateway.ts` |
| Artifact library（versions/current/final/reviews/finalizations/source/revisionBasis/lineage） | `buildProjectArtifactLibrary`（usecases.ts @15710）；`project:artifact-collections` socket @500 |
| Chat 卡片（identity/来源/review 状态/阻断原因/引用/单选多选/基于此修改/审核动作） | `apps/web-next/components/OutputPackageCard.tsx`（449 行）；chat/page.tsx @5046 |
| Task→Thread 预填 compose（delegate 导航、chips、失败保留草稿） | `apps/web-next/app/[teamPath]/tasks/page.tsx` @1127/300；chat/page.tsx @1381；`task-delegate-prefill.test.ts` |
| Files artifacts 视图（OutputPackageList + ProjectArtifactLibrary 并列） | chat/page.tsx @2440；`components/project/OutputPackageList.tsx`、`components/ProjectArtifactLibrary.tsx` |
| socket 事件清单断言（新增事件必同步） | `apps/server-next/tests/socket-handlers.test.ts`；契约 `packages/contracts/src/socket.ts` |

## 3. 缺口（#1065 要建）

1. **output-package query 的 minimumConsistency 未接线**：契约接受（output-package.ts @885-897）、usecases 不校验 → AC7 缺口。
2. **Task 无聚合投影**：TaskDto 无 stage/acceptance/focus/delivery/review coverage/availableActions/时间线；卡片（system-activity query-thread-task-card）与详情（ProjectStage）分属两个投影，无单一消费源 → AC3/AC4。
3. **Files 缺 package membership**：artifact library 响应无「某版本属于哪个 package」→ AC5。
4. **Chat 卡片缺「打开审核 Task」「继续 @Agent」** → AC2。
5. **Task 页缺 stage 目标/依赖/acceptance contract/责任焦点/review coverage/availableActions/时间线展示**（现只有 package 摘要列表）→ AC3/AC4。
6. **三处共享标签重复定义**（POLICY_LABELS/REVIEW_STATE_LABELS 各组件各自实现）→ AC11。
7. **无贯穿测试**（13 个 surface 联动场景）→ AC13。

## 4. 设计决策

- **D1 一致性接线（AC7）**：把 system-activity 的 `ensureConsistency` 模式搬到 output-package query（getOutputPackage / listOutputPackages）：query 带 `minimumConsistency` 时对照 watermark，落后返回 `projection_not_ready` + notReadyStreams。写路径（package 形成、review/finalize/reject-delivery/revise-version 任一 command 成功）后 upsert watermark：stream_kind=`output-package`、stream_id=channelId、revision=自增（复用 `SystemActivityRepositories.watermarks` 通用表，不再建表）。
- **D2 Task 聚合投影（AC3/AC4）**：新增 socket 查询事件 `query-task-delivery-overview`（requireAuthenticatedUser），返回 `TaskDeliveryOverviewV1`：schemaVersion/asOf/audienceScope/consistencyToken + task（TaskDto）+ stage（ProjectStageDto 若有绑定）+ acceptanceContract（humanAcceptanceAuthorityIds/reviewPolicy/requiredReviewCoverage/requiresHumanAcceptance）+ responsibilityFocus（Server 从 offer/claim/executionStarted 推导：`offer_wait`/`claim_active`/`execution_active`/`review_wait`/`none`）+ delivery（该 task 的 packages 摘要 + 焦点 packageId）+ availableActions（Server 计算 Task 级动作：仅数据源，不授予）+ timeline（offer 发布/acceptance/claim/execution start/delivery/人工修改/review/final/交接 事件链，append-only）。Task 卡片视图继续只显示 focus（现有 query-thread-task-card 不动）；详情消费新投影。
- **D3 Files package membership（AC5）**：`project:artifact-collections` 响应中每个 version 加 `packageMemberships: PackageMembershipRefDto[]`（{packageId, sequence, shortLabel, deliveredAt}），Server 在 buildProjectArtifactLibrary 内按 collectionId 反查该 channel packages 一次关联（同一 `listOutputPackages` 数据源，不新增表）。
- **D4 Chat 卡片入口（AC2）**：
  - 「打开审核 Task」：卡片头部加链接，导航到 `/{teamPath}/{channelId}?thread={channelId}:{rootId}` 的 Task 面板（chat 页 TaskDetailPanel 已有）或 tasks 页；取 meta.taskId → tasks 页若带 `?task=` 参数则聚焦该 Task 的 TaskThreadPanel，否则本页打开 TaskDetailPanel。选轻实现：本页 TaskDetailPanel（已有 3801-4034 行，含审核动作区），卡片按钮触发打开。
  - 「继续 @Agent」：复用 #1064 compose 预填通道——生成本地 compose state（text 模板 + selections `[{kind:'package_projection', packageId, policy:'delivered'}]`），聚焦 composer；不发送不创建任何事实（AC10 语义同 #1064）。
- **D5 Web Task 页详情（AC3/AC4）**：TaskThreadPanel 新增「交付视图」区（或独立 `TaskDeliveryOverview` 组件），消费 `query-task-delivery-overview`：stage 目标/依赖、acceptance contract 文本、责任焦点 badge（只读）、availableActions 按钮（来自 Server 动作清单，点击仍走既有 command 且 Server 复验）、时间线列表。卡片视图不加字段。
- **D6 共享标签（AC11）**：新 `apps/web-next/lib/delivery-labels.ts` 导出 POLICY_LABELS / REVIEW_STATE_LABELS / FOCUS_LABELS 等常量 + 文本映射，OutputPackageCard / OutputPackageList / ProjectArtifactLibrary / 新 Task 组件统一消费；颜色仅作修饰。
- **D7 并发/重连去重（AC8）**：检查 store 对 listOutputPackages/artifactCollections 快照的 apply 是否按响应顺序/consistencyToken 丢弃旧响应；若缺，在 socket 查询封装（lib/socket.ts emitWithTimeout）加 responseVersion 单调递增守卫：仅在 token≥当前已应用版本时应用。不做 TaskStatus 乐观更新改造（现状已回滚式），review/final 保持提交后 refresh()。
- **D8 贯穿测试（AC13）**：web-next 新 `tests/unified-delivery-journey.test.tsx`（node 源码扫描 + jsdom RTL）：①文件包出现→卡片渲染 identity/来源/状态 ②Task 审核/修改→Files 版本核对（同一 revision 显示）③消息引用（referenceSet chips）④下游 Agent handoff（delegate 预填）⑤final 缺失（blockers）⑥不可用 current（not_ready）⑦Markdown conflict（#1062 文案）⑧stale response（D7 守卫）。server-next 补 `task-delivery-overview.test.ts`（memory/sqlite 双后端）。

## 5. 切片与改动清单

### Slice 1: Server consistency 接线（AC7/AC8 Server 侧）

- `apps/server-next/src/application/package-review-repositories.ts` 或 usecases 写路径：package 相关 command 成功后 `watermarks.upsert({streamKind:'output-package', streamId:channelId, revision:++})`。
- usecases.ts getOutputPackage/listOutputPackages：开头加 `ensureConsistency` 等效检查（复用 domain `checkMinimumConsistency` + 现有 watermarks 仓储），不满足返回 outcome `projection_not_ready` + stableCode + notReadyStreams。
- 契约：output-package query 输出加 outcome 字段（若现无）。
- 测试：`apps/server-next/tests/output-package-consistency.test.ts`（双后端：minimumConsistency 满足→正常；落后→projection_not_ready；command 后 watermark 推进）。

### Slice 2: Server Task 聚合投影（AC3/AC4）

- `packages/contracts/src/task-delivery-overview.ts`（新）：TaskDeliveryOverviewV1、TaskResponsibilityFocusV1、TaskAcceptanceContractV1、TaskTimelineEventV1、TaskLevelAvailableActionDto。
- contracts index.ts 导出 + socket.ts WEB_EVENTS 加 `query-task-delivery-overview`。
- `apps/server-next/src/application/task-delivery-overview-handler.ts`（新）：装配 task/coordination/stage/packages/activity 数据，投影 focus、availableActions、timeline；输出 asOf/audienceScope/consistencyToken + minimumConsistency 检查（同 D1）。
- socket-handlers.ts bind + socket-handlers.test.ts 事件清单同步。
- 测试：`apps/server-next/tests/task-delivery-overview.test.ts`（双后端：focus 状态机各态、availableActions 与 authority 一致、timeline 顺序、projection_not_ready）。

### Slice 3: Server Files membership（AC5）

- 契约 project.ts：ProjectArtifactVersionDto 加 `packageMemberships`；新 PackageMembershipRefDto。
- usecases.ts buildProjectArtifactLibrary：一次 listOutputPackages 数据，按 collectionId 关联反填。
- 测试：现有 artifact library 测试扩展（`project-artifact-promotion.test.ts` 或新用例）。

### Slice 4: Web Chat 卡片入口 + Task 页详情（AC2/AC3/AC4）

- `components/OutputPackageCard.tsx`：头部加「打开审核 Task」（meta.taskId 存在时，导航/打开 TaskDetailPanel）、底部加「继续 @Agent」（compose 预填，复用 #1064 通道；无 taskId 时禁用并给文本原因）。
- chat/page.tsx：接卡片导航回调 + compose 预填处理（已存在 #1064 通道，扩展 selections 来源）。
- `tasks/page.tsx`：TaskThreadPanel 加 `TaskDeliveryOverview` 组件（focus badge、acceptance contract 文本、availableActions 按钮、timeline 列表、stage 目标/依赖）。
- 测试：`apps/web-next/tests/output-package-card-entry.test.tsx`（RTL：按钮存在、点击导航/compose 预填正确、无发送动作）。

### Slice 5: Web Files membership + 共享标签 + 键盘（AC5/AC11/AC12）

- `lib/delivery-labels.ts`（新）+ 三处组件替换为共享标签。
- `components/ProjectArtifactLibrary.tsx`：版本行渲染 packageMemberships 标签。
- 键盘/焦点审查：selection checkbox、取消按钮、焦点恢复（现有实现核对+补不足）；窄屏不改变语义（检查 chips 布局）。
- 测试：`tests/artifact-library-package-membership.test.tsx` + 标签断言。

### Slice 6: 贯穿测试与收尾（AC13/AC6/AC8/AC10）

- `tests/unified-delivery-journey.test.tsx`（D8 场景 ①-⑧）。
- AC6 验证：server 集成（review 后 getOutputPackage 与 artifact library 同一 revision）+ web 端刷新路径（project:updated/onArtifactsUpdated 已存在，测试断言消费）。
- 全量 test:ci + tsc（server-next/domain/contracts/web-next）+ 组合态。

## 6. 验证

- 每个 slice：单包 vitest（cd 进包目录）+ 相关单测。
- 最后：`test:ci` 全量 + `next build`（web-next tsc）。
- /code-review 自审后提交、开 PR（PR body 含 Closes #1065）。

## 7. 审查修复与取舍（2026-08-04 code-review 后）

- **P0**：formation 幂等重入(replayed)不推进 watermark——revision 虚增会让旧 token 误报
  PROJECTION_NOT_READY；仅 `created` 推进 + 重入测试。
- **P1**：「审核交付包」动作从死按钮变为导航(→ 频道 Files 视图 `?chatTab=files`)；
  「继续 @Agent」无 taskId 时禁用并给文本原因。
- **P1**：`TaskAcceptanceContractV1` 补 `requiredReviewCoverage`（焦点包 requiredForFinal
  成员 vs 已 final，Server 投影，complete 标记），web 展示文本。
- **Standards**：删死代码（`reject_delivery` 时间线枚举/标签、零调用的
  FOCUS_LABELS/focusLabel/policyLabel）；streamKind 提共享常量；
  TaskDto 提取共享 mapper（与 ProjectStage 投影共用，防漂移）。
- **取舍（AC4 卡片 focus）**：Tasks 页 board 紧凑卡片不逐卡查询 overview（N+1 查询成本），
  焦点通过 TaskDeliveryOverview 首屏区块（详情打开即见）实现；board 卡片 focus 留
  follow-up。#1065 的「Task 卡片只显示当前责任焦点」以详情面板首屏满足。
- **取舍（AC8 完整守卫）**：socket 查询层未加全局 responseVersion 守卫（改动面覆盖全部
  查询调用方）；组件级 cancelled/alive（最新请求胜出）+ 推送按 id 合并已实质满足
  「旧响应不覆盖新状态」，以测试固化。

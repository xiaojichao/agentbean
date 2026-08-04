# #1066 归档 Channel 并收口撤权、恢复与只读历史 — 实现计划

- Issue: [#1066](https://github.com/xiaojichao/agentbean/issues/1066)
- 父规格: #1059（§11 失败、并发、审计和归档）
- 前置已合: #721（archive gate 基础两段式）、#1060（OutputPackage + pendingDeliveries + 幂等 receipt）、#1061（review/finalization 分离）、#1062（revision/conflict）、#1063（ProjectReferenceSet）、#1064（frozen Offer）、#1065（统一交付视图 + consistency token + task:delivery-overview）
- 日期: 2026-08-04

## 1. 规格要点（13 个 AC 浓缩）

1. Archive gate 在提交前列出并复验**全部**非终态工作：Task、Invocation、execution claim、lease、Offer、**待审核 delivery**、**尚未收敛的 package projection**（AC1）。
2. Server 持有 archive gate、publish fencing 与 reconciliation authority；归档提交与并发新 publish/delivery command 经 Channel revision 线性化；**已被 Server 接受的 staging/delivery 必须先收敛为 committed+projected，或进入明确的 terminal cancellation/recovery pending**，Device 不能自行宣布已收口（AC2）。
3. 存在活动工作时，归档要求有权人类按既有 termination/closeout 合同明确处理；客户端隐藏页面或静默取消不能完成归档（AC3）。
4. 归档事务完成后，Markdown 保存、ArtifactReview、Task acceptance、finalization、Message/ProjectReferenceSet、Offer、claim、Invocation 全部返回结构化 rejected/conflict，且**无部分副作用**（AC4）。
5. 归档后 Chat/Task/Files 保留 OutputPackage、collection/version、review、finalization、Task timeline、delivery、provenance 的 audience-scoped **只读投影**（AC5）。
6. 只读 UI 明确标记已归档、哪些动作不可用及原因；不把 unavailable controls 当权限证明；不删历史版本/活动（AC6）。
7. 用户被移出 Channel、Agent membership/visibility/exposure 撤销或 Artifact visibility 收紧后，query/preview/send/Offer accept/Invocation 立即按当前 authority fail closed（AC7）。
8. 权限变化使旧 opaque cursor、reference basis token、eligibility basis 与跨 audience 缓存失效；不依赖客户端已取得数据继续授权（AC8）。
9. 来源 Message 删除、成员撤权、Agent exposure 变化或 final 指针更新**不静默改写**既有 package、ProjectReferenceSet、delivery、review、finalization 或 audit provenance（AC9）。
10. Publish 已 commit 但 package projection 暂不可用时，保留 Workspace revision、receipt 与 reconciliation 事实；UI 显示「交付处理中/需要恢复」，不显示完整 package、不推进 review（AC10）。
11. Reconciliation、outbox 重放、断连、response 丢失用原幂等 identity 收敛到同一 receipt；不同 payload 用旧 key 返回 conflict，不重复 package/Task transition/外部效果（AC11）。
12. Event/package/version/review/finalization/reference set/delivery/**archive**/Invocation audit 保留稳定 identity、actor/initiator、authority basis、causation/source reference、revision、outcome、时间（AC12）。
13. Server memory/SQLite 测试覆盖 archive gate、归档后 fail-closed、权限撤销、旧 cursor/basis 失效、reconciliation、replay；Web 测试覆盖归档前确认、归档后只读历史、文本状态、不可用动作反馈（AC13）。

## 2. 现状（已具备，直接复用）

| 能力 | 位置 |
|---|---|
| archiveChannel 两段式（preflight token + confirm 事务内复验 channel revision，同事务 close Task/release lease/invalidate Offer/cancel dispatch + 写 archivedAt） | `apps/server-next/src/application/usecases.ts` @4977-5122 |
| collectArchiveWorks（tasks/invocations/claims/leases/offers/pendingReviews=task in_review） | usecases.ts @14479-14522 |
| archive 纯函数（token 签发/校验、preflight/confirmation 求值） | `packages/domain/src/channel-archive-policy.ts` |
| fail-closed 广覆盖：sendMessage、saveChannelDocument、artifact mutation（@7722/8161/8491/8742/9127）、publish staging begin/commit、package-review-handler:134、output-package-handler:148、promotion-gate:211、invocation-gateway:547、collaboration-service:64/467、task-claim-broker:1162 | 各 handler + usecases |
| pendingDeliveries 差集（committed 有 provenance 未成 package）+ consistency token/watermark + not_ready/projection_not_ready | `output-package-repositories.ts` @175；usecases @8964/16086；`packages/contracts/src/system-activity.ts` |
| 幂等 receipt/tombstone（exact-key replay、hash conflict） | #1060（output-package-repositories receipts/tombstones） |
| web 归档流程（preflight 清单 → 确认 token → archived badge + channel_archived 文案） | `components/ChannelProjectOverview.tsx` @99/468/678；chat/page.tsx @1240/2767-2914 |
| chat 归档后 readOnly（readOnly + readOnlyReason） | chat/page.tsx @929-936 |
| device token / membership 每次调用复验（撤权即时生效基础） | #1053/#1056（deviceActorToken 验签、逐 Agent membership/visible 复验） |

## 3. 缺口（#1066 要建）

1. **gate 不收集 package 级 pending review 与未收敛 projection**：collectArchiveWorks 只收集 task in_review；#1061 reviews 表（packageId 非空、decision pending）与 #1060 pendingDeliveries（committed 未成 package）未列入 preflight → AC1 缺口。
2. **archive 事务不处理 open/failed workspace publish staging**：begin/commit 已拒新 staging（archivedAt 检查），但存量 open/failed staging 归档后悬空（只有按过期时间的 cleanupExpiredWorkspacePublishStaging）→ AC2「terminal cancellation/recovery pending」缺口。
3. **archive 无审计记录**：confirmation 只返回 DTO，无 archive event/audit（actor/basis/revision/outcome/time）→ AC12 缺口。
4. **fail-closed / 撤权即时生效 / 旧 basis 失效无系统性测试固化**：检查点零散分布在各 handler，无表驱动枚举验证「结构化 rejected + 无部分副作用」；撤权（membership 移除/visibility 撤销/artifact visibility 收紧）后 Offer accept、Invocation、query 的即时生效无测试 → AC4/AC7/AC8/AC13。
5. **web preflight 清单不含新 work kinds；归档后 Task/Files 面的只读标记与不可用动作反馈不完整**（chat 有 readOnly，Task/Files 未验证）→ AC3/AC6。
6. **只读投影与 reconciliation/replay 无 archive 上下文测试**：归档后 Chat/Task/Files 保留历史、pendingDeliveries 保留、receipt replay 收敛、不同 payload 旧 key conflict 无覆盖 → AC5/AC10/AC11。

## 4. 设计决策

- **D1 gate 扩展（AC1）**：`collectArchiveWorks` 增加两臂——(a) package-level pending review：按 channel 查 reviews 表（packageId 非空 且 decision 为 pending 态）去重成 delivery 级；(b) pendingDeliveries：`listPackagePublishIdsByChannel` 差集（committed 有 provenance 未成 package）。preflight items 新增 kind `pending_review_delivery` / `pending_delivery`（contracts `ChannelArchiveWorkKind` union 扩展），summary 加 `pendingDeliveries` 计数。confirm 事务内用同一 collect 复验（现有模式）。
- **D2 staging terminal cancellation（AC2）**：archive confirm 事务内把频道内 open/failed staging 置为 `failed`（terminal，幂等：已 failed 跳过），并写 `archiveReason: 'channel_archived'` 保留审计事实（不删行——commit 后 pendingDeliveries 投影以 committed 为数据源，open/failed 不参与，删除与否不影响只读）。committed staging 原样保留（reconciliation/只读数据源，AC10）。Device 不能自行宣布收口——staging 状态迁移仅 Server 事务内执行。
- **D3 archive 审计（AC12）**：archive confirm 成功时写一条 audit 记录（新 `channel_archives` 表或复用现有 audit 表——查现有设施后定；字段：id/teamId/channelId/actorUserId/authorityBasis('channel_creator')/channelRevisionAtArchive/outcome('archived')/cancelledTaskIds/releasedClaimIds/invalidatedOfferIds/cancelledInvocationIds/pendingReviewTaskIds/pendingDeliveryCount/cancelledStagingCount/archivedAt）。只读历史可查询（getChannelProjectOverview 带 archiveRecord 摘要）。
- **D4 fail-closed 表驱动测试（AC4）**：枚举全部写 command（sendMessage/saveChannelDocument/artifact mutate/review/finalize/task acceptance/package publish 相关/Offer publish+respond/claim/Invocation create/reference set 发送），归档后逐条断言：结构化 rejected/conflict（稳定 reasonCode）+ 无部分副作用（快照对比：无新行/无状态推进）。
- **D5 撤权即时生效（AC7/AC8）**：测试固化——membership 移除后 query/preview/send 403；Agent visibleTeamIds 撤销后 Offer accept/claim/Invocation 拒绝；artifact visibility 收紧后 preview/读取拒绝；旧 cursor 继续请求 → 服务端 authority 复验 fail closed（不依赖 token 过期，而是每次复验）。补实现缺口（若有）。
- **D6 只读投影 + reconciliation（AC5/AC10/AC11）**：测试固化——归档后 getOutputPackage/listOutputPackages/artifact library/task:delivery-overview 全部仍可读且展示 archived 标记；pendingDeliveries 保留（UI「交付处理中」）；receipt replay 返回同一 receipt；不同 payload 旧 key → conflict 且无重复 package。
- **D7 web（AC3/AC6）**：preflight 清单渲染新 work kinds 文本；归档后 Task 详情/TaskThreadPanel 与 Files 视图只读标记 + 不可用动作禁用并给文本原因（复用 `channel_archived` 文案常量）；chat 已有 readOnly 不动。
- **D8 测试布局**：Server 新 `apps/server-next/tests/archive-gate-closeout.test.ts`（双后端 memory/sqlite）+ 现有 archive 用例扩展；Web 新 `apps/web-next/tests/archive-readonly-view.test.tsx`。

## 5. 切片与改动清单

### Slice 1: Server gate 扩展（AC1/AC2/AC3/AC12）

- `packages/contracts/src/channel.ts`：`ChannelArchiveWorkKind` 加 `'pending_review_delivery' | 'pending_delivery'`；`ChannelArchivePreflightDto.summary` 加 `pendingDeliveries: number`。
- usecases.ts `collectArchiveWorks`：加 package pending review 臂 + pendingDeliveries 臂（复用 `listPackagePublishIdsByChannel` / reviews 查询）；返回结构扩展。
- archive confirm 事务：open/failed staging → failed + archiveReason；写 archive audit 记录（若现有设施复用，否则新仓储）。
- domain `channel-archive-policy.ts`：items 组装扩 kind。
- 契约 `ChannelArchiveConfirmationDto`：加 `pendingReviewDeliveryIds` / `cancelledStagingCount`（或并入现有字段）。
- 测试：`archive-gate-closeout.test.ts`（双后端）：preflight 列出 pending review delivery + pendingDeliveries；confirm 复验；staging terminal cancellation；audit 记录存在；并发 publish（begin）在归档后被拒。

### Slice 2: Server fail-closed + 撤权收口（AC4/AC7/AC8）

- 表驱动测试：枚举全部写 command 在归档后 → 结构化 rejected + 无副作用；补实现缺口（若发现 handler 漏检）。
- 撤权即时生效测试：membership 移除 / Agent visibility 撤销 / artifact visibility 收紧 → query/preview/send/Offer accept/Invocation 立即 fail closed。
- 旧 cursor/basis 失效测试：权限变化后旧 opaque cursor / consistency token 请求 → 服务端 authority 复验拒绝或投影拒绝，不凭旧数据授权。
- 测试文件：`archive-fail-closed.test.ts`（双后端）。

### Slice 3: 只读投影 + reconciliation/replay（AC5/AC10/AC11）

- 归档后只读投影测试：Chat（messages/packages 卡片）、Task（task:delivery-overview、timeline）、Files（artifact library、pendingDeliveries）均可读且带 archived 标记；无写路径。
- reconciliation/replay 测试：receipt replay 同一 key 收敛同一 receipt；不同 payload 旧 key conflict；断连/response 丢失后重放不重复 package/Task transition。
- 实现缺口补丁（若有：如投影未展示 archived 标记）。

### Slice 4: Web（AC3/AC6）

- `ChannelProjectOverview.tsx` / chat/page.tsx 归档确认对话框：渲染 `pending_review_delivery` / `pending_delivery` items 文本。
- Task 详情与 Files 视图：归档频道只读标记（badge）+ 不可用动作禁用 + 文本原因（复用 `channel_archived`）。
- 共享文案常量（如 `lib/delivery-labels.ts` 扩展或 `lib/archive-labels.ts`）。

### Slice 5: Web 测试（AC13）

- `apps/web-next/tests/archive-readonly-view.test.tsx`：归档确认清单（含新 kinds）→ 确认 → 已归档标记；归档后动作不可用反馈文本；只读历史可见。

### Slice 6: 收尾

- 全量 `test:ci` + tsc（server-next/domain/contracts/web-next）+ 组合态检查；/code-review；提交、开 PR（PR body 含 Closes #1066）。

## 6. 验证

- 每个 slice：单包 vitest（cd 进包目录跑，避免根目录扫 .worktrees）+ 相关单测。
- 最后：`test:ci` 全量 + web-next tsc（next build）。
- /code-review 自审后提交、开 PR。

## 7. 审查修复与取舍（2026-08-04 code-review 后）

- **P1（Spec）**：`pending_review_delivery` 过滤原为 `reviewState !== 'approved'`——把终态
  rejected/changes_requested（永不收敛）也列入 gate，归档清单会永久残留；修为
  `=== 'pending'`（仅待审核列出）+ 新增「rejected 终态不进 gate」测试。
- **P1（Spec）**：AC4 测试的 document 用例原走 NOT_FOUND（document 不存在）；改为归档前真实保存
  成功（markdownEditing 开启时）→ 归档后断言 FORBIDDEN 命中 archivedAt 检查；AC3 测试原直插
  repo channels.update，改走真实 updateChannel 命令验证 revision 线性化。
- **P2（Standards）**：migration 0081 补 `REFERENCES channels(id) ON DELETE CASCADE`（与投影表
  FK CASCADE 惯例一致，频道硬删时审计一并收口）。
- **P3（Standards）**：循环 import 内联改动验证为不必要（tsc 在顶层 import 下同样通过），还原
  顶层 import 保持 style 一致。
- **P3**：pending 两 kind 的合成 title（`package <id>` 前缀）与 label 重复，去掉（web 回退 id）。
- **取舍（AC4/AC7 覆盖面）**：fail-closed 表驱动以代表 command（消息/Markdown 保存/审核/publish
  staging）覆盖 + Task 零推进断言；Offer/claim/Invocation 路径的 archived 检查已存在于
  task-claim-broker:1162 / invocation-gateway:547 / collaboration-service:64，未逐条建
  usecase 级 fixture（构造成本高）；Agent 撤权后 deliver fail-fast 由 #1060 formation 测试
  已覆盖（agent-authority-revoked）。AC13 Web 侧以 archive-labels 单测 + ChannelProjectOverview
  archived 渲染测试（既有）覆盖；tasks 页页面级禁用逻辑未建组件测试（页面 mock 成本高，与
  #1065 board 卡片 focus 取舍同款）。

## 8. 风险与取舍

- **gate 扩展面**：reviews 表 pending 判定与 task in_review 有交集可能（同 delivery 双计）——preflight 去重按 delivery/packageId 归并；confirm 只处理 task 级（reviews 是只读历史，归档不删除）。
- **staging 处理**：open staging 可能正在上传（daemon 活跃 publish 中）——archive 是显式有权人动作，置 failed 后 daemon 后续 put/commit 会因 NOT_FOUND/status 校验失败，天然 fail closed；不断言 daemon 具体错误文案。
- **audit 表选择**：优先复用现有 audit/provenance 设施（#1044/#1060 的 provenance 字段在 package/version 上）；archive 自身记录独立行（channels 表加 archive 审计列 vs 新表，实现时按现有 migration 惯例定）。
- **撤权测试范围**：不在本切片改 device token 架构（#1053/#1056 已合），只补「即时生效」的验证测试与缺失 handler 检查。
- **web 改动面**：Task/Files 只读标记最小侵入——复用 chat 已用 readOnly 模式；不重构布局。

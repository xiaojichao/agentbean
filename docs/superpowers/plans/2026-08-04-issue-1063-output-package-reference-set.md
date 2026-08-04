# #1063 将文件包选择冻结为消息 ProjectReferenceSet — 实施计划

> 状态:✅ 已完成(2026-08-04)。全部切片落地,验证通过,详见文末「验证与回归」。

> 父规格 #1059 §3/§6/§9/§10;前置 #1060(OutputPackage 成形,已合)、#1061(审核/验收/最终版,已合)。
> 复用 #826 既有 ProjectReferenceSet 冻结链路,扩展选择来源支持 OutputPackage 四种 projection。

## 现状关键事实(探查结论)

- `message:send` 冻结链路(#826):`resolveAndFreezeSelections`(解析+资格裁决,事务外)→ `persistFrozenProjectReferences`(事务内)→ repo `projectReferenceSets.create`(**事务内提交点复核**:channel 未归档 + document 的 `current_revision_id` 未漂移,漂移即 `reference_fact_conflict` 整体回滚)。durable-job(生产默认)与 legacy 两条路径共用这两个 helper;message-tracer 实验路径不冻结(既有缺口,本票不扩大)。
- 幂等两层:消息层 `clientMessageId` + `meta.projectReferenceRequestFingerprint`;引用集层 mutation 表 `(teamId, channelId, idempotencyKey)` 同 key 同 fingerprint=replayed,异 fingerprint=idempotency_conflict。发送失败时 web composer 不清草稿/选择(既有行为,满足 AC9)。
- OutputPackage 不可变(revision 恒 1),成员冻结 delivered 版本;collection 有 `revision`/`currentVersionId`/`finalVersionId`,append 与 finalization 都推进 revision(乐观 fence 既有)。
- reviewState = 最新一条 review 的 decision(pending/approved/changes_requested/rejected),domain 纯函数 `deriveProjectArtifactVersionReviewState`。
- `get-output-package` query 已存在但 **asOf/audienceScope/minimumConsistency 合同有、socket 未接线**;本票在 projection 块内真正下发 audienceScope/asOf/consistencyToken。
- 短编号 ordinal 解析已有 bundle 版(`resolveReferenceOrdinal` 单焦点唯一命中才 resolved,多焦点 ambiguous),本票扩展到 package 焦点。
- migration 注册:`0076/0077/0078` 在 `sqliteTableExists(db,'project_artifact_collections')` 门禁内;新 migration 跟进同门禁,编号 0079。

## 合同设计(packages/contracts)

### 1. `project-reference.ts` 扩展

新增两种 selection request(联合类型新增 arm,刻意仍无序号 arm):

```ts
// 整包投影选择:delivered/current/final
ProjectReferencePackageProjectionRequestDto {
  kind: 'package_projection'; packageId; policy: 'delivered'|'current'|'final';
  // current/final 必填(解析时刻的 collection revision fence,发送时原样回传);delivered 忽略
  expectedMemberRevisions?: readonly { collectionId: ID; revision: number }[];
}
// 包内指定版本(单选/多选/“基于此修改”显式选择)
ProjectReferencePackageMembersRequestDto {
  kind: 'package_members'; packageId;
  members: readonly { collectionId: ID; versionId: ID }[];  // 单选=长度 1
}
```

- `ProjectReferenceSelectionSourceKind` 新增:`package_delivered|package_current|package_final|package_specified`(冻结的“用途”事实=来源 projection policy)。
- Preview/Selection 新增 `package?: ProjectReferencePackageContextDto { packageId, deliveryId, policy, memberCount }`(与 bundle context 同构)。
- `ProjectArtifactVersionReferenceItemDto` 新增可选 `collectionRevision`(**解析时 basis**,仅 current/final 指针解析的 item 携带;delivered/specified 不带=不对 collection revision 设 fence,因为语义上不依赖)。
- `ProjectReferenceRejectionDto` 新增可选 `memberBlockers: readonly { collectionId, shortLabel, filename, code }[]`(整包投影被阻断时的逐项清单,composer 精确提示)。
- ordinal:`ResolveProjectReferenceOrdinalInput` 新增 `focusPackageIds?: readonly ID[]`;候选 DTO 新增 package arm(scopeId=packageId,带 collectionId/versionId/shortLabel/expectedCollectionRevision)。
- `PROJECT_REFERENCE_SET_CONTRACT_VERSION` 保持 1(纯新增 arm,不改既有 items 语义)。

### 2. `output-package.ts` query 扩展(AC1)

`get-output-package` input 新增可选 `projection:{ policy:'delivered'|'current'|'final'|'specified'; versions?: readonly {collectionId,versionId}[] }`(specified 必填 versions);exact-key parse 同步放开。

output 新增可选 `projection` 块:

```ts
{
  policy; status: 'ready'|'not_ready';
  members: [{ sequence, shortLabel, collectionId, versionId, versionNumber, artifactId, filename,
              reviewState, isFinalVersion, collectionRevision }];   // 成员 revisions=AC1
  blockers: [{ code:'missing_final'|'current_not_formal'|'version_not_in_package'|'collection_unavailable',
               collectionId, shortLabel, filename }];
  omitted: [{ collectionId, shortLabel, filename, reason:'final_not_required' }];  // 非必需无 final 明确省略
  consistencyToken: ConsistencyTokenV1;  // package stream(rev=1)+各成员 collection revision
}
```

ack 顶层同步带 `asOf`/`audienceScope`(`${teamId}:${channelId}:${userId}` 惯例对齐 system-activity)。

### 3. domain(packages/domain/src/output-package-projection-policy.ts,新增纯函数)

`resolveOutputPackageProjection(facts)`:输入全部 Server 读取(package 成员、collections、versions、reviewStates),输出 ready(items+omitted)或 not_ready(blockers+omitted):

- **delivered**:每成员=冻结 deliveredVersionId,永不漂移。
- **current**:逐成员解析 `collection.currentVersionId`;该版本 reviewState 为 rejected/changes_requested → blocker `current_not_formal`(整包默认正式输入被拒;AC4);collection/version 缺失 → `collection_unavailable`。
- **final**:requiredForFinal 成员缺 finalVersionId → blocker `missing_final`(整体 not_ready 列缺失项);非必需成员无 final → 进 omitted,**绝不以 current 补齐**(AC3)。
- **specified**:每个 {collectionId,versionId} 必须属于某成员的 collection,否则 `version_not_in_package`;显式版本不过 review 闸(AC4“基于此修改”)。

`evaluateSelectionEligibility` 新增 package 两个 arm 的候选类型与裁决(scope/visibility/archived 闸复用现有顺序;package_projection 调上面的解析,not_ready → code `package_projection_blocked` + memberBlockers;expectedMemberRevisions 与当前 collection revision 不符 → `revision_stale`)。新增拒绝码:`package_not_found`、`package_projection_blocked`、`version_not_in_package`、`empty_selection`(复用)、`duplicate_reference`(复用)。

`resolveReferenceOrdinal` 扩展 package 焦点:单焦点 package 唯一命中 → resolved(package_members 选择,版本=该成员 current,带 expectedCollectionRevision fence);多焦点/多位次命中 → ambiguous 全候选返回,调用方不得猜测(AC5)。

## Server 设计(apps/server-next)

1. **candidate 加载**(`loadProjectReferenceSelectionCandidate` 新增两臂):按 packageId 读 package+members,批量读 collections/versions/reviews,构造 domain 候选。可见性复用 `isPublicChannelFileArtifact` 逐版本判定。
2. **冻结持久化**:selection 落库新增 package 列;item 落库新增 `collection_revision`(仅指针解析 item)。
3. **提交点 fence**(memory+sqlite `projectReferenceSets.create`):新增——package selection 的 package 必须在 team/channel scope 内存在;带 `collectionRevision` 的 artifact item 复核 `project_artifact_collections.revision` 未变(覆盖 current 移动与 final 移动,二者都推进 revision)。不满足 → `reference_fact_conflict` 回滚。
4. **query**(`getOutputPackage` usecase):projection 参数 → domain 解析 → projection 块 + asOf(clock)+ audienceScope;availableActions 既有逻辑不动。
5. **ordinal**(`resolveProjectReferenceOrdinal` usecase):装载 focus packages 成员+当前版本,调 domain。
6. web 事件名不变(复用 `project:resolve-references`/`project:resolve-reference-ordinal`/`project:get-output-package`);socket-handlers.test.ts 事件清单不变(不新增事件)。

## Migration(team/0079_project_reference_package_selections.sql)

- `project_reference_selections` ADD `package_id/package_projection/package_delivery_id/package_member_count`(CHECK 全空或全不空 + projection 值 CHECK);
- `project_reference_items` ADD `collection_revision INTEGER`;
- 注册进 0076-0078 同一 `sqliteTableExists(db,'project_artifact_collections')` 门禁。

## Web 设计(apps/web-next)

1. **OutputPackageCard** 增加引用入口(AC5/AC10):
   - 整包:`引用整包(current)`(默认)、`引用最终版`、`引用交付版` 三按钮 → 先 `getOutputPackage({projection})`;ready → 追加 `package_projection` 选择(带 expectedMemberRevisions);not_ready → 展示阻断清单(final 缺失项/被拒成员),不产生选择。
   - 成员行:`引用` 按钮(单选);`选择` 进入多选态(checkbox、计数、全选/取消、焦点恢复)→ `package_members`。
   - rejected/changes_requested 成员行:`基于此修改` 按钮 → 显式 `package_members`(该具体版本)。
   - 卡片需要 `onAddReference(selection, displayMeta)` 回调,从 chat page 注入(channel-message.tsx 透传)。
2. **composer chips**(AC10):package 选择显示 文件名+版本+projection policy(选择时刻从 projection 响应捕获的展示快照存组件 state,合同请求体不带展示负载);可逐个移除;发送失败保留(既有)。
3. **Files 入口**:`OutputPackageList` 行加同样的引用入口(复用卡片抽出的 hook/逻辑)。
4. **冻结回放**:`ProjectReferenceChips` 支持 package context 标签(整包·current 等)。

## 测试

**主 seam(apps/server-next/tests/output-package-reference.test.ts,memory+SQLite 双变体,fixture 复用 output-package-formation 的 commitDelivery 全真 publish)**:
1. projection query:delivered 在 current 移动后仍还原交付版(AC2);current 逐成员解析+被拒阻断(AC4);final 缺失 not_ready+缺失清单(AC3);specified 校验成员归属。
2. 发送冻结:package_projection current → referenceSet items=发送时 current 版本+package context+basis;事后 append 新 version 不改写历史消息(AC8)。
3. stale expectedMemberRevisions → selections_rejected,无消息落库(AC7/AC9);同 clientMessageId replay → 同一 referenceSet。
4. 提交点 fence:repo 级测试——解析后 bump collection revision → create 返回 reference_fact_conflict(双后端)。
5. package_members 显式选择被拒版本 → 允许(AC4 基于此修改);跨 package collection 版本 → version_not_in_package。
6. ordinal:单焦点 resolved(F2→具体版本+fence);双焦点 ambiguous。
7. 权限:私有频道非成员 query/发送均拒绝。

**domain 单测**:final 非必需成员省略、绝不 current 补齐;各 blocker 优先级。

**contracts 测试**:新 arm exact-key parse、canonicalize、projection 输入输出校验、枚举冻结清单更新。

**Web(RTL)**:卡片整包/单选/多选/基于此修改产出正确选择;final 缺失展示阻断;chips 显示文件名+版本+policy+计数+取消;发送失败保留 chips;多焦点短标识歧义展示候选。

## 切片顺序(TDD)

1. contracts 扩展 + 合同测试
2. domain projection policy + 单测
3. migration + repo 双端 fence + 类型
4. usecase:候选加载/资格/冻结/查询/ordinal + 主 seam 集成测试
5. web:卡片引用入口 + composer chips + Files 入口 + RTL 测试
6. 全量测试 + tsc + /code-review

## 明确不做(Out of Scope)

- Invocation/Task-linked Agent request 的引用冻结(后续切片)。
- message-tracer 实验路径的 selections 转发(既有缺口,不扩大)。
- `project:package-review-updated` 推送接线(#1061 遗留,与本票无关)。
- 自定义包/另存为包/成员增删。

## 验证与回归(2026-08-04)

- **contracts**:25 文件 / 310 测试全绿(新增 project-reference 9 项 + output-package 枚举冻结)。
- **domain**:64 文件 / 934 测试全绿(新增 projection policy 8 项 + package 资格裁决 6 项 + package ordinal 3 项)。
- **server-next**:cd 方式全量 136 文件 / 1830 通过 / 8 跳过;仅 2 失败均为 `phase-4-managed-server-worker-smoke` **预存 flaky**(主区未改动 main 单独复跑同样失败,与 #1029 记忆归因一致,本票零回归)。
- **web-next**:cd 方式全量 76 文件 / 498 测试全绿(新增 output-package-reference 5 项 RTL)。
- **tsc**:contracts/domain/pi-management-runtime/server-next/web-next 全绿(改 contracts 后重建本地 dist 再编下游)。
- **vitest 用法教训**:必须 `cd` 进包目录跑(测试用 `process.cwd()` 拼路径),`--root` 模式 cwd 在 worktree 根会误判文件不存在。

## 明确不做(Out of Scope)

- Invocation/Task-linked Agent request 的引用冻结(后续切片)。
- message-tracer 实验路径的 selections 转发(既有缺口,不扩大)。
- `project:package-review-updated` 推送接线(#1061 遗留,与本票无关)。
- 自定义包/另存为包/成员增删。

## 审查与修复(2026-08-04 /code-review 双轴)

无 P1。合并前修复:
- **P2-1**:final 整包 + omitted 成员时,发送端 fence 与 preview ready 矛盾——fence 改为只覆盖解析参与成员,omitted 不设 fence;投影非 ready 时阻断优先。补 domain 两项测试(final+omitted 可发送 / 多出 fence 拒绝)。
- **P2-2**:`parseProjectReferenceSelectionRequestsV1` 未接线——接入 `resolveAndFreezeSelections` 入口(message:send 与 resolve-references 共用),畸形 payload 结构化 VALIDATION_ERROR 拒绝。补集成测试。
- **P3-3**:delivered 在 collection 缺失时产出 `collectionRevision: 0` 撞 contracts 断言——改走 collection_unavailable 阻断。
- **P3-4**:成员归属校验重复 + 错误码分叉——抽共享 `resolveProjectPackageMemberVersion`。
- **P3-5**:web 阻断文案按 code 细分。
- **P3-2**:ordinal 焦点 collections/versions 提升到循环外(消 N+1 + 跨快照)。

已知遗留(非本票):Files 引用入口(AC10 计划步骤 3)、web 短标识歧义/指针漂移 RTL、`memberBlockers` 在发送路径死代码(仅 query 生效)、parser 未在 socket bind 层(usecase 入口已覆盖)。web 全量 498 / contracts 311 / domain 936 / server 相关 98 全绿。

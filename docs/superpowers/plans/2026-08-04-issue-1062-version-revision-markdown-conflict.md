# #1062 实现计划：闭环明确版本修改与 Markdown 并发冲突

- 父规格：#1059(§7 Markdown 编辑和版本冲突、§9 command registry、§11 失败/并发/审计)。
- 前置地基(已合 main)：#823 逻辑产物提升、#824 审核与 finalization、#825 Markdown 文档包(derive/save/restore/publish + 冲突交互)、#1060 OutputPackage、#1061 package-review family(availableActions/authority 分离)。
- 兄弟切片(并行中)：#1063 ProjectReferenceSet 冻结(另一 worktree)。本票不触碰 ProjectReferenceSet/消息发送冻结。
- 范围：只做 #1062 的 11 条 AC。不做自动文本合并(规格明确首版不做)、不做下游 Agent 交接(#1064)、不做 daemon 改动、不做非 Markdown 文件的在线编辑。

## 现状关键事实(两路摸底 + 亲自核查)

| 事实 | 位置 |
| --- | --- |
| Channel document 系统:revision 链 + baseRevisionId fence + 幂等 operations 表 + derive(Run artifact 派生) | migration 0038/0039/0040;`commitChannelDocumentRevision` usecases.ts L16777-16975 |
| document 冲突返回非结构化 `CONFLICT` 字符串;`FailureAck.details` 通道存在未用 | usecases.ts L16854-16856;contracts common.ts L26-33 |
| **document 与 collection/version 无任何关联**;run artifact(workspaceRunId)不能成为 document | getOrCreateChannelDocument usecases.ts L17013 拒绝 |
| collection/version:current_version_id 指针 + final_version_id(#824) + revision;append 只动 current | migration 0049/0053/0076;promote 条件 UPDATE sqlite L3500-3514 |
| versions 表无 revision provenance 列(无 source_version/review/package/delivery) | 0049/0076;lineage_json 仅 project_version/artifact |
| finalization 会推进 collection.revision | sqlite L3737/L5543 → expectedCollectionRevision 同时覆盖 final 漂移 |
| 交付形成的版本写 stage_id=null、source_message_id=null、lineage_json='[]'、promoted_by=agentId | sqlite recordPackageFormation L5186-5197 |
| review 按 version_id 索引 → 新版本天然不继承旧 review;final 指针不被 append 触碰 | 0078 L66-67;#824 setArtifactFinalVersion |
| availableActions 范式:Server 按用户计算成员动作,web 只渲染 | computePackageMemberAvailableActions usecases.ts L15586-15679;OutputPackageCard |
| 讨论串活动卡先例:system 消息 + meta 快照 + clientMessageId 幂等 + best-effort | appendOutputPackageSystemMessage output-package-handler.ts L430-486 |
| MarkdownDocumentEditor 已有 conflict 三键(查看最新版/复制草稿/继续手工合并)+ localStorage 草稿 | components/channel-documents/MarkdownDocumentEditor.tsx L469-502;lib/channel-document-drafts.ts |
| 文件库/任务页挂点:Files tab 在 chat 页内(ProjectArtifactLibrary + OutputPackageList);Task 页独立 | chat/page.tsx L2236-2260;tasks/page.tsx L1261-1289 |
| 文档编辑权限=频道可见人类 + markdownEditing rollout + 未归档(无 project-lead 门) | saveChannelDocument L7139-7145 |
| 最新 team migration 0078 → 本票 0079;ADR 最新 0070(family 注册沿用 ADR-0067,不新写 ADR) | migrations/team/;docs/adr/ |

## 关键设计解释:AC2 的「Server document revision」如何落地

规格 §7/AC2 的「新的 Server document revision + Artifact + ProjectArtifactVersion」在当前代码现实下
(collection 与 document 是无关联的平行系统,且 package 成员 artifact 是 run artifact、**结构上无法**成为
channel document)落地为:**collection 即逻辑文档,ProjectArtifactVersion 即其 Server revision 链**
(version_number 单调递增 = revision;baseRevisionId fence = baseVersionId 对 collection.currentVersionId)。
一次保存原子产生:新 Artifact(内容)+ 新 ProjectArtifactVersion(revision)+ collection.currentVersionId 移动。
这满足全部可测 AC(base fence、新 revision 可见、current 更新、结构化冲突),不发明 document↔collection 桥。

## 方案总览

新增封闭 command family `artifact-revision`(注册于 ADR-0067),1 个人类命令:

- `save-artifact-version-revision`:对 collection 内明确 base 版本保存 Markdown 修订,原子产生
  新 Artifact + 新 ProjectArtifactVersion + current 指针移动 + receipt;不继承旧 review/acceptance/finalization。

「基于此修改」不是独立 command:它是 package/Task/Files 三处的 UI 入口,打开编辑器时冻结
`revisionBasis { sourceVersionId, basisReviewId?, packageId?, deliveryId? }`,随保存命令提交,
Server 逐项复验(AC1)。草稿与合并在客户端完成(复用既有编辑器),Server 不保存草稿。

### 命令合同

```ts
input: {
  channelId, collectionId,
  baseVersionId,               // 内容 base + fence:必须等于 collection.currentVersionId
  content,                     // Markdown 全文(2MB/危险协议校验复用文档路径)
  filename?,                   // 可选;sanitize 复用
  expectedCollectionRevision,  // 第二道 fence(覆盖 final 移动/其他 append)
  revisionBasis: { sourceVersionId, basisReviewId?, packageId?, deliveryId? },
  idempotencyKey,
}
```

- outcome 八态沿用;`conflict` 携带**结构化** `revisionConflict`:
  `{ code, baseVersionId, serverCurrentVersionId, serverCurrentVersionNumber, collectionRevision, draftPreserved: true }`。
- conflict code:`base-version-stale`(current 已移动)/ `collection-revision-stale`(revision fence)/
  `revision-basis-stale`(basisReviewId 已非 sourceVersion 最新 review)。
- rejected 码:channel-not-found / channel-archived / collection-not-found / version-not-in-collection /
  not-markdown-version / actor-not-authorized / revision-basis-mismatch(review 不属于 sourceVersion
  或 decision 非 rejected/changes_requested;package/delivery 与 sourceVersion 成员身份对不上)/
  content-invalid / invalid-request。

### Server 判定(domain 纯函数 `evaluateArtifactVersionRevision`)

1. 频道归档 → rejected;actor 非频道人类成员 → rejected(fail closed,AC8)。
2. base/source version ∈ collection;base artifact 是 Markdown。
3. base fence:baseVersionId ≠ collection.currentVersionId → conflict(base-version-stale)。
4. collection fence:expectedCollectionRevision ≠ collection.revision → conflict(collection-revision-stale)。
5. basis 复验:basisReviewId 存在 ∧ 属于 sourceVersion ∧ decision ∈ {rejected, changes_requested};
   若 sourceVersion 已有更新 review → conflict(revision-basis-stale);
   packageId/deliveryId 提供时,sourceVersion 必须是该 package 的冻结成员且 deliveryId 一致。
6. 通过 → commit plan:新版本 source **继承 sourceVersion 持久化的 stage/task/message/run/invocation**
   (Server 推导,不信客户端);lineage = [project_version:sourceVersionId] (+ baseVersionId 若不同);
   revision provenance 列写入 basis。

### 原子事务(照抄 promote/recordPackageFormation 范式)

单事务:receipt 预查(replay/conflict)→ 复核双 fence → INSERT artifact → INSERT version
(version_number=max+1,UNIQUE(team,channel,artifact_id) 天然幂等)→
条件 UPDATE collections SET current_version_id, revision+1, version_count+1
WHERE id AND revision=expected AND current_version_id=baseVersionId(changes≠1 → 回滚 conflict)→
INSERT receipt + tombstone。内容写入 artifactContentStore 在事务外先行,失败删孤儿(文档路径同款)。

### AC4/AC5 结构性保证(测试钉死)

- 不继承:reviews 按 version_id 索引,新版本零 review → reviewState='pending';final_version_id 不动;
  Task delivery/acceptance 不触碰。
- Run artifact 不可变:保存永远新建 Artifact;原 artifact/版本行不改写。Run Markdown 非 collection 成员时
  仍走既有 derive 派生 Channel document(不改动)。

### 活动投影与一致 identity(AC9/AC10)

- 保存成功后 best-effort 追加 system 消息:meta `{kind:'artifact-version-revision', collectionId,
  versionId, versionNumber, baseVersionId, sourceVersionId, basisReviewId?, packageId?, deliveryId?,
  filename, collectionName, revisedBy, revisedByName}`,clientMessageId=`artifact-version-revision:<versionId>`
  幂等;不复制 Markdown 全文(只带元数据),senderKind='system' 不伪装 PI/人类发言。
- push `project:artifacts-updated`(既有事件)触发 Files/Task 重取;讨论串经消息推送出现卡片。
- 三处投影读同一 versionId/collectionId;重连后一律重取 Server projection,旧响应不覆盖新 revision。

### availableActions(AC1 入口)

- `PACKAGE_REVIEW_ACTIONS` 不动;新 `ARTIFACT_REVISION_ACTIONS = ['revise-version']`;
  `PackageMemberAvailableActionsDto.actions` 类型放宽为 `(PackageReviewAction | ArtifactRevisionAction)[]`
  (校验同步),并加可选 `latestReviewId?`(reviewState 为 rejected/changes_requested 时 Server 给出,
  供编辑器冻结 basisReviewId)。
- Server 计算:成员 delivered 版本 reviewState ∈ {rejected, changes_requested} ∧ Markdown ∧ 未归档
  ∧ 当前用户可编辑(频道人类成员)→ 动作含 `revise-version`。
- Files 集合区(ProjectArtifactLibrary):版本行按钮显隐 = version.reviewState(Server 事实)∈
  {rejected, changes_requested} ∧ Markdown ∧ !archived;review basis 从 version.reviews( Server 事实)取。
- Task 页/Files 包列表(OutputPackageList):聚合 reviewState(Server 事实)为 rejected/changes_requested
  时显示「基于此修改」→ 导航 chat 页 `?channel=<id>&revisePackage=<packageId>` → chat 页拉
  getOutputPackage 按成员 availableActions 打开编辑器(成员级真相只在 getOutputPackage)。

### Web 编辑器复用

复用 MarkdownDocumentEditor:draftIdentity.documentId=`artifact-version:<collectionId>:<sourceVersionId>`、
baseRevisionId=baseVersionId(草稿保留 AC6/AC7 零新代码);onSave→新 socket 封装;onLoadLatest→拉
collection 当前版本内容;冲突横幅文案用结构化 payload 拼「你的 base vM / Server 最新 vN / 草稿已保留本地」。
onPublish/onRestoreRevision 不传(不显示)。渲染入口与文档编辑器并列(chat page)。

### Migration 0079(team)

```sql
ALTER TABLE project_artifact_versions ADD COLUMN revised_from_version_id TEXT;
ALTER TABLE project_artifact_versions ADD COLUMN revision_basis_review_id TEXT;
ALTER TABLE project_artifact_versions ADD COLUMN revision_package_id TEXT;
ALTER TABLE project_artifact_versions ADD COLUMN revision_delivery_id TEXT;
CREATE TABLE artifact_revision_command_receipts (...);      -- 照 0078 receipt 表
CREATE TABLE artifact_revision_idempotency_tombstones (...); -- 照 0078 tombstone 表
```
静态注册进 applyTeamMigrations;DTO `ProjectArtifactVersionDto` 加可选
`revisionBasis?: { revisedFromVersionId, basisReviewId?, packageId?, deliveryId? }`(lineage 可见性 AC3)。

## 切片与验收映射(TDD:每切片先写失败测试)

### 切片 1:contracts `artifact-revision` family(AC1/AC6)

新 `packages/contracts/src/artifact-revision.ts`:command 名/Envelope/InputMap/OutputMap/
8 outcome/receipt/tombstone/结构化 `ArtifactRevisionConflictDto`/拒绝码/`ARTIFACT_REVISION_ACTIONS`/
canonicalize;output-package.ts 的 assertMemberAvailableActions 放宽;`ProjectArtifactVersionDto` 加
revisionBasis?;socket.ts 事件 `artifact-revision:save`。测试 `artifact-revision-contracts.test.ts`。
映射:AC1(basis 冻结字段)、AC6(结构化 conflict)、AC10(一致 identity 字段)。

### 切片 2:domain `artifact-revision-policy.ts`(AC1/AC3/AC4/AC8)

纯函数 `evaluateArtifactVersionRevision(facts, input)` → applied plan | conflict | rejected;
`deriveArtifactRevisionLineage`(source 继承 + lineage 构造)。测试覆盖判定矩阵全分支。

### 切片 3:server(AC1-AC6/AC8-AC10)

- migration 0079 + 静态注册;memory+sqlite 双仓储 `recordArtifactVersionRevision`(单事务 CAS);
  receipt/tombstone CRUD(照 package-review-repositories)。
- `artifact-revision-handler.ts`:canonical hash → receipt 预查 → 加载事实 → domain → 内容校验
  (抽用文档路径的 2MB/script 检查)→ content store 写 → 事务 → receipt → best-effort 活动消息 +
  artifacts-updated push。rollout flag 复用 channelFileRollout.markdownEditing(关闭 → rejected)。
- usecases.ts socket 入口(session 推导 teamId/userId;ensureUserCanViewChannel;envelope 无 authority);
  getOutputPackage availableActions 加 revise-version + latestReviewId;buildProjectArtifactLibrary 的
  version DTO 带 revisionBasis。
- socket-handlers.ts 绑定 + **socket-handlers.test.ts 清单同步**(两次教训)。
- 测试 `tests/artifact-version-revision.test.ts` 双后端:
  成功(新版本/current 移动/final 不动/reviewState pending/lineage+source 继承/basis 落列/receipt);
  replay(同 key 同 payload → replayed 同 versionId 行数不变;异 payload → conflict 无副作用);
  stale base/stale collection revision/stale basis → 结构化 conflict 零部分写入;
  basis mismatch/非成员/归档/非 Markdown → rejected;
  原子性(强制事务中段失败 → 零部分行);
  活动消息 meta + clientMessageId 幂等;availableActions 只在 rejected/changes_requested 成员出现。

### 切片 4:web(AC1/AC5/AC7/AC9/AC10)

- lib/socket.ts `saveArtifactVersionRevision`;lib/artifact-revision.ts meta 解析(照 output-package.ts)。
- OutputPackageCard:revise-version 按钮 → 打开修订编辑器;OutputPackageList:聚合 reviewState 入口;
  ProjectArtifactLibrary:版本行「基于此修改」;tasks 页:导航 chat 带参。
- chat page:修订编辑器状态机(打开/保存/冲突/查看最新/人工合并),复用 MarkdownDocumentEditor;
  活动卡渲染分支(meta kind artifact-version-revision)进 ChatBubble/channel-message。
- 测试 `tests/artifact-version-revision-editor.test.tsx`:成功保存、stale conflict 横幅(base/最新/草稿保留)、
  查看最新版、人工合并再保存、草稿 localStorage 恢复、final 徽标不动、Run artifact derive 入口不破坏。

### 切片 5:文档与收口

本计划文档随 PR 提交;全量 test:ci;tsc;retained-boundaries;/code-review;PR 含 Closes #1062。

## 文件清单

| 层 | 文件 | 动作 |
| --- | --- | --- |
| contracts | `src/artifact-revision.ts`(新)、`index.ts`、`socket.ts`、`output-package.ts`(actions 放宽+latestReviewId)、`project.ts`(revisionBasis?) | 新 family |
| domain | `src/artifact-revision-policy.ts`(新)、`index.ts` | 纯决策 |
| server app | `application/artifact-revision-repositories.ts`(新)、`application/artifact-revision-handler.ts`(新)、`usecases.ts`、`project-repositories.ts`(record+读取 revisionBasis) | handler+接线 |
| server infra | `infra/memory/repositories.ts`、`infra/sqlite/repositories.ts`、migration `0079_artifact_version_revision.sql`(新) | 双实现+注册 |
| transport | `socket-handlers.ts`、`tests/socket-handlers.test.ts` | 绑定+清单同步 |
| web | `lib/socket.ts`、`lib/artifact-revision.ts`(新)、`components/OutputPackageCard.tsx`、`components/project/OutputPackageList.tsx`、`components/ProjectArtifactLibrary.tsx`、`app/[teamPath]/chat/page.tsx`、`app/[teamPath]/tasks/page.tsx`、`components/channel-message.tsx` | 三入口+编辑器+活动卡 |
| 测试 | contracts/domain/server/web 各新测试文件 | 双后端+RTL |

## 边界(不做)

自动文本合并/OT/CRDT/diff;ProjectReferenceSet 与发送冻结(#1063);下游 Agent 交接(#1064);
跨界面一致投影总收口(#1065);归档收口(#1066);非 Markdown 在线编辑;collection 重命名;
document↔collection 桥(旧 saveChannelDocument 路径不动);daemon 改动;历史数据回填。

## 风险与注意

- **worktree 纪律**:文件操作一律用 worktree 绝对路径前缀;git 显式列文件 add(node_modules 软链陷阱);
  server-next import workspace 包必须相对路径(CI 不构建 dist 教训);改 contracts/domain 后本地 rebuild dist。
- 新增 socket 绑定必同步 socket-handlers.test.ts 期望清单(两次教训)。
- `UNIQUE(team_id, channel_id, artifact_id)`:幂等 replay 返回既有版本前必须按 receipt 而非自然键猜。
- 组合原子性:fence 复核必须先于任何 INSERT(better-sqlite3 return 即 COMMIT 教训——本命令单事务内
  先复核再写)。
- 活动消息 best-effort:失败不改写已提交事实;clientMessageId 幂等防重入双卡。
- 与 #1063 并行:同改 output-package.ts/web 组件,合并时后合者 rebase;本票不碰 ProjectReferenceSet 文件。
- web-next 测试断言首帧用 renderToString 惯例;RTL queryByTestId 不认 data-smoke(#1061 教训)。

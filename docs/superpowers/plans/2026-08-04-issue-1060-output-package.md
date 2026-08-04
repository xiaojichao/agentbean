# #1060 实现计划：已提交的 Agent 交付形成可审核 OutputPackage

- 父规格：#1059(OutputPackage 领域合同 §3、delivery→文件包 §4、command/query 决策 §9/§10、失败与审计 §11)。
- 前置地基(已合 main):#1042 Channel-first managed run、#1043 immutable snapshot、#1044 publish identity 原子发布与恢复、#1045 reported 路径、#1053/#1056 身份与跨 Team 收口、#966 Workspace 原子发布、#823/#825 逻辑产物与文档包、#824 审核与 finalization。
- 范围：只做 #1060 的 11 条 AC。不做 current/final/specified 投影解析、ProjectReferenceSet 冻结、审核/final 组合命令、下游 Agent 交接、Markdown 冲突(后续切片)。

## 现状关键事实(5 路摸底结论)

| 事实 | 位置 |
| --- | --- |
| commit 成功后 Server 无任何后续动作(无 activity/outbox/对账) | `usecases.ts` L6782-6807 |
| commit 幂等短路(重入点,reconciliation 挂点) | `usecases.ts` L6486-6506 |
| commit 复验只覆盖 Agent/Task/Device,不验 Invocation/claim/attempt | `ensureWorkspacePublishProvenanceAuthority` L15689 |
| revision files 已带 artifactId(物化在 commit 内完成) | `usecases.ts` L6678-6685 |
| provenance 无 taskRevision/invocationId/claimLeaseId | contracts `project-channel-workspace.ts` L175-190 |
| artifact collection/version/review/finalization 体系完整 | migration 0049/0053;`project-repositories.ts`;memory L2069+ / sqlite L3334+ |
| command 惯例:手写 exact-key schema+receipt+tombstone+8 outcome | promotion-gate.ts / task-lifecycle-kernel.ts `handle()` L160-249 |
| 子 Task delivery 旧路径(delivery+in_review 焊死) | `subtask-delivery-service.ts` L32 |
| 讨论串 meta 卡片先例 | `task-status-updated`(usecases.ts L9124-9141 写,chat page ChatBubble 渲染) |
| 最新 migration:team 0074 → 本票用 0075 | `applyTeamMigrations` L132-263 静态注册 |

## 方案总览

新增封闭 command family `output-package`:

- **Command**:`record-agent-output-package`(Server system initiator,不对 socket 暴露 command 绑定;由 commit 成功路径与 commit 幂等重入路径内部触发)。
- **Query**:`get-output-package`、`list-channel-output-packages`(socket 绑定,channel 成员可读)。
- **聚合**:`OutputPackage`(稳定 packageId,创建后不可变)+ 冻结成员 + 1:1 delivery lineage。

### 触发与 reconciliation(AC7/AC8/AC9)

- commit 成功(L6804 return 前)与 commit 幂等短路(L6486 分支)均调用 `attemptOutputPackageFormation({teamId, channelId, publishId})`(try/catch,不影响已成功的 commit 结果)。
- 幂等键确定性派生:`record-agent-output-package:<channelId>:<publishId>` → 重复 Device 回调/outbox 重放/同 key replay 收敛同一 receipt;`outcome_unknown` 用原 key replay 收敛,禁止换 key。
- 业务拒绝(authority 撤、attempt 失效等)确定性可重判,不写业务事实;staging 保持 committed = 可恢复事实;`list-channel-output-packages` 返回 `pendingDeliveries`(committed+有 provenance+无 package)→ UI 显示「交付处理中」,不伪造完整交付。
- 无后台对账队列(与现状一致,重试驱动);重入点即 reconciliation 触发点。

### Command 复验(AC:Invocation/claim/Task revision/attempt/delivery contract/Workspace revision)

输入只有 `{ channelId, publishId, workspaceRevisionId }`(目标身份;provenance 一律 Server 从 staging/revision 事实读取,客户端不可伪造)。handler 加载事实后经 domain 纯函数 `evaluateOutputPackageFormation` 判定:

1. staging.status==='committed' 且 committedRevisionId===workspaceRevisionId 且 channel 匹配,否则 `workspace-revision-not-committed`(未 commit/commit 失败/恢复中 → 拒绝,device seam 窄证明)。
2. revision.files 非空且每个 file 有 artifactId,否则 `incomplete-delivery`。
3. Agent authority 复验(复用 #1044 同款检查:存在/visibleTeamIds/channel.agentMemberIds/device 绑定)→ `agent-authority-revoked`。
4. Task 绑定:
   - taskId 命中真实 Task:有 coordination+invocation 链时,校验 invocation intent(taskId/taskRevision/taskAttempt/claimLeaseId 与当前 coordination/claim 一致)、claim 未被取代、task.revision 未漂移 → 绑定 managed lineage(taskRevision/attempt/invocationId/workspaceRunId/claimLeaseId);漂移 → `task-attempt-superseded`/`invocation-mismatch`/`claim-inactive` 拒绝。
   - 真实 Task 但无 management 链(普通频道任务):绑定当前 revision,taskAttempt 取 provenance。
   - 合成 taskId(daemon fallback,无 Task 行):`taskBinding='unmanaged'`,只记 provenance(与 #1044 commit 放行姿态一致)。
5. 同一 delivery 内同一相对路径(=同一逻辑 collection)出现两次 → `duplicate-manifest-entry` 拒绝(spec §4)。
6. 归档频道拒绝(commit 已挡,防御性复核)。

### 原子事务(AC1/AC7)

`OutputPackageRepository.recordPackageFormation(...)` 单次调用,sqlite 内一个 `teamDb.transaction` 完成:

- 对每个交付文件:按规范化相对路径找/建 `project_artifact_collections`(name=相对路径,UNIQUE(team,channel,name) 天然幂等),追加 `project_artifact_versions`(versionNumber 递增,source 绑 taskRevision/workspaceRunId/invocationId,UNIQUE(team,channel,artifact_id) 防重)。
- 写 `output_packages`(UNIQUE(team,publish_id) + UNIQUE(team,delivery_id))+ `output_package_members`(冻结:sequence/shortLabel F1..Fn/collectionId/artifactVersionId/role/requiredForFinal/sourcePath/filename/sha256/sizeBytes)。
- 写 family receipt(+tombstone)。
- 任一步失败整体回滚:无部分 version/delivery/package 事实;成员永不 UPDATE/DELETE(追加即冻结)。
- replay(同 publishId 已有 package)→ 返回既有 package,不新建。

**Package 出现不推进 Task(AC6)**:handler 不触碰 tasks/lifecycle;测试钉死 task.status 不变、root 不进 in_review。子 Task 的 readiness gate 已在 `submitRootDelivery`/`acceptSubtask` 等既有路径,本票不改。

### 成员冻结字段(AC2/AC3/AC4)

- `shortLabel`:F1..Fn,按 manifest 顺序,创建后不变;仅在 package/Thread 焦点内唯一。
- `role`:v1 恒 `'deliverable'`(enum 预留扩展;ADR-0052 不从路径推导角色)。
- `requiredForFinal`:v1 恒 true(final 投影属后续切片,字段先冻结)。
- `artifactVersionId`:交付时版本,永久冻结;collection 后续 append 新 version 不改写 package(current/final 投影后续切片实现,package 本体永远保留 delivered 事实)。
- 新文件/新 delivery = 新 publishId → 新 package;旧 package 成员不可增删重排。

### Migration 0075(team)

`output_packages` / `output_package_members`(FK→packages CASCADE)/ `output_package_receipts` / `output_package_tombstones`;静态注册进 `applyTeamMigrations`;members 不对 versions 建 FK(避免 RESTRICT 陷阱,软引用+文档)。

### Socket / projection

- 新增绑定:`project:listOutputPackages`、`project:getOutputPackage`;push:`project:output-packages-updated`(与 artifacts-updated 并列,package 成形后触发)。**同步 `socket-handlers.test.ts` 期望清单**(两次教训)。
- Query 合同:schemaVersion + audienceScope(`${teamId}:${channelId}`)+ asOf + nextCursor(opaque)+ minimumConsistency 字段(直读权威表,恒满足,留合同位)。outcome: ready/projection_not_ready/rejected/conflict。

### Web 三投影(AC5/AC8,同一 Server 事实)

1. **讨论串**:package 成形后 post-commit(best-effort,失败不改写业务事实)追加 system 消息,meta `{kind:'output-package', packageId, taskId, agentId, members:[{shortLabel,filename,artifactVersionId,collectionId}], memberCount, workspaceRevisionId, publishId}`。新建 `components/OutputPackageCard.tsx`(复用 ArtifactCard 渲染成员),`lib/output-package.ts` 解析 meta;`chat/page.tsx` ChatBubble 与 `components/channel-message.tsx` 各加一个分支(仿 task-status-updated/ProjectDocumentInputSetResultSummary)。成员与 delivered 版本天然不可变 → meta 快照不会与 Server 事实漂移。
2. **Task**:Task 详情(TaskThreadPanel)加「交付文件包」摘要区:`projectEvents().listOutputPackages(channelId)` 按 taskId 过滤,显示 packageId/成员数/attempt/时间;pending 显示「交付处理中」。
3. **Files**:`ProjectArtifactLibrary` 顶部加「交付文件包」区(packages + pendingDeliveries),成员可点开 collection;collection 区既有 current/final/历史不变。

### 测试(主 seam:memory+SQLite 双跑)

新 `tests/output-package-formation.test.ts`(双后端 suite 模式,参照 subtask-delivery-service.test.ts):
- 成功:collection 创建+追加(两批 delivery 同路径→同 collection 两 version)、package 冻结字段、receipt applied、同一 Server identity 三处可读。
- replay:同 key 同 payload→replayed+同 packageId,行数不变;同 key 不同 payload→conflict 无副作用。
- 拒绝:未 commit(device seam 窄证明)/agent 撤权/task attempt 漂移/invocation 不匹配/重复 manifest entry/归档频道 → 无 package/version/collection 部分事实,staging 保持 committed。
- 原子性:预置自然键冲突迫使事务中失败 → 无部分行。
- AC6:managed 子 Task 形成 package 后 status 不变、root 不进 in_review。
- AC8:committed 无 package 时 pendingDeliveries 可见;formation 后消失;重入收敛同一 package。
- migration schema 钉死(sqlite_master 清单)。

Web:`tests/output-package-card.test.tsx`(RTL:meta→卡片渲染/成员/短标识)+ Files 区渲染测试。

## 文件清单

| 层 | 文件 | 动作 |
| --- | --- | --- |
| contracts | `packages/contracts/src/output-package.ts`(新)、`index.ts`、`socket.ts` | 新 family schema/DTO/事件名 |
| domain | `packages/domain/src/output-package-policy.ts`(新)、`index.ts` | 纯函数决策 |
| server app | `application/output-package-repositories.ts`(新)、`application/output-package-handler.ts`(新)、`usecases.ts` | 记录+handler+commit 两处触发 |
| server infra | `infra/memory/repositories.ts`、`infra/sqlite/repositories.ts`、migration `0075_output_packages.sql`(新) | 双实现+注册 |
| transport | `socket-handlers.ts`、`tests/socket-handlers.test.ts` | query 绑定+清单同步 |
| web | `lib/output-package.ts`、`components/OutputPackageCard.tsx`、`chat/page.tsx`、`channel-message.tsx`、`ProjectArtifactLibrary.tsx`、`tasks/page.tsx`、`lib/socket.ts` | 三投影 |
| 测试 | `tests/output-package-formation.test.ts`(新)、web 测试(新) | 双后端+RTL |

## 边界(不做)

current/final/specified 投影解析与 final 缺失阻断;ProjectReferenceSet 与发送冻结;审核/finalization 新命令(沿用 #824 既有);子 Task readiness gate 重构;root review 编排;Markdown 编辑冲突;daemon 改动;历史数据回填;跨频道 package。

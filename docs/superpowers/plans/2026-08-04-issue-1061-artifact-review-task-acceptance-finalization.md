# #1061 实现计划：分离文件审核、Task 交付验收与最终版设置

- 父规格：#1059(§5 审核/Task 验收/finalization 独立事实、§6 引用冻结、§11 失败与审计)。
- 前置地基(已合 main):#824 审核与 finalization、#926 Task 具名生命周期、#947 offer/attestation、#1060 OutputPackage。
- 范围：只做 #1061 的 12 条 AC(issue 实际列 11 条 + 主 seam 测试)。不做 ProjectReferenceSet 冻结/发送选择解析(后续切片)、不做 Markdown 冲突、不做 daemon 改动。

## 现状关键事实(探索结论)

| 事实 | 位置 |
| --- | --- |
| #824 review:append-only,绑 collection/version/stage_id(NOT NULL),basis refs,幂等 mutation | migration 0053;`project-artifact-review-policy.ts`;usecases.ts L7800+ |
| #824 finalization:绑 collection,需最新 approved review,保留 previousVersionId/历史,幂等 | 同上;`setArtifactFinalVersion` |
| #824 authority:owner/admin/projectLead/stageReviewer;Agent/PI Manager 拒绝 | `evaluateArtifactReviewAuthority` / `hasProjectArtifactDecisionAuthority` |
| #1060 OutputPackage:冻结成员 + delivery lineage;final projection/组合命令=后续切片 | `output-package.ts` contracts;migration 0077;`output-package-handler.ts` |
| #926 task lifecycle:10 command;submitRootDelivery 已有 readiness;accept-subtask human 路径无预绑定 token | `task-lifecycle.ts`;`task-lifecycle-kernel.ts` L551 |
| coordination 表有 review_policy('human'/'manager'),无 authority ids | migration 0013 |
| root Task requester_id 存在 | migration 0059/0060 |
| 最新 migration:0077 → 本票用 0078 | `applyTeamMigrations` 静态注册 |
| server 惯例:workspace 包相对路径 import;命令=closed registry+receipt+tombstone+8 outcome | output-package-handler.ts |
| web:review 按钮在 ProjectArtifactLibrary,直接调 socket usecase,无 availableActions | `lib/socket.ts` L973 |

## 方案总览

新增封闭 command family `package-review`(ADR-0067),3 个人类命令:

- `submit-package-artifact-review`:AC1——对 package 成员的具体 version 提交审核(approved/changes_requested/rejected),绑定 package/collection/version/delivery/Task revision/attempt 与 reviewer authority basis;append-only。
- `submit-package-review-and-finalize`:AC9——"通过并设为最终版",同一操作者同时持有 review 与 finalization authority,一个事务写两个独立事实(review 记录 + finalization 记录 + 指针移动)。
- `submit-package-review-and-reject-delivery`:AC6——review(changes_requested/rejected)+ 退回 Task delivery 原子提交,失效旧 delivery/claim/input rights,产生新 Task revision(根)或新 attempt(子)。

同时:

- **review 记录模型扩展**(AC1):`project_artifact_reviews` 重建加列 package_id/delivery_id/task_id/task_revision/task_attempt(可空,兼容人工 promote 路径)与 authority_basis;stage_id 改可空(交付版本 stage 可为 NULL,0076 已放开版本侧)。
- **authority token**(AC3/AC4):`task_coordinations` 加列 `human_acceptance_authority_ids_json`(创建时预绑定;root=Human review authority,subtask=Subtask human acceptance authority);accept-subtask human 路径与 accept-root-delivery 增加"actor ∈ 预绑定列表"校验,列表为空时 fail closed;token 绑定当前 revision/attempt/delivery 由既有 delivery/claim 校验保证。
- **availableActions**(AC11):Server 在 package/version 投影中计算当前用户可执行动作(review/finalize/组合),web 只渲染 Server 给的按钮,不推断权限。
- **finalization 门控**(AC7/AC8):复用 #824 语义(需有效 approved review、保留历史、编辑/Agent 修订/Task 变化不自动移动 final),测试钉死。

## 切片与验收映射

### 切片 1:contracts `package-review` family(AC1/AC6/AC9/AC10)

新建 `packages/contracts/src/package-review.ts`,照抄 output-package family 的结构:

- command names:`submit-package-artifact-review` / `submit-package-review-and-finalize` / `submit-package-review-and-reject-delivery`;envelope/input/output maps/response 8 outcome/receipt/tombstone 字段。
- input 关键字段:
  - review:`{ channelId, packageId, collectionId, versionId, deliveryId, decision, comment, idempotencyKey }`;expectedCollectionRevision(AC10 并发 finalization fence);expectedTaskRevision/expectedTaskAttempt(AC6 退回时 Task fence)。
  - finalize 组合:同上 + `{ expectedCollectionRevision }`。
  - reject-delivery 组合:同上 + `{ expectedTaskRevision, rejectReason }`。
- 新增 `PackageReviewAction` 类型:review-approved / review-changes-requested / review-rejected / review-and-finalize / review-and-reject-delivery / set-final(供 availableActions 投影)。
- `index.ts` barrel 导出;`socket.ts` 事件名:`package-review:submit` 等 3 个绑定 + push `package-review:updated`、`package-review:task-transitioned`。

### 切片 2:domain 纯策略(AC1-AC10)

新建 `packages/domain/src/package-review-policy.ts`:

1. `evaluatePackageArtifactReviewAuthority`(AC1/AC2):复用 `evaluateArtifactReviewAuthority`(owner/admin/projectLead/stageReviewer;agent/pi_manager 拒绝),新增校验:
   - version ∈ package 成员(collectionId/versionId 与成员冻结值一致);
   - package 与 version 同 channel 作用域;
   - 返回 `authorityBasis`(stage-reviewer-delegation / team-owner / team-admin / project-lead / subtask-human-acceptance / root-review-authority)供记录。
2. `evaluateSubtaskHumanAcceptanceAuthority`(AC3):actor ∈ coordination 预绑定 ids;未绑定 → rejected。
3. `evaluateRootHumanReviewAuthority`(AC4):actor ∈ root coordination 预绑定 ids;未绑定 → rejected。
4. `evaluatePackageReviewDecision`(AC10):replay(同 key 同 hash)/ conflict(同 key 异 hash)/ version-scope / package-scope / revision-stale 判定,复用 #824 模式。
5. `evaluateReviewAndFinalizeCombined`(AC9):单决策——同一 actor 同时满足 review authority 与 finalization authority(#824 的 hasProjectArtifactDecisionAuthority + 版本最新 review 为 approved 的预判),输出两个事实的写入计划。
6. `evaluateReviewAndRejectDeliveryCombined`(AC6):review 决策(非 approved)+ Task 退回决策(绑定 expectedTaskRevision/expectedTaskAttempt,子=新 attempt,根=新 revision),输出原子计划。

### 切片 3:server 接线(AC1/AC6/AC9/AC10/AC3/AC4)

- **Migration 0078**(team):
  - 重建 `project_artifact_reviews`(0076 重建惯例 + sqliteTableExists 守卫):加 package_id/delivery_id/task_id/task_revision/task_attempt/authority_basis(可空),stage_id 改可空;旧索引按名重建;数据 copy 保留。
  - `ALTER TABLE task_coordinations ADD COLUMN human_acceptance_authority_ids_json TEXT NOT NULL DEFAULT '[]'`。
  - 新表 `package_review_command_receipts` + `package_review_idempotency_tombstones`(照抄 output-package 的 receipt/tombstone 表)。
- **`application/package-review-repositories.ts`**(新):receipt/tombstone CRUD(照抄 output-package-repositories.ts)+ `getPackageReviewReadyFacts`(package+members+reviews+collection snapshot)。
- **`application/package-review-handler.ts`**(新):3 个命令的 application 层。加载事实 → domain 纯函数 → 单事务提交:
  - review:appendArtifactReview(扩展 record)+ receipt;
  - finalize 组合:review append + finalization append + collection 指针移动,一个 sqlite transaction;
  - reject-delivery 组合:review append + task-lifecycle-kernel 的 reject 路径(reject-subtask / reject-root-delivery 语义复用,同一事务)。
  - 任一校验失败 → 结构化 rejected/conflict,无部分事实。
- **`application/project-repositories.ts`**:ProjectArtifactReviewRecord 加 package/delivery/task/authorityBasis 字段;appendArtifactReview 支持扩展字段;listArtifactReviews 返回。
- **`application/task-lifecycle-kernel.ts`**:acceptSubtask human 路径 + acceptRootDelivery 增加 authority 校验(调 domain 纯函数);`task-coordination-kernel.ts` 创建 coordination 时写入预绑定 ids(从 input/requester 推导)。
- **`usecases.ts`**:3 个命令的 socket 入口(teamId 从 session 推导,envelope 无 authority 字段)。
- **availableActions**:`get-output-package`/`list-channel-output-packages`/ProjectArtifactLibrary 相关 query 的 result 增加 `availableActions: PackageReviewAction[]`(Server 按当前 user 计算)。
- **`socket-handlers.ts`** + `tests/socket-handlers.test.ts`:3 个绑定 + 清单同步。

### 切片 4:web 三投影(AC5/AC11)

- `lib/socket.ts`:3 个 emit 封装。
- Chat `OutputPackageCard.tsx`:从 package query 的 availableActions 渲染审核按钮(通过/要求修改/拒绝/通过并设为最终版),不推断权限;点击调新命令。
- Task 页:`TaskThreadPanel`/task 详情加 review/final 状态展示(区分"文件已通过"与"Task 已验收"两个事实,AC5)。
- Files `ProjectArtifactLibrary.tsx`:review 区显示绑定 package 的审核状态 + availableActions 按钮。
- 三处都只读 Server projection;按钮可见性完全由 availableActions 决定。

### 切片 5:测试(AC12 + 全 AC 钉死)

- contracts:`tests/package-review-contracts.test.ts`(parse/canonical/枚举)。
- domain:`tests/package-review-policy.test.ts`(authority 分离、组合决策、CAS、幂等)。
- server:`tests/package-review-command.test.ts`(双后端 suite,memory+sqlite):
  - AC1:review 绑定 package context,append-only,三种决策;
  - AC2:成员/建议审核人/Task assignee/Agent/PI Manager 均无审核权;owner/admin/projectLead/stageReviewer 有;
  - AC3:子 Task 客观验收仅 pi_driver;主观/高风险须预绑定 authority,未绑定 fail closed,revision/attempt/delivery 漂移拒绝;
  - AC4:root readiness 才提交 delivery;Human review authority 接受才 done;退回产生新 revision 恢复 in_progress;
  - AC5:approved 不自动 done;delivery 验收不伪造 review;审计可区分;
  - AC6:组合退回原子;旧 delivery/claim 失效;
  - AC7:final 只指有效 approved review 版本;previousVersionId/历史保留;
  - AC8:编辑/Agent 修订/Task 变化不自动移动 final;
  - AC9:组合双 authority;单事务两事实;任一失败无部分结果;
  - AC10:stale/并发/越权/replay/conflict 结构化 outcome;
  - AC11:availableActions 由 Server 计算,web 测试验证按钮来自 Server。
- web:`tests/package-review-card.test.tsx`(RTL:按钮渲染自 availableActions、三事实区分显示)。
- socket-handlers.test.ts 事件清单同步。

## 文件清单

| 层 | 文件 | 动作 |
| --- | --- | --- |
| contracts | `packages/contracts/src/package-review.ts`(新)、`index.ts`、`socket.ts` | 新 family schema/DTO/事件 |
| domain | `packages/domain/src/package-review-policy.ts`(新)、`index.ts` | 纯函数决策 |
| server app | `application/package-review-repositories.ts`(新)、`application/package-review-handler.ts`(新)、`usecases.ts`、`project-repositories.ts`、`management/task-lifecycle-kernel.ts`、`management/task-coordination-kernel.ts` | handler+authority 校验+预绑定 |
| server infra | `infra/memory/repositories.ts`、`infra/sqlite/repositories.ts`、migration `0078_package_review.sql`(新) | 双实现+注册 |
| transport | `socket-handlers.ts`、`tests/socket-handlers.test.ts` | 绑定+清单同步 |
| web | `lib/socket.ts`、`components/OutputPackageCard.tsx`、`components/project/ProjectArtifactLibrary.tsx`、`app/[teamPath]/tasks/page.tsx` 相关、`lib/output-package.ts` | 三投影 |
| 测试 | `tests/package-review-contracts.test.ts`、`tests/package-review-policy.test.ts`、`tests/package-review-command.test.ts`(新)、web 测试(新) | 双后端+RTL |

## 边界(不做)

ProjectReferenceSet 与发送冻结、current/final/specified 投影解析(后续切片);Markdown 编辑冲突;daemon 改动;历史数据回填;跨频道 package;Agent/PI Manager 人类动作模拟。

## 风险与注意

- accept-subtask/accept-root-delivery 增加 authority 校验会收紧既有权限,存量测试可能红——先跑相关测试归因,必要时按新语义修正测试(规格要求 fail closed,收紧是预期行为)。
- review 表重建必须按 0076 同款惯例(create-new+copy+drop+rename)+ sqliteTableExists 守卫;FK 按表名自动指向新表,索引必须按原名重建。
- 新增 socket 绑定必同步 socket-handlers.test.ts 期望清单(两次教训)。
- server-next import workspace 包必须相对路径(CI 不构建 dist 教训)。

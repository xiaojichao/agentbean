# 设计：从任务审核工作区回到讨论串并冻结修改依据(#1178)

## 0. 核心判断：这是接线切片，不是新机制

调研（research/ 目录 13 份文件）确认 issue 要求的全部 Server 机制已存在：

| issue 要求 | 现状 | 来源 |
|---|---|---|
| 发送前不落 Message/Offer/claim/Invocation | compose URL 深链落本地 state 即删；预填纯客户端 | #1064（chat/page.tsx:1590-1613） |
| 发送时冻结 artifactVersionId | `message:send` 事务内解析 + `persistFrozenProjectReferences` 同事务落库 + 提交点二次复核 | usecases.ts:5470/15834 |
| Agent acceptance 后才建 claim | `evaluateTaskLinkedRequestContext` 事务内只读复验 → 消息提交后 `publishTaskLinkedOffers`（不建 claim/Invocation）→ acceptance CAS | task-linked-request-handler.ts / task-claim-broker.ts |
| Invocation 用冻结输入、不重新解析 | frozenInputs 写入 immutable intent + intentHash | invocation-gateway.ts:145-177 |
| stale basis fail closed | 六种 fence：expectedRevision / OFFER_STALE / FROZEN_BASIS_CHANGED / stage fence 字符串 / expectedCollectionRevision / 读路径水位 | research/stale-basis-fail-closed.md |
| 要求修改 → 新 revision/attempt、旧事实保留 | `submit-package-review-and-reject-delivery` 原子事务 | #1177 package-review-handler.ts:490-582 |
| 三处（Tasks/Files/Thread）消费同一事实 | 四投影共用 Server 事实 + minimumConsistency 水位 | research/output-package-projections.md |

**结论：Server 零新命令、零新表、零 migration。** 本切片 = 把 #1177 阶段工作区的三个交接入口接到 #1064 的预填/冻结链路上 + 策略展示 + 测试兜底。

## 1. 边界与数据流

```
阶段详情工作区 (StageDeliveryReviewWorkspace)
   │ 点击「交给智能体处理」/「要求修改后继续」/「回到讨论串」
   ▼
chat 页 onOpenThread / onDeliveryAction            ← 全部本地 state，零 Server 写
   │ openThread(threadRootMessageId) + setThreadInput + setThreadSelections + focus
   ▼
Thread composer（本地预填态）
   │ selection chips 展示 package/成员/版本策略 + 「发送时冻结」提示
   │ 用户可改文案、增删 selections、@Agent
   ▼ 用户点发送（此刻才产生事实）
message:send { threadId, text, selections }
   │ Server 事务内：复验 → 解析 ProjectReferenceSet → 冻结 artifactVersionId
   ▼
Message + referenceSet（append-only）→ task-linked request → Offer → acceptance → claim → Invocation(frozen intent)
```

事实边界遵守 issue：按钮点击、composer draft、URL 参数都不是工作事实；唯一事实产生点是 `message:send`。

## 2. Web 改动（apps/web-next）

### 2.1 「回到讨论串」——已存在，补关联保持测试
- `StageDeliveryReviewWorkspace.tsx:421` 已有按钮，disabled 当 `threadRootMessageId` 为空。
- AC1「刷新/返回后仍保持 task/stage/thread 关联」：`?view=project&stage=<id>&task=<id>` 与 `?thread=<channelId>:<messageId>` 都是 URL 深链，openThread 只写 thread 参数、不动 stage/task 参数，天然保持。补测试锁定此行为。

### 2.2 「交给智能体处理」——预填升级
现状（chat/page.tsx:2909）：`openThread + setThreadInput('@') + focus`，无 selections、无 task linkage 文案。

升级后预填：
- text：`@` 开头 + 意图文案（如「请继续处理任务 <taskTitle> 的当前文件包：」），保持 `@` 触发成员选择器的现交互。
- selections：focusPackage 存在时预填 `[{ kind: 'package_projection', packageId, policy: 'current' }]`。
  - 选 current 的理由：继续处理语义 = 基于当前最新进展；current 策略解析时拒绝 review 未过的成员版本（not_ready 会在 chips 上显式，用户可改选 final/delivered）。
- 焦点恢复：沿用 `threadTextareaRef` focus 现状。
- threadRootMessageId 为空（普通阶段任务无绑定 Thread）时保留现有回落：主 composer 预填。

### 2.3 「要求修改后继续」——新入口
- 位置：`StageDeliveryReviewWorkspace` 导航按钮区（与「回到讨论串」同排）。
- 可见条件（纯 Server 事实推导，不新增客户端语义）：focusPackage 存在 且 （任一 member 最新 review decision = changes_requested 或 taskOverview 显示 delivery 被退回） 且 task 非终态 且 频道未归档。
- 预填：
  - text：意图文案（「请基于已交付版本继续修改：」）+ `@`。
  - selections：**`package_members` 显式选择**（specified arm），成员版本取自工作区 `focusPackage.projections.delivered` 的当前 Server 事实——而非 `package_projection` delivered 指针。
  - **为什么不用 delivered 指针**（实施实证，切片 4 特征化测试锁定）：reject-delivery 写入 changes_requested review 后，指针解析出的版本带该 reviewState，`evaluateTaskLinkedRequest` 只豁免显式选择、不豁免指针 → 发送被 `REVIEW_BASIS_BLOCKED` 拒，闭环在主场景断掉。显式 members 是「用户有意识钉旧 basis」的既有豁免语义（「基于此修改」同款），且语义更精确：钉死审核者眼前看到的版本，预填→发送之间若有新交付也不漂移（指针反而会漂移到新版本，违背 AC6）。
  - delivered 投影 not_ready（成员缺失无法枚举）时：预填不带 selections、仅意图文案，用户可手动添加引用。
- 版本在发送时冻结为具体 artifactVersionId，后续 current/final 漂移不影响（AC7）。
- 新 revision/attempt 已由 #1177 的 reject-delivery 命令产生，本入口不重复语义。

### 2.4 Composer 策略展示
- thread composer 引用 chips 已渲染 selections 并带 POLICY_LABELS（delivered/current/final）+「包内显式选择」（specified/package_members arm）。无需新标签——specified 走 package_members arm，合同与 chips 已支持。
- 新增一行冻结提示：thread composer 存在 selections 时显示「发送时将按策略冻结为具体版本，冻结后不随后续更新漂移」（纯展示，data-smoke 锚点）。

### 2.5 与 #1174 对齐
Files 的「引用以修改/基于此修改」入口落主 composer（onAddReference），本切片不改 Files；两处消费同一 Server 事实（四投影 + 水位）已成立。

## 3. Server 改动（apps/server-next）

**零功能改动。** 仅补集成测试（见 §5）。实施时若发现以下任一点不成立才回到设计：
- thread composer 发送路径已携带 selections（page.tsx:1811 区域）且 Server 对 thread 消息同样走冻结管线；
- `task:stage-delivery-review-workspace` 投影的 availableActions 足以推导 2.3 可见条件。

## 4. 合同改动（packages/contracts）

**零改动。** selections DTO（ProjectReferenceSelectionRequestDto）、四策略、specified arm、workspace DTO 全部现成。

## 5. 测试设计

### Server 集成测试（apps/server-next/tests/，memory+sqlite 双后端）
新增 `stage-handoff-reference-freeze.test.ts`（或并入现有 task-linked-request 测试族）：
1. 阶段交接消息发送 → referenceSet 冻结具体 artifactVersionId，可从消息追溯（AC4）。
2. 冻结后移动 current/final → 历史消息 referenceSet 不变（AC7）。
3. stage fence / collection revision 在 Offer 与 acceptance 之间变化 → acceptance 拒绝（TASK_CLAIM_*_STALE），零部分写（AC8）。
4. 归档频道 / 无权限 / 引用不可见 / consistency 未追上 → 结构化拒绝码（AC9）。
5. reject-delivery 后新 attempt 的交接消息引用 delivered basis → 冻结的是旧交付版本，旧 delivery/review 保留（AC6）。
6. 新 delivery 发布 → delivery-overview / output-package / 消息 referenceSet 三处读回一致（AC10）。

多数用例在 #1064/#1177 测试中已有近邻，新测试聚焦「阶段工作区交接路径」的组合。

### Web 测试（apps/web-next/tests/，vitest+RTL+jsdom）
对标 `stage-delivery-review-workspace.test.tsx` 与 `task-delegate-prefill.test.ts`：
1. 三入口点击后：thread 打开、URL 含 thread+stage+task、预填 text/selections 正确、焦点在 composer；断言无 `message:send` 等 socket emit（AC1/AC2/AC3）。
2. 「要求修改后继续」可见条件矩阵（changes_requested / rejected / 终态 / 归档）。
3. 冻结提示行在含 selections 时渲染。
4. 发送失败（结构化拒绝码）时错误态展示且预填不丢。
5. 刷新后 task/stage/thread 关联保持（首帧 renderToString 断言路由派生态）。

### 浏览器 smoke（手动，收尾前）
Tasks → 阶段详情 → 要求修改 → 要求修改后继续 → Thread 预填 → 发送 → Agent 接受 → 新交付 → 回 Tasks 验收。生产链路验证另起，不在本任务内。

## 6. 兼容与回滚

- 纯 web-next 前端改动 + server 测试，无合同/DB 变更，回滚 = revert。
- 旧 daemon/旧 web 不受影响（无 socket 合同变化）。

## 7. 显式不做（对齐 issue 非目标）

- 不以 URL 参数为 authority（compose 参数只是预填载体，Server 发送时全量复验）。
- 不改 Thread 消息模型、不新增 Project 容器、不复制 Files 资产浏览。
- 不接线 `project:package-review-updated` socket 事件（合同已声明但未接线；三处一致靠共享事实+水位+现有失效订阅，本切片不依赖推送）。

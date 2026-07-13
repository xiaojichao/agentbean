# AgentBean Phase 2：Task DAG 与团队认领实施计划

- 日期：2026-07-13
- 状态：待评审
- 上游设计：`docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md` §10-12、§14-19、§21 Phase 2
- 产品合同：`docs/superpowers/specs/2026-05-09-agentbean-prd.md`
- 任务线程合同：`docs/superpowers/specs/2026-07-08-agent-task-thread-claim-prd.md`
- 前置条件：Phase 1 已随 PR #528 合并，merge commit `81af73ae736bbfc49aa36a6daf0284a80dd7b7f2`；main CI/CD run `29248263193`（含 Railway deploy 与 production smoke）成功；Node 24 三平台 SEA run `29248263192` 成功；验证矩阵为 `agentbean-next/docs/phase-1-device-hosted-pi-manager-verification-matrix.md`

## 1. 目标

Phase 2 在 Phase 1 单 Agent managed 调用骨架上交付一条有限、可恢复、可验收的多 Agent 协作闭环：

1. 用户从显式 Task 入口启动一个 `managementPhase = 2` 的 `ManagementRun`。
2. PI Manager 把根任务拆成有限深度、无环且有明确验收条件的子任务 DAG。
3. 子任务可以定向分配，也可以按显式 capability 发布给 Team 内可见、在线且可执行的外部 Agent 认领。
4. Server 以原子 claim lease 保证一个 Task attempt 最多只有一个执行者；认领成功前不创建 Invocation 或 Dispatch。
5. 外部 Agent 交付结构化结果和 evidence locator；Server 解析事实源、生成 canonical snapshot 与 hash，再持久化 `SubtaskDelivery`。
6. PI Manager 只能基于当前 Task revision、attempt、claim lease、delivery 与完整验收条件提交 `SubtaskAcceptance`。
7. 被接受的子任务进入 `done`；拒绝、超时或失败通过显式 revision/attempt 重开、重试或重派，旧结果不能覆盖新状态。
8. 全部依赖闭合后，PI Manager 只基于已接受的外部结果生成根任务汇总；根任务进入 `in_review`，仍由用户明确确认后进入 `done`。

Phase 2 完成代表 Task DAG、团队认领、子任务验收与根任务汇总可按 Team 灰度启用，不代表跨 Agent Memory、Server-hosted Manager Worker、跨 Device 接管或自包含 Device 安装器已经完成。

## 2. 第一性原理约束

### 2.1 Task revision 是并发事实，不是展示时间

Phase 1 暂时把 `Task.updatedAt` 用作单 Agent Invocation 的 revision。Phase 2 存在并发认领、补充要求、重派、late result 和验收，必须引入从 1 开始单调递增的整数 `taskRevision`：

- 影响 objective、acceptance criteria、dependency、claim policy 或 assignee 的语义变化必须递增 revision。
- Task status、revision、coordination record、claim invalidation 与 typed event 必须在同一事务提交。
- 旧 revision 的 claim、Invocation、delivery、acceptance 和 checkpoint hint 全部失效。
- `updatedAt` 只用于排序和展示，不再承担 optimistic concurrency contract。

### 2.2 Claim 是执行前授权，不是执行后的归因

开放认领不能复用“多个 Agent 都先执行，最先返回者算成功”的竞速模式：

- Broker 只发布结构化 offer，不触发模型或外部工具执行。
- Server 原子确认唯一 winner 并发出 Task Claim Lease。
- 只有当前 lease holder 才能创建与该 Task attempt 绑定的 Invocation。
- 认领失败、lease 过期或 fencing stale 的 Agent 必须停止，不能产生 Dispatch、Artifact 或交付消息。
- Phase 1 的 message Dispatch claim quiet-window 是消息批处理协议，不作为 Phase 2 Task claim 的事实源；Phase 2 使用独立协议和持久化 lease。

### 2.3 DAG 正确性由 Server 保证

PI 只能提出分解和依赖命令，不能自己宣称图合法。Server 在事务中保证：

- 最大深度 3；单父节点最多 8 个直接子任务；每个 Run 最多 20 个未完成子任务。
- dependency 必须位于同一 ManagementRun，且不能形成自环或有向环。
- 未完成或未被接受的 dependency 会阻止 publish/assign/invoke。
- 同一个 Agent 不能通过管理 Agent 把任务循环委派回当前祖先节点。
- 超限、成环或预算不足时 fail closed，由 PI 合并任务、缩小范围或请求用户输入。

### 2.4 证据必须绑定稳定事实快照

Agent 提交的是 evidence locator，不是可信 digest。Server 必须：

1. 在 Task Team、channel、Invocation 和可见性边界内解析 locator。
2. 对 Message、Artifact、Workspace Run、Invocation 或 Task 生成 canonical snapshot。
3. 由 Server 计算 `snapshotHash`、记录 revision 和 `capturedAt`。
4. 在验收时重新校验归属、可见性和 snapshot 是否漂移。

缺少必需证据、来源不可见、快照漂移、结果冲突或高风险判断只能得到 `rejected` / `needs_human`，不能进入 `done`。

### 2.5 Phase 2 是显式 rollout，不是自动升级

现有 `managed` Team 和历史 Run 默认保持 Phase 1 行为：

- Team policy 增加 `maxManagementPhase: 1 | 2`，迁移默认值为 `1`。
- 新 Run 固化精确的 `managementPhase`；Run 创建后不可修改。
- 只有 owner/admin 显式把 Team 提升到 Phase 2，且 Worker、协议、凭证、预算、Task 入口和候选 Agent 预检全部 Green，才允许创建 Phase 2 Run。
- Phase 2 runtime 只暴露 Phase 1 + Phase 2 exact tool set；Phase 3/4 tools、coding tools 和 cwd resources 继续不可见。
- 任一 Phase 2 预检失败时不越过 managed barrier；越过后只能恢复、等待、重试受控 attempt 或审计失败，不能回退 direct。

## 3. 当前事实与结构缺口

### 3.1 可复用能力

- Phase 1 已有 `ManagementRun`、Manager Lease、typed Event、checkpoint、immutable Invocation、Dispatch attempt、Device Worker transport、durable outbox 和 fencing。
- `packages/contracts/src/task-coordination.ts` 已冻结 `TaskCoordinationDto`、`AcceptanceCriterionDto`、`EvidenceRefDto`、`SubtaskDeliveryV1` 与 `SubtaskAcceptanceV1` vocabulary。
- `packages/contracts/src/management-event.ts` 已声明 Phase 2 Task event types，但 writer 尚未接入。
- `packages/pi-management-runtime` catalog 已标注 8 个 Phase 2 Task tools，但 Session 仍固定只暴露 Phase 1 allowlist。
- `apps/server-next/src/application/management/management-tool-executor.ts` 已有统一 lease/fencing write authority seam。
- Server 已有 Agent 可见性、在线状态、skills、Dispatch、Artifact 和 Workspace Run 事实源。
- Phase 1 root Task 流程已验证“管理交付后 `in_review`，用户确认后 `done`”。

### 3.2 必须补齐的缺口

1. `TaskDto` 没有整数 revision，`TaskRepository.update()` 也没有 expected revision conflict。
2. `tasks` 表没有 coordination、dependency、claim lease、delivery、acceptance 或 evidence snapshot persistence。
3. `ManagementRun`、Team policy、Worker capability 和 Session context 都没有显式 Phase 2 协商字段。
4. Session context 强制要求 `frozenTarget`，无法表达由 Manager 分解后再选择/认领 Agent 的 Run。
5. 8 个 Phase 2 tools 只有 metadata，没有 AgentBean-owned typed input/output、worker protocol 或 Server handler。
6. 当前 `agents.list_capabilities` 只返回 Phase 1 frozen target；没有 Team 范围内经权限过滤的候选目录。
7. 没有 Task DAG domain validator、claim broker、Task claim transport 或 lease expiry/reopen scheduler。
8. Invocation Gateway 尚未强制核对当前 Task revision、attempt、claim lease 和 dependency results。
9. 外部 Agent completion 仍以 Message/Dispatch 结果为主，没有 canonical delivery/evidence/acceptance transaction。
10. Web Task 页面没有 DAG、claim、attempt、evidence 与子任务结果入口。

## 4. 范围边界

### 4.1 Phase 2 必须交付

- Versioned Phase 2 Run、policy、Worker、Session context 与 management tool contracts。
- Phase-aware exact tool allowlist：Phase 2 = Phase 1 tools + 8 个 Task tools。
- Task integer revision、coordination fields、dependencies、claim leases、deliveries、acceptances 与 evidence snapshots。
- DAG 深度、fan-out、未完成节点、Invocation 数和循环依赖 Domain rules。
- 原子 Task create/revise/dependency/publish/claim/expire/deliver/accept/retry/reassign commands。
- Team Agent capability resolver、开放认领 Broker 和定向 assign。
- claim 成功后才创建 Invocation/Dispatch，且 intent 固化 Task revision/attempt/claim lease/dependency results。
- Server-owned evidence snapshot 与 fail-closed acceptance。
- Worker restart、Manager lease 接管和 checkpoint replay 后继续同一 Task graph。
- 根 Task 汇总、`in_review` 与用户审核闭环。
- 最小 Web Task DAG/claim/attempt/result surface，以及折叠的 management status。
- 独立 Phase 2 验收矩阵、root scripts、CI gate、真实双 Agent Device smoke 与 closeout evidence。

### 4.2 Phase 2 明确不做

- 不实现 Cross-Agent Memory、Memory Capsule 或 Memory Candidate；这些属于 Phase 3。
- 不实现 Server-hosted Manager Worker、`auto` placement、跨 host/跨 Device 自动接管；这些属于 Phase 4。
- 不制作 launchd/systemd/Windows Service 安装器，不迁移旧 Daemon；这些属于 Phase 5。
- 不让 PI 使用 coding tools、shell、cwd、任意网络或直接修改 repository。
- 不让 Agent 自报 capability 自动扩大权限；历史成功只能参与排序，不能成为授权依据。
- 不自动把普通消息猜成复杂 Task；Phase 2 只从显式 Task/rootTaskId 入口启动。
- 不新增 Task 状态枚举；继续使用 `todo`、`in_progress`、`in_review`、`done`、`closed`。
- 不改变根任务必须由用户审核的规则，不让 Manager 自动完成根任务。
- 不升级到 Node 26；安装、原生依赖、测试、构建、生产与 SEA 全部统一使用 Node 24。

## 5. 核心决策

### 5.1 Versioned contract 保留 Phase 1 兼容性

- 现有 schema/protocol V1 继续代表 Phase 1，不原地改变其 exact-key 语义。
- 新增 V2 Run/Worker/Session/tool contract，显式携带 `managementPhase`。
- V1 Run 读取时固定解释为 Phase 1；历史记录不回填为 Phase 2。
- Worker 注册报告精确 `supportedPhases` 和 protocol versions；Scheduler 为 Run 选择同时支持该 phase 的 Worker。
- Phase 2 Session context 中 `frozenTarget` 可缺省；定向子任务的 target 存在 Task coordination/claim 与 Invocation intent 中，不成为整个 Run 的永久目标。
- 每次 Session 创建、恢复和 model call 前都执行 effective tool exact-set equality。

### 5.2 Task 基础表与 coordination 事实分离

`tasks` 继续保存用户可见 Task 基础字段，并增加整数 `revision`。Phase 2 管理字段进入独立表，避免普通 Task 被 nullable DAG 列污染：

- `task_coordinations`：Run、root/parent、node kind、review/claim policy、attempt/max attempts、当前 revision。
- `task_acceptance_criteria`：稳定 criterion ID、顺序、evidence requirement 和 allowed kinds。
- `task_dependencies`：`task_id -> dependency_task_id` 唯一边。
- `task_claim_leases`：Task revision/attempt、agent、token hash/fingerprint、fencing、expiry/release。
- `subtask_deliveries` 与 `subtask_delivery_claims`。
- `evidence_snapshots` 与 delivery/acceptance refs。
- `subtask_acceptances` 与 per-criterion results。

所有表位于现有 team DB。Task 业务写入、coordination 写入和 Management Event append 使用同一 SQLite transaction/UoW；memory repository 必须提供同样的 all-or-nothing 测试语义。

### 5.3 Revision 与 criterion identity

- 创建 Task 时 `revision = 1`。
- 只改变非语义展示字段时不递增 coordination revision；改变目标、criteria、dependency、claim policy、assignee 或执行边界时递增。
- 语义未变化的 criterion 保持 ID；修改语义创建新 ID；删除后的 ID 永不复用。
- revision 递增时原子 append `task-revised` 与必要的 `claim-invalidated`，取消/隔离旧 active Invocation。
- late result 可以保留为历史证据，但不能满足新 revision 的验收条件。

### 5.4 Task Claim Broker

Broker 候选集由 Server 事实产生：

1. 当前 Team 可见且未删除的外部 Agent。
2. Runtime/Device 在线，Agent 非 busy。
3. 显式配置 capability/skill 满足 `requiredCapabilities`。
4. Agent 对 Task channel、附件和依赖结果具有访问权限。
5. 不违反祖先 Agent 循环委派规则。

开放认领使用独立 socket contract：offer、claim、claim-ack、renew/release/expire。offer 不包含不可见正文或短期附件 token；winner 取得 lease 后才获得最小 Task execution snapshot。定向 assign 仍创建同一 lease，只是候选集固定为一个 Agent。

claim lease raw token 只发给 winner，Server 只存 hash/fingerprint；每个 delivery、retry 和 Invocation create 都校验 token、fencing、Task revision 与 attempt。

### 5.5 Dependency readiness 与 Invocation

- Task 只有在全部 dependency 已被当前 acceptance 接受并处于 `done` 时才可 publish/assign。
- Server 从 canonical delivery/acceptance 生成 `DependencyResultRefDto`，PI 不能自由拼装依赖结果。
- `agents.invoke` 对 Phase 2 Task 要求当前 claim authority；Gateway 在创建 intent/Dispatch 的同一事务重新核对 Task revision、attempt、lease、assignee、deadline 和 dependency snapshot。
- 一个 Task attempt 只允许一个 active Invocation；受控 retry 必须先把旧 attempt 推进到 canonical terminal，再增加 Task attempt 或 Invocation attempt。

### 5.6 Delivery、Evidence 与 Acceptance

Phase 2 增加独立 delivery command，不从自由文本或“Dispatch succeeded”推断子任务完成：

- 外部 Agent result 仍归实际 Agent，并保留原始 Message、Artifact、Workspace Run。
- delivery 引用当前 Invocation，并提交 summary、claims 和 evidence locators。
- Server 在单事务中解析 locator、保存 canonical evidence snapshot、写 delivery、把 Task 推进 `in_review` 并 append `subtask-delivered`。
- `tasks.accept_subtask` 逐 criterion 校验；全部必需 criterion 通过且 evidence 未漂移时才接受。
- `accepted` 使子任务 `done`；`rejected` 进入显式 revise/retry 流程；`needs_human` 让 Run 进入 `waiting_for_user`，不得伪装完成。

### 5.7 重开、重试、重派与根汇总

- 同 objective/criteria 的传输型失败可以受控 retry，Task revision 不变、attempt 递增。
- objective、criteria、dependency 或执行边界变化必须 revise，revision 递增、attempt 重置为 1。
- open claim lease 过期后可重新发布；targeted Agent 掉线遵循 grace period，之后只能在授权条件下重派。
- 达到 `maxAttempts`、无候选 Agent、证据冲突或预算耗尽时进入 `waiting_for_user` / blocked，不无限循环。
- 根汇总只读取被当前 acceptance 接受的 delivery 和稳定 evidence；贡献 Invocation IDs 必须完整可追溯。
- 根任务只进入 `in_review`；用户确认后才 `done`，用户拒绝则创建修订子任务，不覆盖历史结果。

### 5.8 用户可见形态

- Task 详情展示根节点、子任务层级、依赖、assignee、claim 状态、attempt、验收状态和原始结果入口。
- 默认只展开当前/阻塞节点；Management event 在任务线程折叠展示，不刷主频道。
- 外部 Agent 的回复和 Artifact 始终显示真实 Agent 归属；PI 汇总保持 system `management-delivery`。
- 用户可以审核根任务，也可以展开子任务证据；Phase 2 首版不提供任意拖拽改 DAG，避免绕过 Server revision contract。

## 6. 验收矩阵

Phase 2 从第一项实现开始维护：`agentbean-next/docs/phase-2-task-dag-team-claim-verification-matrix.md`。

| ID | 验收项 | 必需证据 |
|---|---|---|
| P2-01 | V1 Phase 1 行为兼容；V2 Run/Worker/Session 显式协商 Phase 2 | contract fixtures、protocol negotiation tests |
| P2-02 | Phase 2 exact tools = Phase 1 + 8 Task tools，无 Phase 3/4/coding/cwd | snapshots、runtime negative tests、declaration scan |
| P2-03 | Team 默认 `maxManagementPhase=1`，Phase 2 仅 owner/admin 显式启用 | migration、policy/auth tests、Web tests |
| P2-04 | Task integer revision 与 coordination 状态原子且 optimistic conflict 正确 | Domain、UoW、SQLite rollback tests |
| P2-05 | DAG 无环、深度/fan-out/open-node/budget 限制 fail closed | table/property tests |
| P2-06 | criterion identity、revision invalidation 与 late result 隔离正确 | revision matrix、event assertions |
| P2-07 | capability resolver 不扩大权限，只返回可见在线匹配 Agent | visibility/capability tests |
| P2-08 | open/targeted claim 只有一个 winner，认领前 zero Invocation/Dispatch | concurrency/socket tests |
| P2-09 | claim renew/expire/reopen、stale token/fencing 与 disconnect 正确 | fake clock、reconnect tests |
| P2-10 | dependency 未闭合不能执行，依赖结果由 Server canonical refs 派生 | Domain/gateway tests |
| P2-11 | Task attempt 只产生一个 active Invocation，重试/重派不重复执行 | repository/gateway/integration tests |
| P2-12 | delivery 绑定当前 revision/attempt/lease/Invocation | conflict and idempotency tests |
| P2-13 | evidence snapshot 由 Server 生成，权限/缺失/漂移时 fail closed | source resolver、hash、visibility tests |
| P2-14 | manager acceptance 完整覆盖 criteria；高风险/冲突进入 human review | acceptance table tests |
| P2-15 | Worker restart/lease 接管按 event/checkpoint 恢复同一 DAG | recovery/replay tests |
| P2-16 | 双 Agent 子任务并行完成、依赖闭合、根汇总后进入 `in_review` | real Device E2E |
| P2-17 | Task DAG/claim/result Web surface 与实时订阅正确 | component/browser smoke |
| P2-18 | Phase 1/direct/shadow、build、Node 24 SEA、CI/CD 与生产 smoke 不回归 | retained gates、main URLs |

P2-01 至 P2-18 全部 Green，且 Phase 2 默认仍关闭，才允许 Phase 2 closeout。没有任意天数观察期。

## 7. 实施任务

### Task 1：建立 Phase 2 matrix 与静态门禁

**Files**

- Create: `agentbean-next/docs/phase-2-task-dag-team-claim-verification-matrix.md`
- Create: `scripts/check-phase-2-task-dag-boundary.mjs`
- Create: `scripts/check-phase-2-task-dag-boundary.test.mjs`
- Modify: `package.json`
- Modify: `scripts/check-agentbean-next-readiness.mjs`
- Modify: `apps/server-next/tests/readiness-check.test.ts`

**Acceptance**

1. matrix 初始全部 Red/Not implemented，不预写 Green。
2. checker 固定 Phase 2 version/phase 字段、table/event/tool/socket surface 与 Node 24 gate。
3. root 暴露 `test:phase2-task-dag-boundary` 与 `check:phase2-task-dag-boundary`。
4. Phase 1 exact tool snapshot、direct/shadow 规则和 no coding tools 继续保留。

### Task 2：冻结 V2 contracts 与 phase-aware runtime

**Files**

- Modify/Create: `packages/contracts/src/{management,management-worker,task,task-coordination,management-event,invocation}.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify/Create: `packages/contracts/tests/*management*`
- Modify: `packages/pi-management-runtime/src/{types,management-tool-catalog,pi-session-adapter}.ts`
- Modify/Create: `packages/pi-management-runtime/tests/*`
- Modify: `apps/daemon-next/src/management-worker-protocol.ts`

**TDD / Acceptance**

1. V1 fixtures 不变；V2 显式携带 `managementPhase`、可选 Run target 和 supported phases。
2. Phase 2 exact allowlist 只增加 8 个 Task tools；shadow write executor 仍无副作用。
3. 为 8 个 tools 定义 AgentBean-owned exact-key input/output，不透传 PI types 或任意 JSON。
4. old Server/new Worker、new Server/old Worker 协商失败时明确 unavailable，不降级错跑 Phase 2。

### Task 3：实现 Task DAG、revision 与 claim Domain rules

**Files**

- Create: `packages/domain/src/task-dag-policy.ts`
- Create: `packages/domain/src/task-revision-policy.ts`
- Create: `packages/domain/src/task-claim-policy.ts`
- Create: `packages/domain/src/subtask-acceptance-policy.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/tests/{task-dag,task-revision,task-claim,subtask-acceptance}-policy.test.ts`

**TDD**

- 无环、最大深度、fan-out、open-node 和 Invocation budget table/property tests。
- criterion stable ID、semantic change、新 revision 与 stale authority matrix。
- claim acquire/renew/expire/reopen、winner concurrency、ancestor-agent loop rejection。
- accepted/rejected/needs_human 的 criteria/evidence 决策表。

### Task 4：实现 Phase 2 schema、repositories 与 coordination UoW

**Files**

- Create: `apps/server-next/src/infra/sqlite/migrations/team/0013_management_phase_2_task_dag.sql`
- Create: `apps/server-next/src/application/task-coordination-repositories.ts`
- Create: `apps/server-next/src/application/task-coordination-unit-of-work.ts`
- Create: `apps/server-next/src/infra/{memory,sqlite}/task-coordination-repositories.ts`
- Modify: `apps/server-next/src/application/repositories.ts`
- Modify: `apps/server-next/src/infra/{memory,sqlite}/repositories.ts`
- Modify/Create: `apps/server-next/tests/{sqlite-repositories,task-coordination-unit-of-work}.test.ts`

**Required constraints**

- integer Task revision；unique Task coordination；unique dependency edge。
- current claim 每个 Task revision/attempt 最多一个；token 只存 hash/fingerprint。
- delivery idempotency；一个 delivery 只能有一个 canonical acceptance decision version。
- evidence snapshot 和 refs 归属同 Team/Task/Invocation。
- SQLite migration + ledger 同事务；旧数据库升级、重复 apply、failure rollback 全覆盖。

### Task 5：实现 Task Coordination Kernel 与 DAG commands

**Files**

- Create: `apps/server-next/src/application/management/task-coordination-kernel.ts`
- Create: `apps/server-next/tests/task-coordination-kernel.test.ts`
- Modify: `apps/server-next/src/application/management/management-kernel.ts`
- Modify: `apps/server-next/src/application/management/management-event-validator.ts`

**Commands**

- create root coordination / create subtasks。
- add dependency / revise task / invalidate claim。
- publish for claim / targeted assign。
- transition state with expected revision。

每个成功 command 必须在同一事务 append exact typed event；same idempotency key/same hash 返回原结果，same key/different hash conflict。

### Task 6：实现 capability resolver、Task Claim Broker 与 transport

**Files**

- Create: `apps/server-next/src/application/management/task-claim-broker.ts`
- Modify: `apps/server-next/src/transport/{socket-handlers,socket-server}.ts`
- Modify: `packages/contracts/src/socket.ts`
- Modify: `apps/daemon-next/src/{device-service-core,management-worker-protocol,index}.ts`
- Create: `apps/server-next/tests/task-claim-broker.test.ts`
- Create/Modify: `apps/server-next/tests/management-socket-integration.test.ts`
- Create: `apps/daemon-next/tests/task-claim-protocol.test.ts`

**Acceptance**

- capability/visibility/readiness filter 有明确 diagnostics。
- offer 不启动 execution；并发 claim 只有一个 ack success。
- winner 取得最小 execution snapshot 和 claim lease；loser zero Dispatch。
- renew/release/expire/disconnect/reconnect 使用 fake clock 可复现。

### Task 7：接通 Phase 2 tools、Worker recovery 与 checkpoint

**Files**

- Modify: `apps/server-next/src/application/management/management-tool-executor.ts`
- Modify: `apps/server-next/src/application/management/management-checkpoint.ts`
- Modify: `apps/daemon-next/src/pi-manager-worker-host.ts`
- Modify/Create: `apps/{server-next,daemon-next}/tests/*management*`

**Acceptance**

- 8 个 Task tools 全部走 coordination kernel，不直接串普通 repositories。
- `tasks.wait` 从 Server events/state 读取，不依赖模型记忆或本地计时猜测。
- checkpoint authoritative task graph 与当前 revision/claim/invocation sets 同 snapshot。
- Worker restart/Manager lease 接管后恢复同一个 Run/DAG，不重建子任务或 claim。

### Task 8：把 claim authority 接入 Invocation Gateway

**Files**

- Modify: `apps/server-next/src/application/management/invocation-gateway.ts`
- Modify: `apps/server-next/src/application/management/management-tool-executor.ts`
- Modify/Create: `apps/server-next/tests/{invocation-gateway,management-dispatch-lifecycle}.test.ts`

**TDD**

1. Task Invocation 必须绑定当前 Task revision、attempt 和 claim lease。
2. target 必须等于 claim holder；dependency refs 由 Server 生成。
3. 同 Task attempt 不能创建第二个 active Invocation/Dispatch。
4. stale lease/revision、未闭合 dependency、过期 deadline 和越权附件 fail closed。
5. Phase 1 frozen-target Invocation 与 direct Dispatch 全量回归。

### Task 9：实现 delivery、evidence snapshot 与 manager acceptance

**Files**

- Create: `apps/server-next/src/application/management/evidence-snapshot-service.ts`
- Create: `apps/server-next/src/application/management/subtask-delivery-service.ts`
- Create: `apps/server-next/src/application/management/subtask-acceptance-service.ts`
- Modify: `apps/server-next/src/application/management/management-tool-executor.ts`
- Create: `apps/server-next/tests/{evidence-snapshot,subtask-delivery,subtask-acceptance}.test.ts`

**Acceptance**

- 只接受当前 succeeded Invocation 的 delivery，幂等且与 Task authority 完整绑定。
- Message/Artifact/Workspace Run/Invocation/Task resolver 做 Team、channel 和可见性校验。
- Server canonicalize + hash；客户端 digest 被忽略/拒绝。
- criterion 全量覆盖、allowed kind、snapshot drift、高风险与冲突规则 fail closed。

### Task 10：实现 retry、reopen、reassign 与根任务汇总

**Files**

- Modify: `apps/server-next/src/application/management/task-coordination-kernel.ts`
- Modify: `apps/server-next/src/application/management/management-tool-executor.ts`
- Modify: `apps/server-next/src/application/usecases.ts`
- Create: `apps/server-next/tests/managed-multi-agent.test.ts`

**E2E logic**

- 失败 attempt 受控 retry；revision 变化使旧 authority stale。
- claim expiry/open reopen；targeted grace period/reassign。
- max attempts、无候选、预算耗尽和冲突结果进入 `waiting_for_user`。
- 全部 leaf acceptance + dependency closure 后才能 `review.submit_root_delivery`。
- 根 Task `in_review` → human done；拒绝创建 revision，不覆盖历史。

### Task 11：Phase 2 rollout policy 与最小 Web DAG surface

**Files**

- Modify: `apps/server-next/src/application/management/management-router.ts`
- Modify: `apps/server-next/src/application/usecases.ts`
- Modify: `apps/web-next/app/[teamPath]/settings/ManagementPolicyPanel.tsx`
- Modify: `apps/web-next/app/[teamPath]/tasks/page.tsx`
- Create: `apps/web-next/components/TaskDagPanel.tsx`
- Modify/Create: `apps/web-next/tests/*task*`
- Modify: browser smoke fixture

**Acceptance**

- policy 默认 phase 1；owner/admin 才能显式启用 phase 2。
- Phase 2 只接受显式 Task/rootTaskId；preflight 未过时不创建 Run。
- Task 详情显示 DAG、dependency、claim/assignee、attempt、验收和原始结果入口。
- realtime revision guard 防止晚到 snapshot 覆盖新状态；management events 默认折叠。

### Task 12：真实双 Agent 垂直链路、CI integration 与 closeout

**Files**

- Modify: `package.json`
- Modify: `.github/workflows/ci-cd.yml`
- Modify: `scripts/check-agentbean-next-readiness.mjs`
- Modify: `agentbean-next/docs/phase-2-task-dag-team-claim-verification-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`（只回链实际 verdict）
- Modify: `README.md`（只在实际可用后补受控入口）

**Root gates**

- `test:phase2-task-dag`
- `build:phase2-task-dag`
- `check:phase2-task-dag-boundary`
- 保留 `test:phase1-management`、`build:phase1-management`、`test:phase0`、`build:phase0`、`test:phase1` 与 `build:packages`。

**Closeout evidence**

- 两个真实 custom Agent：一个 open claim，一个 targeted/dependency task；one claim winner → one Invocation → one Dispatch。
- 并发 claim loser zero execution；disconnect/expiry/reopen/reassign 不重复执行。
- delivery/evidence/acceptance、revision stale、late result、conflict 与 human review 证据。
- Worker restart/checkpoint replay 后继续同一 DAG。
- Web DAG/browser smoke；Phase 1/direct/shadow 全量回归。
- Node 24 clean install、`better-sqlite3` load、build/runtime 与三平台 SEA。
- 合并后 main CI/CD、Railway deploy、production business smoke URL。

## 8. PR 切片与依赖

| 顺序 | PR | 内容 | 前置 |
|---|---|---|---|
| 0 | 本计划 | Phase 2 边界、任务、矩阵合同 | Phase 1 complete |
| 1 | Gates + contracts | Task 1-2：matrix、V2 contracts、phase-aware runtime | 计划已评审 |
| 2 | Domain rules | Task 3：DAG/revision/claim/acceptance policies | PR 1 vocabulary |
| 3 | Atomic persistence | Task 4：schema、repositories、coordination UoW | PR 1-2 |
| 4 | Coordination kernel | Task 5：Task/DAG/revision commands + events | PR 3 |
| 5 | Claim broker | Task 6：capability resolver、claim lease、transport | PR 2 + PR 4 |
| 6 | Worker/task tools | Task 7：Phase 2 executor、checkpoint、recovery | PR 1 + PR 4-5 |
| 7 | Invocation authority | Task 8：claim/dependency → Invocation/Dispatch | PR 5-6 |
| 8 | Delivery/acceptance | Task 9：evidence snapshot、delivery、criteria verdict | PR 3-4 + PR 7 |
| 9 | Multi-Agent lifecycle | Task 10：retry/reassign/root aggregation E2E | PR 8 |
| 10 | Rollout + Web | Task 11：policy gate、DAG/detail surface | PR 9 |
| 11 | CI/verification closeout | Task 12：真实双 Agent、root gate、生产证据 | PR 10 main CI |

每个实现 PR 必须有独立 Issue、中文 GitHub 内容和小而完整的验收面。不得在 revision/UoW 未合入前启用 claim，不得在 claim authority 未接入 Gateway 前触发 Phase 2 外部执行。

## 9. 验证命令

所有命令使用 `.nvmrc` 指定的 Node 24：

```bash
nvm use
npm ci
npm run test:phase2-task-dag-boundary
npm run check:phase2-task-dag-boundary
npm run test:pi-management-runtime
npm run test:contracts
npm run test:domain
npm run test:server-next
npm run test:daemon-next
npm run test:web-next
npm run test:phase2-task-dag
npm run build:contracts
npm run build:domain
npm run build:pi-management-runtime
npm run build:server-next
npm run build:daemon-next
npm run build:web-next
npm run build:phase2-task-dag
npm run test:phase1-management
npm run build:phase1-management
npm run test:phase0
npm run build:phase0
npm run test:phase1
npm run build:packages
npm run smoke:agentbean-next-browser
npm run check:agentbean-next-readiness
```

实现 PR 根据改动范围先跑 targeted tests，再跑 Local Verification Contract 要求的 matching build；closeout 才跑完整矩阵。不得使用 Node 26 生成或验证 `better-sqlite3` 相关结果。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `updatedAt` 继续被当并发 revision，造成 stale write | 独立整数 revision + expected revision UoW + conflict tests |
| 多 Agent 在 claim 前同时执行 | 独立 claim offer/ack；winner 前 zero Invocation/Dispatch assertion |
| Phase 1 managed Team 被静默升级 | policy 默认 max phase 1；Run 固化 phase；V2 协商 fail closed |
| PI 创建循环/爆炸 DAG | Server cycle/depth/fan-out/open-node/budget validator |
| capability 自动推断扩大权限 | 只有显式配置参与 eligibility，历史信号只排序 |
| 旧 claim/Invocation late result 覆盖新 revision | revision/attempt/lease 全链绑定；late result 仅历史证据 |
| 外部 Agent 伪造 evidence hash | Server resolve/canonicalize/hash；验收时重检 snapshot |
| delivery/acceptance 与 Task 状态部分成功 | coordination UoW + SQLite transaction + failure injection |
| Manager 自动完成根 Task | root 固定 human review，Server 状态机拒绝 manager done |
| 重试/重派制造重复副作用 | 一个 Task attempt 一个 active Invocation；canonical terminal 后才能推进 |
| DAG UI 晚到 snapshot 回退 | integer revision/sequence guard + realtime merge tests |
| Phase 2 膨胀成 Memory/Worker/Installer 大项目 | contracts 和 checker 明确阻止 Phase 3-5 surface 进入 |

## 11. 回滚与数据策略

- Phase 2 policy 可以停止创建新 Run；已有 Run 只能继续、等待、取消或审计失败，不能删除后改走 direct。
- 所有 schema 使用 additive migration；回滚代码不得删除 Task coordination、claim、delivery、acceptance 或 evidence history。
- 回退到 Phase 1 时，V2 历史 Run 只读可见；旧 Worker 不接管 Phase 2 Run。
- 过期 claim lease 保留审计记录，不复用 lease ID/token/fencing。
- Task revision、criterion ID、delivery 和 acceptance 永不原地重写；修正通过新 revision/decision 记录表达。
- corrupt checkpoint/hints 可以丢弃重建；Task、event、Invocation、Dispatch、claim、delivery 和 acceptance Server facts 不得丢弃。

## 12. Phase 2 完成门禁

1. P2-01 至 P2-18 全部 Green 并有可复现证据。
2. 两个真实外部 Agent 完成包含 open claim、targeted task 和 dependency 的 DAG；每个 Task attempt 只有一个执行者。
3. 并发 claim、lease expiry、Agent disconnect、Worker restart、ack loss、stale revision/fencing 和 late result 全部不重复执行或覆盖新状态。
4. 所有 accepted 子任务都有完整 criteria 结果和 Server 生成、未漂移、可见的 evidence snapshot。
5. 根任务只有在全部 dependency/acceptance 闭合并提交 management delivery 后进入 `in_review`，用户确认后才完成。
6. Phase 1 managed、direct、shadow、Task thread claim、Artifact/Workspace Run 与浏览器行为不回归。
7. no coding tools / no cwd / no raw PI types / no secret persistence 全绿。
8. Node 24 clean install、`better-sqlite3`、matching builds、三平台 SEA、browser smoke、main CI/CD 与 production smoke 全绿。
9. `maxManagementPhase` 默认仍为 1；Phase 2 只对明确配置且 preflight Green 的 Team/Device 开放。
10. verification-only closeout PR 已合并。

完成后才为 Phase 3 编写 Cross-Agent Memory、Memory Capsule 与 Candidate 流程的独立实施计划。

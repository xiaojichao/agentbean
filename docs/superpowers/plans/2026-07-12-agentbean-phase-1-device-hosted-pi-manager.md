# AgentBean Phase 1：Device-hosted PI Manager 单 Agent 调用实施计划

- 日期：2026-07-12
- 状态：待评审
- 上游设计：`docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md` §7-10、§14-18、§21 Phase 1
- 产品合同：`docs/superpowers/specs/2026-05-09-agentbean-prd.md`
- 前置条件：Phase 0 已随 PR #503 合并，merge commit `c182ce1efdd446184743af8d7b8a21504be0465d`；main PI SEA run `29196310837` 成功，main CI/CD run `29196310830` attempt 2（含 deploy 与 production smoke）成功；验证矩阵为 `agentbean-next/docs/phase-0-pi-contract-compatibility-verification-matrix.md`

## 1. 目标

Phase 1 交付一条真实、可恢复、可审计且不会重复执行的单 Agent 管理调用闭环：

1. 用户在频道或 DM 中显式点名一个外部 Agent。
2. Team 已启用 `managed` 且 Device、模型凭证、目标 Agent 与预算预检通过。
3. Server 原子预留请求 idempotency、创建 `ManagementRun` 与首个 typed event，并向 Device-hosted Worker 发放带 fencing token 的 lease。
4. 内置 PI Manager 只使用 Phase 1 管理工具，创建一个 immutable `AgentInvocation`。
5. Invocation Gateway 复用现有 Dispatch 执行自定义 Agent 或 AgentOS 托管型 Agent；Dispatch 是 execution attempt 的唯一状态事实。
6. 外部 Agent 的原始回复、Artifact 与 Workspace Run 继续归属于实际执行 Agent。
7. 普通轻问答完成后直接结束 Run；显式 Task 请求提交 management delivery、进入 `in_review`，由用户确认后完成。
8. Worker 重启、Device 断线、ack 丢失或工具重试都不能产生第二次外部执行或第二条交付消息。

Phase 1 完成代表上述单 Agent managed 路径可以按 Team 灰度启用，不代表自动分解、多 Agent 协作、Cross-Agent Memory 或后台 Device Service 已完成。

## 2. 第一性原理约束

### 2.1 先保证 at-most-once intent，再开放 managed

外部 Agent 执行可能写文件、调用第三方服务或产生真实成本。只要 Worker、Socket 或 ack 可能失败，就不能把“重新发一个 Dispatch”当恢复。Phase 1 必须先建立：

- 用户请求级 managed reservation；
- immutable Invocation intent 与 intent hash；
- Invocation attempt 唯一约束；
- lease fencing；
- durable outbox；
- typed event replay 与 checkpoint 校验。

这些是单 Agent 路径的正确性骨架，不属于 Phase 2 的多 Agent 增强。

### 2.2 Run、Invocation 与 Dispatch 各自只有一种职责

- `ManagementRun`：用户请求的管理生命周期。
- `AgentInvocation`：对某个外部 Agent 的不可变逻辑调用意图。
- `Dispatch`：Invocation 的一次实际执行 attempt，也是执行状态的唯一事实。

Invocation 不维护第二套可写 status。`AgentInvocationViewDto.status` 只能从关联 Dispatch rows 派生。旧 attempt 未进入 canonical 终态时不得创建新 attempt；late result 只能更新其所属 Dispatch，不能覆盖更新 attempt。

### 2.3 普通消息与 Task 由入口决定

Phase 1 禁止让模型从自然语言猜“轻问答还是任务”：

- 普通频道/DM 消息默认不创建 Task；
- `asTask=true`、已有 root Task 或显式任务入口才是任务型请求；
- 自动任务分解、子任务、claim 和 Task DAG 属于 Phase 2。

因此同一句消息不会因模型输出变化而在“自动完成”和“等待人工审核”两套状态机之间漂移。

### 2.4 默认 direct，shadow 与 managed 都按 Team 显式启用

- 新旧 Team 默认 `direct`。
- `shadow` 继续执行原 direct 路径，只额外写 namespaced、脱敏的只读决策记录；不得创建 ManagementRun、Invocation、管理消息、管理 Task 或 Memory。
- `managed` 只支持显式点名单 Agent 请求；未点名、多 Agent、分解请求返回能力暂不可用，不偷偷回到 direct。
- managed barrier 越过后，Worker、Provider 或工具失败只能恢复、等待用户或失败，不能创建 direct Dispatch。

shadow 验收使用 replay、一致性和零管理副作用证据，不设置任意生产观察天数。

## 3. 当前事实与结构缺口

### 3.1 可复用能力

- `packages/pi-management-runtime` 已封装真实 PI Session，具备 hermetic resource loader、23 项分阶段 tool metadata、无 coding tools 断言和 AgentBean-owned public types。
- `packages/contracts/src/{management,management-event,invocation}.ts` 已冻结 Phase 0 DTO。
- `packages/domain/src/{management-policy,invocation-policy,checkpoint-policy}.ts` 已冻结 rollout、barrier、intent idempotency 与 checkpoint 失效规则。
- `apps/server-next/src/application/usecases.ts` 已有 Message、Task、Dispatch、Artifact、Workspace Run 和外部 Agent 结果链路。
- `apps/daemon-next/src/executor.ts` 已把自定义 Agent 与 OpenClaw/Hermes adapter 收敛到现有 Dispatch executor。
- `apps/daemon-next/src/workspace-run.ts` 已有本地 manifest/reported marker 恢复模式，可供 durable outbox 借鉴。

### 3.2 必须先补齐的缺口

1. Server 没有 ManagementRun、lease、event、checkpoint、Invocation 或 shadow persistence。
2. 当前 repository 调用逐项执行，没有覆盖 managed reservation + 首次副作用的事务/UoW seam。
3. 当前 PI Session 固定暴露全部 23 个工具；Phase 1 managed 应只暴露 Phase 1 tools，shadow 的 write tools 必须改接无副作用 recorder。
4. 当前真实 provider usage、finish reason 与 response model 未接入。
5. 当前 daemon outbox 是进程内 `Map<dispatchId, ...>`，重启后丢失。
6. 当前 `auth-store.ts` 是 device token 的 `0600` 文件，不是模型凭证安全存储，禁止复用来保存 provider key。
7. 当前 Dispatch completion 会把关联 Task 直接推进到 `in_review`；managed Task 必须等待 `review.submit_root_delivery`。
8. 当前 Socket 与 Device hello 没有 PI Worker capability、lease 或 tool RPC。
9. `@agentbean/pi-management-runtime` 仍是 private `0.0.0` workspace package，不能直接成为已发布 daemon 的 npm runtime dependency。

## 4. 范围边界

### 4.1 Phase 1 必须交付

- Phase-aware PI tool allowlist、typed session context 和真实 provider telemetry。
- 可由 daemon 安装的 PI runtime packaging contract。
- Team management policy 与 managed request reservation。
- ManagementRun、ManagerLease、ManagementEvent、Checkpoint、AgentInvocation、Invocation/Dispatch attempt、shadow decision persistence。
- 单一 team SQLite transaction/UoW command seam。
- Device Worker capability、lease acquire/renew/release、fencing 与同 host/profile 恢复。
- `DeviceServiceCore` 与 `PiManagerWorkerHost` 过渡宿主。
- 不含模型密钥的 per-profile durable management outbox。
- Phase 1 management tool executor 与 runtime exact-key validation。
- explicit-target Invocation Gateway，复用现有 Dispatch executor 支持两类外部 Agent。
- `direct` / `shadow` / `managed` Team 灰度开关。
- 普通轻问答与 root Task 两条真实 E2E。
- 独立 Phase 1 验收矩阵、root scripts、CI gate 与 closeout evidence。

### 4.2 Phase 1 明确不做

- 不自动分解任务，不创建 Task DAG、dependency、claim lease 或开放认领。
- 不做子任务验收、重派、冲突调解或多 Agent 汇总。
- 不实现 Cross-Agent Memory、Memory Capsule 或 Memory Candidate。
- 不实现 Server-hosted Worker、`auto` placement、跨 host 自动接管或容量调度。
- 不做完整 ManagementRun/DAG/lease/attempt 管理页面。
- 不把内置 PI Manager 显示为 Team Agent，不允许用户直接 @ 它。
- 不制作 launchd/systemd/Windows Service 安装器，不迁移旧 Daemon；这些属于 Phase 5。
- 不把所有 Team 默认切到 `managed`。
- 不升级到 Node 26；安装、原生依赖、测试、构建、生产与 SEA 全部统一使用 Node 24。

## 5. 核心决策

### 5.1 team DB 是 management 事务事实边界

`teamDb` 当前是包含所有 Team channel/message/task/dispatch 的共享 SQLite 数据库。Phase 1 的 policy、reservation、Run、lease、event、checkpoint、Invocation、attempt 和 shadow decision 全部放入 `teamDb`，避免跨 global/team database 伪事务。

新增一个窄 `ManagementUnitOfWork` / command store；需要原子性的流程只能通过该 seam 写入，不能在 `sendMessage()` 里串联多个普通 repository call 假装事务。SQLite 使用真实 transaction；in-memory 实现必须提供同样的 all-or-nothing 测试语义。

首个 managed 原子命令至少完成：

1. 按 `teamId + userId + clientMessageId` 预留 request key；managed 请求要求非空 `clientMessageId`。
2. 校验 Team policy 与 preflight snapshot。
3. 创建 ManagementRun。
4. append `run-started` event sequence 1。

同 key/same hash 返回现有 Run；同 key/different hash 返回 conflict。已有普通 human message/root Task 可作为输入事实，不视为 Manager 创建的副作用；Phase 1 不创建子 Task。

### 5.2 Phase-aware tool surface

wrapper 从固定全量 catalog 派生 effective allowlist：

- Phase 1 managed：只包含 metadata `phase === 1` 的工具。
- Phase 1 shadow：使用相同 Phase 1 descriptor，read tools 读取同一权限过滤 snapshot；write tools 只记录脱敏 intent/hash 到进程内 dry-run collector，不调用 Server write executor。
- Phase 2/3 tools 不进入模型 context，而不是暴露后再返回 “尚未实现”。

每次 Session 创建和每次 model call 前仍执行 exact set equality。Server/Device 只依赖 AgentBean types，不直接 import PI。

shadow 不伪造 ManagementRun/lease。Server 在既有 direct Dispatch 创建后，使用独立 `shadow:<requestKey>` 命名空间向可用 Device 发出一次只读评估请求；Device 返回 `ManagementShadowDecisionV1`（input hash、frozen target、proposed tool sequence、objective/argument hashes、diagnostic codes），Server 只把该脱敏 DTO 写入 `management_shadow_decisions`。超时或失败不阻塞 direct reply，也不能被迁移或解释为 managed execution。

### 5.3 模型凭证与 provider

新增 AgentBean-owned `ManagementCredentialProvider`：

- provider/model 选择可持久化，但 secret 只从 Device 本地凭证 provider 解析；
- 禁止写入 Server、Socket capability、ManagementEvent、checkpoint、日志、outbox 或 `auth.json`；
- CI/dev 可使用显式 ephemeral test credential；它不能让 production preflight 报 `credentialAvailable=true`；
- 每个允许 production managed 的 OS 必须先提供系统凭证 store adapter 与 round-trip smoke。首个灰度平台可独立启用，未通过的平台 fail closed；平台安装器仍留在 Phase 5。

不得用“密钥和加密 key 放在同一个 0600 文件”的伪加密替代系统凭证存储。

### 5.4 PI runtime 随 daemon 发布

Phase 1 将 `@agentbean/pi-management-runtime` 改为独立可发布的内部 runtime package，使用真实 semver、`files` 与 public declaration boundary；发布顺序为 Contracts → PI management runtime → daemon-next → canonical daemon。它是实现依赖，不承诺独立面向用户的产品 API。

daemon 使用 exact published dependency，npm install smoke 必须证明干净目录中无需 monorepo source 即可启动并加载 PI runtime。仍由 boundary checker 保证其他 packages 不直接 import `@earendil-works/pi-*`。

### 5.5 lease 与恢复

Phase 1 只做 Device-hosted、同 Device/profile 恢复：

- Device hello 单独报告 management worker capability、runtime version、credential availability 与 capacity，不上报 secret。
- Server 只从 Team policy 的 `allowedDeviceIds` 中选择在线且预检通过的 Device。
- lease 保存 token hash/fingerprint 与单调 `fencingToken`；raw token 只发给当前 Worker。
- 所有 write tool、checkpoint 和 terminal command 都必须携带 lease token + fencing token。
- 过期或旧 fencing token fail closed；同 idempotency key 仍可查询已经提交的结果。
- 同 Device/profile 的新 Worker 可以读取 Server facts、校验 checkpoint 并恢复；Phase 1 不自动跨 Device 转移。

### 5.6 durable outbox

新建独立 management outbox，不扩写现有按 `dispatchId` 去重的内存 outbox：

- 每个 profile 独立目录、schemaVersion、原子临时文件替换、`0700` directory / `0600` file。
- key 为 `managementRunId + commandId + idempotencyKey`。
- ack 后删除；重连/重启后按原 key 重放。
- 不持久化 provider secret、raw lease token、思维链或未脱敏日志。
- 需要重放的 typed tool command 可以保存最小输入；外部执行结果优先保存 canonical Dispatch/Workspace Run/Artifact 引用，而非复制完整日志。
- 旧 lease outbox item 必须先重新取得当前 lease并做 Server idempotency lookup，不能带旧 fencing token直接写入。

### 5.7 explicit target，不让 PI 改选主执行者

Phase 1 managed 仅接管现有 route 已解析出的显式目标 Agent：

- `agents.get_status` / `agents.list_capabilities` 只能看到权限过滤后的目标；
- `agents.invoke.targetAgentId` 必须等于 Run 的 frozen target；
- PI 可以整理 objective、附件引用和 deadline，但不能改选主执行者或追加第二个 Agent；
- 自定义 Agent 与 AgentOS 托管型 Agent 都进入同一个 Invocation/Dispatch 生命周期。

### 5.8 用户可见行为

- 普通轻问答：实际 Agent 的原始回复照常显示并归属于该 Agent；Server 根据 canonical Dispatch terminal 自动完成 Run，PI 不再生成总结消息。
- root Task：外部 Agent 原始交付仍保留；PI 只能通过 `review.submit_root_delivery` 追加 `senderKind=system`、`meta.kind=management-delivery` 的来源化交付，随后 root Task / Run 进入 `in_review`。用户明确把 Task 更新为 `done` 后 Run 才 `completed`。
- manager lifecycle 状态使用折叠 system status，不作为普通 Agent 参与路由。

## 6. 验收矩阵

Phase 1 从第一项实现开始维护：`agentbean-next/docs/phase-1-device-hosted-pi-manager-verification-matrix.md`。

| ID | 验收项 | 必需证据 |
|---|---|---|
| P1-01 | PI wrapper 只暴露 Phase 1 effective tools，shadow write tools 仅 dry-run | declaration、catalog snapshot、negative runtime tests |
| P1-02 | 真实 provider telemetry 与 typed context 不泄漏 PI 类型/secret | wrapper tests、declaration scan、redaction tests |
| P1-03 | published daemon 在 clean install 中加载内置 PI runtime | npm pack/install smoke |
| P1-04 | management schema/constraints/migrations 可升级且可回滚 | SQLite migration tests、schema inspection |
| P1-05 | reservation + Run + first Event 原子且请求幂等 | UoW rollback/idempotency/conflict tests |
| P1-06 | lease acquire/renew/expire/reacquire 与 fencing 正确 | Domain + Server clock tests |
| P1-07 | event exact-key validation、sequence、replay 与脱敏正确 | validator、append、replay tests |
| P1-08 | checkpoint facts 同 snapshot，失效后忽略 hints 并重建 | SQLite snapshot + recovery tests |
| P1-09 | Invocation immutable，Dispatch attempt 唯一且 status 只派生 | repository/domain/gateway tests |
| P1-10 | Device 重启、断线、ack 丢失与 outbox 重放不重复执行 | durable outbox + integration tests |
| P1-11 | shadow 除独立决策记录和既有 direct 路径外零管理副作用 | before/after repository diff、replay evidence |
| P1-12 | barrier 后 Worker/Provider/tool 故障不回退 direct | failure matrix、zero duplicate Dispatch assertion |
| P1-13 | explicit custom Agent 轻问答真实链路完成且正确归因 | browser/socket/Device E2E |
| P1-14 | AgentOS adapter 使用同一 Invocation 生命周期 | adapter contract；可用环境下 live smoke |
| P1-15 | root Task 只在 management delivery 后 `in_review`，用户确认后完成 | Server + Web E2E |
| P1-16 | direct 行为、PI 安全边界、build、CI 与生产 smoke 不回归 | Phase 0/full suite/build/main CI URL |

只有 P1-01 至 P1-16 全部 Green，且 `managed` 默认仍关闭，才允许 Phase 1 closeout。没有任意天数的观察期。

## 7. 实施任务

### Task 1：建立 Phase 1 matrix 与静态门禁

**Files**

- Create: `agentbean-next/docs/phase-1-device-hosted-pi-manager-verification-matrix.md`
- Create: `scripts/check-phase-1-management-boundary.mjs`
- Create: `scripts/check-phase-1-management-boundary.test.mjs`
- Modify: `package.json`
- Modify: `scripts/check-agentbean-next-readiness.mjs`
- Modify: `apps/server-next/tests/readiness-check.test.ts`

**TDD / Acceptance**

1. matrix 初始全部 Red/Not implemented，不预写 Green。
2. checker 固定：PI import boundary、Phase 1 table/socket/tool surface、禁止 manager 成为 Agent、禁止 Server/Device import raw PI types。
3. root 暴露 `test:phase1-management-boundary` 与 `check:phase1-management-boundary`。
4. Task 结束前 checker 对未实现能力明确 Red，不能用空 fixture 假绿。

### Task 2：扩展 Phase-aware wrapper、真实 provider seam 与发布合同

**Files**

- Modify: `packages/pi-management-runtime/package.json`
- Modify: `packages/pi-management-runtime/src/types.ts`
- Modify: `packages/pi-management-runtime/src/index.ts`
- Modify: `packages/pi-management-runtime/src/pi-session-adapter.ts`
- Modify: `packages/pi-management-runtime/src/management-tool-catalog.ts`
- Create: `packages/pi-management-runtime/src/provider-adapter.ts`
- Modify/Create: `packages/pi-management-runtime/tests/*`
- Modify: `apps/daemon-next/package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci-cd.yml`

**TDD**

1. 先锁定 Phase 1 managed 与 shadow tool snapshots；二者 descriptor 相同，shadow write executor 只能记录 intent/hash；Phase 2/3 tools、coding tools、cwd resources 均不可见。
2. typed session input 包含 Run refs、frozen target、权限过滤 thread/checkpoint；调用方不能传任意 PI context。
3. model response 增加 AgentBean-owned `usage`、`finishReason`、`responseModel`，unknown provider fields 不自由透传。
4. provider secret 只由 runtime closure 使用，event/diagnostic/declaration 不含 secret。
5. package 改为真实 semver/publishable，daemon exact 依赖；clean `npm pack` install/load smoke 通过。

**Acceptance**

- `build:pi-management-runtime`、package tests、boundary checker、SEA 全绿。
- daemon tarball 不引用 monorepo 相对 source。
- 其他 package declaration 不出现 PI SDK type。

### Task 3：冻结 Worker/lease/tool RPC contracts 与 Domain rules

**Files**

- Create: `packages/contracts/src/management-worker.ts`
- Modify: `packages/contracts/src/socket.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/tests/management-worker-contracts.test.ts`
- Create: `packages/domain/src/manager-lease-policy.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/tests/manager-lease-policy.test.ts`

**Contract**

- capability/register、lease offer/acquire/renew/release、fencing token、tool request/result、checkpoint fetch、abort、outbox replay ack，以及独立的 shadow evaluation request/result。
- payload 只含 AgentBean DTO；不含 PI type、provider secret、完整 prompt 或任意自由 payload。
- write request 共同要求 `managementRunId`、`workerId`、`leaseToken`、`fencingToken`、`idempotencyKey`。

**Acceptance**

- exact-key runtime fixtures 拒绝额外敏感字段。
- fake clock table tests 覆盖 acquire、renew、expiry、same-host reacquire、stale fencing。

### Task 4：实现 management schema、repositories 与原子 UoW

**Files**

- Create: `apps/server-next/src/infra/sqlite/migrations/team/0010_management_phase_1.sql`
- Create: `apps/server-next/src/application/management-repositories.ts`
- Create: `apps/server-next/src/application/management-unit-of-work.ts`
- Create: `apps/server-next/src/infra/memory/management-repositories.ts`
- Create: `apps/server-next/src/infra/sqlite/management-repositories.ts`
- Modify: `apps/server-next/src/application/repositories.ts`
- Modify: `apps/server-next/src/infra/memory/repositories.ts`
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`
- Modify: `apps/server-next/tests/sqlite-repositories.test.ts`
- Create: `apps/server-next/tests/management-unit-of-work.test.ts`

**Tables**

- `team_management_policies`
- `managed_request_reservations`
- `management_runs`
- `manager_leases`
- `management_events`
- `management_checkpoints`
- `agent_invocations`
- `invocation_dispatch_attempts`
- `management_shadow_decisions`

**Required constraints**

- unique request reservation；unique `(management_run_id, sequence)`；unique `(management_run_id, idempotency_key)` event。
- unique `(management_run_id, idempotency_key)` Invocation；unique `(invocation_id, attempt_number)`；unique `dispatch_id`。
- 每个 Invocation 最多一个 active attempt 由原子 command + partial/guarded constraint 保证。
- SQLite migration + ledger 在同事务；旧数据库升级、重复 apply、失败 rollback 均测试。

### Task 5：实现 Server Collaboration Kernel、event 与 checkpoint

**Files**

- Create: `apps/server-next/src/application/management/management-kernel.ts`
- Create: `apps/server-next/src/application/management/management-event-validator.ts`
- Create: `apps/server-next/src/application/management/management-checkpoint.ts`
- Create: `apps/server-next/src/application/management/management-tool-executor.ts`
- Create: `apps/server-next/tests/management-kernel.test.ts`
- Create: `apps/server-next/tests/management-event-validator.test.ts`
- Create: `apps/server-next/tests/management-checkpoint.test.ts`

**TDD**

1. 原子 create/resume Run 与 reservation conflict。
2. event append 使用 exact-key validator、稳定 payload hash、递增 sequence；same-key/same-hash 返回原事件，冲突 fail。
3. lease token 只存 hash/fingerprint；每个 write command 校验 fencing。
4. checkpoint facts 在同一 DB transaction snapshot 读取；waiting/completed Invocation sets exact 且 disjoint。
5. 任一 authoritative ref 不一致时丢弃全部 hints，从 Server facts rebuild。

**Phase 1 event subset**

实现 `run-started`、`worker-leased`、`worker-lost`、`checkpoint-updated`、`invocation-created`、`dispatch-attempt-started/completed`、`waiting-for-user`、`root-delivery-submitted`、`run-completed/failed/cancelled`。Phase 2 Task DAG events 保持 type-only，不连接 writer。

### Task 6：实现 Invocation Gateway 与 Dispatch attempt bridge

**Files**

- Create: `apps/server-next/src/application/management/invocation-gateway.ts`
- Modify: `apps/server-next/src/application/usecases.ts`
- Modify: `apps/server-next/src/application/repositories.ts`
- Modify: `apps/server-next/src/infra/memory/repositories.ts`
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`
- Create: `apps/server-next/tests/invocation-gateway.test.ts`
- Create: `apps/server-next/tests/management-dispatch-lifecycle.test.ts`

**TDD**

1. `agents.invoke` 校验 frozen target、权限、Team、channel、attachment 与 target kind。
2. canonicalize + hash intent；same key/hash 返回原 Invocation，different hash conflict。
3. 原子创建 Invocation、Dispatch、attempt row 与两个 typed events。
4. active attempt 存在时重试不创建新 Dispatch；terminal 后只有显式受控 retry 才能 attempt +1。
5. Invocation view 完全从 Dispatch rows 派生；不得更新 Invocation status column。
6. result/error/cancel/timeout 写 canonical Dispatch，并幂等 append attempt terminal event。
7. managed Task 的外部 result 不提前改变 root Task；direct path 保持现状。

### Task 7：接入 Worker transport 与 Server scheduler

**Files**

- Modify: `apps/server-next/src/transport/socket-handlers.ts`
- Modify: `apps/server-next/src/transport/socket-server.ts`
- Create: `apps/server-next/src/application/management/device-worker-scheduler.ts`
- Create: `apps/server-next/tests/management-socket-integration.test.ts`
- Modify: `packages/contracts/src/socket.ts`

**TDD / Acceptance**

- hello capability 与 Dispatch claim capability 分离。
- 只选择 policy 允许、Team/profile 匹配、在线、credential/capacity ready 的 Device。
- offer/acquire/heartbeat/renew/release/abort 全部 ack、超时和重连可测。
- Socket 断开只记录 Worker lost / 等 lease expiry，不触发 direct fallback。
- tool RPC 只进入 management kernel，不把 repository 注入 Worker。

### Task 8：实现 DeviceServiceCore、credential provider、durable outbox 与 WorkerHost

**Files**

- Create: `apps/daemon-next/src/device-service-core.ts`
- Create: `apps/daemon-next/src/pi-manager-worker-host.ts`
- Create: `apps/daemon-next/src/management-worker-protocol.ts`
- Create: `apps/daemon-next/src/management-durable-outbox.ts`
- Create: `apps/daemon-next/src/management-credential-provider.ts`
- Create: `apps/daemon-next/src/management-model-adapter.ts`
- Modify: `apps/daemon-next/src/profile-paths.ts`
- Modify: `apps/daemon-next/src/index.ts`
- Modify: `apps/daemon-next/src/cli.ts`
- Create: `apps/daemon-next/tests/device-service-core.test.ts`
- Create: `apps/daemon-next/tests/pi-manager-worker-host.test.ts`
- Create: `apps/daemon-next/tests/management-durable-outbox.test.ts`
- Create: `apps/daemon-next/tests/management-recovery.test.ts`

**TDD**

1. `DeviceServiceCore` 组合现有 Dispatch client 与新 WorkerHost；不继续把所有逻辑堆入 `index.ts`。
2. 一个 lease 对应一个 PI Session；lost lease 立即 abort/dispose，旧 Worker 禁止写。
3. typed context/checkpoint 恢复；Phase 1 `taskGraphRevision=0`，hints 不驱动状态。
4. outbox crash-before-write、write-before-ack、ack-before-delete、corrupt file、reconnect replay 全覆盖。
5. 同 profile 重启查询原 idempotency result，不创建第二个 Invocation/Dispatch/message。
6. credential store unavailable 时 capability 明确 unavailable，managed preflight fail closed。
7. logs/events/outbox snapshot 均不含模型密钥、lease raw token、思维链或绝对 cwd。

### Task 9：实现 Team policy、shadow 与 managed routing

**Files**

- Create: `apps/server-next/src/application/management/management-router.ts`
- Modify: `apps/server-next/src/application/usecases.ts`
- Modify: `apps/server-next/src/transport/socket-handlers.ts`
- Modify: `packages/contracts/src/socket.ts`
- Modify: `apps/web-next/app/[teamPath]/settings/page.tsx`（只增加最小 owner/admin policy control）
- Create: `apps/web-next/app/[teamPath]/settings/ManagementPolicyPanel.tsx`
- Modify: `apps/web-next/tests/settings-team-route.test.ts`
- Create: `apps/server-next/tests/management-routing.test.ts`

**Order**

1. direct baseline regression 必须先锁定。
2. shadow 复用相同 target/context/preflight，既有 direct Dispatch 正常执行；独立 shadow request 不创建 Run/lease，返回后只写脱敏 decision hash/diagnostics。
3. managed 只接受显式 target + `clientMessageId`；preflight 后原子 reservation/Run/event。
4. Team owner/admin 才能切 mode/allowed Device；默认 direct，managed 开关展示缺失 preflight。
5. barrier 后的所有错误分支断言 zero direct Dispatch。

不增加 ManagementRun 列表、DAG、lease 或 attempt UI。

### Task 10：完成轻问答与 root Task 垂直链路

**Files**

- Modify: `apps/server-next/src/application/management/management-tool-executor.ts`
- Modify: `apps/server-next/src/application/usecases.ts`
- Modify: `apps/daemon-next/src/pi-manager-worker-host.ts`
- Modify: `apps/web-next` message/task projection as needed
- Create: `apps/server-next/tests/managed-single-agent.test.ts`
- Create: `apps/daemon-next/tests/managed-single-agent.test.ts`
- Modify/Create: browser smoke fixture

**E2E A：普通轻问答**

explicit @ custom/AgentOS target → Run/lease → PI `agents.invoke` → one Invocation/one Dispatch → actual Agent reply → Run completed；无 PI summary，reply sender 为 actual Agent。

**E2E B：root Task**

explicit task entry → rootTaskId Run → one Invocation/Dispatch → actual Agent raw delivery → PI `review.submit_root_delivery` → system management delivery + Task/Run `in_review` → human `done` → Run completed。

失败、取消、超时、补充 steer、Worker restart、Device reconnect 均不得复制 external execution 或 delivery。

### Task 11：CI integration、真实 Device smoke 与 closeout

**Files**

- Modify: `package.json`
- Modify: `.github/workflows/ci-cd.yml`
- Modify: `scripts/check-agentbean-next-readiness.mjs`
- Modify: `apps/server-next/tests/readiness-check.test.ts`
- Modify: `agentbean-next/docs/phase-1-device-hosted-pi-manager-verification-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`（只回链实际 verdict）
- Modify: `README.md`（只在实际可用后增加受控开发者入口）

**Root gates**

- `test:phase1-management`
- `build:phase1-management`
- `check:phase1-management-boundary`
- 现有 `test:phase0`、`build:phase0`、`test:phase1`、`build:packages` 全保留。

**Closeout evidence**

- contracts/domain/server/device/Web test counts。
- migration constraints 与 rollback evidence。
- clean npm install + PI runtime load。
- Node 24 clean install、build/runtime 与三平台 SEA rerun。
- custom Agent 真实 Device smoke；AgentOS adapter contract 与可用环境 live smoke。
- disconnect/restart/outbox/fencing/idempotency evidence。
- shadow zero-management-side-effect diff。
- direct regression 与 browser smoke。
- merge 后 main CI URL；不用观察天数代替证据。

## 8. PR 切片与依赖

| 顺序 | PR | 内容 | 前置 |
|---|---|---|---|
| 0 | 本计划 | Phase 1 边界、任务、矩阵合同 | Phase 0 complete |
| 1 | Runtime/package | Task 1-2：matrix、phase-aware wrapper、publish/install contract | 计划已评审 |
| 2 | Worker contracts | Task 3：Contracts + Domain lease/tool RPC | PR 1 vocabulary |
| 3 | Atomic persistence | Task 4：schema、repositories、UoW | PR 2 contracts |
| 4 | Server kernel | Task 5：Run/lease/event/checkpoint | PR 3 UoW |
| 5 | Invocation bridge | Task 6：Invocation → Dispatch attempts | PR 4 kernel |
| 6 | Device worker | Task 7-8：transport、DeviceServiceCore、WorkerHost、outbox | PR 2 + PR 4；可与 PR 5 部分并行 |
| 7 | Rollout routing | Task 9：direct/shadow/managed 与最小 policy control | PR 5-6 |
| 8 | Managed vertical slice | Task 10：轻问答 + root Task E2E | PR 7 |
| 9 | CI/verification closeout | Task 11：root gate、真实证据、handoff | PR 8 main CI |

每个实现 PR 都必须有独立 Issue、中文 GitHub 内容和小而完整的验收面。不得在 schema/UoW 未合入前先开启 managed 路由。

## 9. 验证命令

```bash
npm ci
npm run test:phase1-management-boundary
npm run check:phase1-management-boundary
npm run test:pi-management-runtime
npm run test:contracts
npm run test:domain
npm run test:server-next
npm run test:daemon-next
npm run test:web-next
npm run test:phase1-management
npm run build:contracts
npm run build:domain
npm run build:pi-management-runtime
npm run build:server-next
npm run build:daemon-next
npm run build:web-next
npm run build:phase1-management
npm run test:phase0
npm run build:phase0
npm run test:phase1
npm run build:packages
npm run smoke:agentbean-next-browser
npm run check:agentbean-next-readiness
npm run test:team-terminology
npm run check:team-terminology
```

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 多 repository 写入部分成功，barrier 失真 | management UoW + SQLite transaction + failure injection rollback tests |
| Worker/ack 重试导致外部任务执行两次 | immutable Invocation、active attempt unique、durable outbox、same-key lookup |
| Invocation 形成第二状态事实源 | 不建可写 status column；view 只从 Dispatch rows 派生 |
| 旧 Worker 在新 lease 后继续写 | hashed lease token + monotonic fencing + every-write validation |
| checkpoint summary 覆盖 Server 事实 | same-snapshot authoritative refs；任一 mismatch 丢弃全部 hints |
| PI 看到 Phase 2/3 或 coding tools | phase-aware exact allowlist + runtime inspection + boundary checker |
| 模型密钥进入 Server/auth.json/log/outbox | 独立 local credential provider + redaction/forbidden-field tests + fail-closed capability |
| private wrapper 让 published daemon 无法安装 | publishable internal runtime + exact dependency + clean npm pack/install smoke |
| managed Task 被 external result 提前置 `in_review` | Invocation linkage 分支；只允许 management delivery 推进 root Task |
| shadow 被误认为已执行或写入 managed 状态 | 独立 namespace/table；zero management-side-effect repository diff |
| 模型自动判定 Task 导致状态机漂移 | 只信显式 `asTask` / rootTaskId / task entry |
| 继续膨胀 daemon `index.ts` 与 server `usecases.ts` | 新建 DeviceServiceCore、WorkerHost、management kernel/router 模块 |
| browser smoke 偶发时序失败掩盖 main truth | 保存 artifacts、按失败项复现；只在证据表明无代码回归时 rerun，不删除断言 |

## 11. 回滚与数据策略

- `direct` 始终是默认且独立路径，但不能作为已经越过 barrier 的单请求 fallback。
- Team 可停止创建新 managed Run；已有 Run 保留并恢复/取消，不能删除 reservation 后改走 direct。
- Phase 1 tables 使用 additive migration；回滚代码不得删除 Run/Event/Invocation history。
- shadow records 可按保留策略清理，但不能迁移成 managed execution record。
- PI runtime/provider 升级失败时回退 exact package version，重跑 wrapper/SEA/install smoke；不得绕过 wrapper。
- outbox schema 不兼容时 fail closed 并保留原文件供 doctor/人工恢复，不静默丢弃。

## 12. Phase 1 完成门禁

1. P1-01 至 P1-16 全部 Green 并有可复现证据。
2. custom Agent 真实链路证明 one request → one Invocation → one active Dispatch → one reply。
3. AgentOS 使用同一 lifecycle 的 contract test 全绿；可用环境必须补 live smoke，否则矩阵明确记录未运行原因，不能伪称 live Green。
4. Worker restart、Device disconnect、ack loss、stale fencing 与 duplicate idempotency 全部不重复执行。
5. root Task 只有在 management delivery 后进入 `in_review`，用户确认后才完成。
6. shadow 除既有 direct 路径和独立决策记录外零管理副作用。
7. no coding tools / no cwd / no raw PI types / no secret persistence 全绿。
8. direct 全量回归、Phase 0 gates、build、browser smoke、main CI 全绿。
9. `managed` 仍默认关闭，只对明确配置且 preflight Green 的 Team/Device 开放。
10. verification-only closeout PR 已合并。

完成后才为 Phase 2 编写 Task DAG、团队认领与多 Agent 协作的独立实施计划。

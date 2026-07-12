# AgentBean Phase 0：PI 契约与兼容性验证实施计划

- 日期：2026-07-12
- 状态：待评审
- 上游设计：`docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md` §21 Phase 0
- 产品合同：`docs/superpowers/specs/2026-05-09-agentbean-prd.md`
- 前置条件：Phase -1 已随 PR #487 完成，merge commit `86ce17754123d4fdd9d9b09522f3a2d4a6510a44`，对应 main CI/CD run `29178251488` 全部成功

## 1. 目标

Phase 0 只回答两个问题：

1. AgentBean 能否通过一个窄、可替换、无 coding tools 的 wrapper 安全嵌入 PI `AgentSession`。
2. Phase 1 至 Phase 4 将依赖的 Management、Invocation、Event、Checkpoint 和 rollout 语义是否已经冻结为可测试契约。

Phase 0 不创建可执行 `ManagementRun`，不调用真实外部 Agent，不修改生产路由，不增加数据库 migration，不启用 `shadow` 或 `managed`。完成 Phase 0 只代表“runtime 与契约可以进入 Phase 1”，不代表 PI 管理 Agent 已对用户可用。

## 2. 当前事实

### 2.1 AgentBean 基线

- root workspace 当前只包含 `packages/*` 与 `apps/*`，build 顺序为 Contracts → Domain → Server → Device → Web；见 `package.json:5-43`。
- CI 使用 Node `24.15.0`、`npm ci`、全量 Phase tests 和 package build；见 `.github/workflows/ci-cd.yml:86-120`。
- 当前 Dispatch 是外部执行 attempt 的唯一事实，状态为 `queued` 至 `timed_out`，DTO 尚无 Invocation 关联；见 `packages/contracts/src/dispatch.ts:5-65`。
- 当前 Task 只有基础状态与 assignee/channel/tags，不包含 DAG、revision、claim lease 或 acceptance；见 `packages/contracts/src/task.ts:3-47`。
- Server repository 已把 Dispatch、Artifact、Workspace Run 和 Task 分开持久化；见 `apps/server-next/src/application/repositories.ts:247-305`。
- Device 侧已有进程内 Dispatch outbox，但它只按 `dispatchId` 去重且不是磁盘 durable outbox；见 `apps/daemon-next/src/outbox.ts:1-129`。Phase 0 不把它改造成 Phase 1 outbox。
- 当前代码没有协作级 Memory DTO 或 repository；搜索结果只有 storage implementation 的 “memory” 命名。Phase 0 只冻结 `MemoryCapsuleRef` / `MemoryCandidateRef` 引用，不实现 Memory Service。

### 2.2 PI 与 Node SEA 基线（2026-07-12）

- 设计指定的官方包为 `@earendil-works/pi-coding-agent`。npm 当前版本 `0.80.6`，`engines.node >=22.19.0`，`type=module`；Phase 0 使用精确版本 `0.80.6`，禁止 caret/range 漂移。
- 官方 SDK 提供 `createAgentSession`、`AgentSession`、event subscription、custom tools、`steer`、`followUp`、compaction 和 abort。官方文档：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>。
- 官方 SDK 默认 `DefaultResourceLoader` 会发现 extension、skill、prompt 和 context file；AgentBean 不能采用默认发现行为，必须使用固定资源加载器。
- 官方 SDK 支持 `noTools: "builtin"` 与 `customTools`。AgentBean 只允许固定管理工具，不导入或转发 `codingTools`、`readOnlyTools`、bash/read/write/edit/browser 等工具。
- Node SEA 仍为 Active Development。内建 `node --build-sea` 从 Node 25.5 引入；仓库生产/CI Node 24.15 不为 Phase 0 升级。SEA 验证使用独立 Node 26 job。官方文档：<https://nodejs.org/api/single-executable-applications.html>。
- PI 依赖包含可选/native 与资源加载路径。SEA 必须验证真实 import、Session 创建、固定工具加载和关闭流程，不能只验证 “hello world” 二进制。

## 3. 范围边界

### 3.1 Phase 0 必须交付

- 私有 workspace package `@agentbean/pi-management-runtime`。
- 唯一 PI import boundary 与精确版本锁定。
- 不暴露原始 `AgentSession` 的 AgentBean wrapper。
- 固定管理工具目录、固定资源加载器、无 coding tools 断言。
- Management / Invocation / Event / Checkpoint / Task coordination 的 type-only contracts。
- `direct` / `shadow` / `managed`、预检和 `managedFallbackBarrier` 的纯领域规则。
- Dispatch、Task、Artifact、Workspace Run 与未来 Invocation 边界回归。
- Node SEA 跨平台兼容性 verdict。
- 独立 Phase 0 验收矩阵、root scripts 和 CI gate。

### 3.2 Phase 0 明确不做

- 不增加 `ManagementRunRepository`、lease repository 或 SQLite tables。
- 不增加 `/web` 或 `/agent` management events。
- 不创建 `PiManagerWorkerHost`、`DeviceServiceCore` 或 durable outbox。
- 不执行真实模型请求，不读取用户 PI 全局配置，不读取项目 `.pi`、`AGENTS.md` 或 cwd。
- 不实现外部 Agent 调用、Task DAG、claim、acceptance 写入或 Memory Service。
- 不增加 Web 页面。
- 不升级生产 Node，不制作平台安装器，不发布 Device Service 二进制。

## 4. 决策

### 4.1 独立 wrapper package

新增 `packages/pi-management-runtime`，包名 `@agentbean/pi-management-runtime`，保持 `private: true`。只有该 package 可以 import `@earendil-works/pi-*`；Server、Device、Contracts、Domain 和 Web 不能直接 import PI。

wrapper 对外只暴露：

```ts
export interface ManagementSession {
  prompt(input: ManagementPrompt): Promise<void>;
  steer(input: ManagementSteer): Promise<void>;
  followUp(input: ManagementFollowUp): Promise<void>;
  compact(input?: ManagementCompactionRequest): Promise<ManagementCompactionResult>;
  abort(reason: string): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: ManagementRuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface ManagementRuntimeFactory {
  createSession(input: CreateManagementSessionInput): Promise<ManagementSession>;
}
```

不得从 package export 原始 `AgentSession`、`DefaultResourceLoader`、PI tool factories、AuthStorage 或 ModelRegistry。Phase 1 只能依赖 AgentBean wrapper。

### 4.2 固定资源与工具

wrapper 使用 AgentBean 自己的 `ManagementResourceLoader`：

- system prompt 由调用方显式传入已版本化的 AgentBean prompt；
- extension、skill、prompt template、theme、context files 全部为空；
- 不扫描全局 PI 目录、项目 `.pi`、`AGENTS.md`、`CLAUDE.md` 或 cwd；
- 使用 `noTools: "builtin"`，只注册调用方传入且通过 catalog 校验的 management tools；
- effective tool names 必须与 allowlist 完全相等，多一个或少一个都 fail closed。

Phase 0 冻结完整工具名 union，但只提供 fake executor 做 deterministic runtime test；真实 Server tool implementation 属于 Phase 1 及后续阶段。

### 4.3 Type-only contracts，不接生产状态机

新增 DTO 作为未来协议合同，但不把它们接入 `TaskDto`、`DispatchDto`、Socket events 或 repositories：

- `ManagementMode`、`ManagementRunStatus`、`ManagementRunDto`、placement/budget。
- `ManagementEventV1` discriminated union、sequence、schemaVersion、actor、idempotency。
- `ManagementCheckpointV1`，区分 authoritative refs 与 context hints。
- `AgentInvocationIntentV1`、immutable intent hash、Invocation view、Dispatch attempt projection。
- `TaskCoordinationDto`、AcceptanceCriterion、EvidenceRef、SubtaskDelivery、SubtaskAcceptance。
- `MemoryCapsuleRefDto`、`MemoryCandidateRefDto` 只保存 ID/hash/scope 引用，不保存 Memory 原文。

Phase 0 contract tests 必须证明旧 `TaskDto` 与 `DispatchDto` 仍可独立构造，避免 type-only 冻结意外成为生产必填字段。

### 4.4 SEA 只产生 verdict

SEA 使用专用 Node 26 workflow 在 Linux x64、macOS arm64、Windows x64 构建和运行最小 AgentBean PI executable。测试入口必须真实完成：

1. 导入 `@agentbean/pi-management-runtime`。
2. 使用 deterministic fake model 创建 Session。
3. 验证 effective tools 只有一个 fake management tool。
4. 触发一次 prompt/event、steer 或 followUp。
5. 执行 abort/dispose 并正常退出。

SEA matrix 全绿则 verdict 为 `compatible`。任一平台失败时，Phase 0 仍可在 wrapper/runtime gate 全绿后结束，但验收矩阵必须记录 `blocked-for-phase5`、失败日志和替代打包研究项；不得写成 `compatible`。SEA 失败不阻塞 Phase 1 的 Device-hosted Node runtime，因为 Phase 1 不依赖自包含二进制。

## 5. 验收矩阵

新增 `agentbean-next/docs/phase-0-pi-contract-compatibility-verification-matrix.md`：

| ID | 验收项 | 必需证据 |
|---|---|---|
| P0-01 | PI 依赖只存在于 wrapper package，且精确锁定 `0.80.6` | package/lockfile inspection、dependency guard |
| P0-02 | AgentBean package 不暴露原始 PI SDK 类型或实例 | declaration/type test、export scan |
| P0-03 | Session 支持 event、prompt、steer、followUp、compaction、abort、dispose | deterministic SDK integration tests |
| P0-04 | effective tools 与 management allowlist 完全相等 | runtime inspection、negative tests |
| P0-05 | 不加载 coding tools、PI 全局/项目 extension、skills、context 或 cwd | hermetic temp-home/cwd tests |
| P0-06 | Management contracts 是 typed/versioned，禁止敏感 payload | Contracts tests、forbidden-field fixture |
| P0-07 | rollout policy 与 fallback barrier 是纯领域规则且无重复执行路径 | Domain table tests |
| P0-08 | Invocation intent immutable；相同 key/hash 幂等，不同 hash conflict | Domain tests |
| P0-09 | Checkpoint authoritative refs 失效时 context hints 不可用 | Domain tests |
| P0-10 | 现有 direct Dispatch/Task/Artifact/Workspace Run 行为不变 | Server regression tests |
| P0-11 | SEA 每个平台都有 `compatible` 或 `blocked-for-phase5` 的可复现 verdict | CI matrix logs、verdict artifact |
| P0-12 | Phase 0 root scripts、build、readiness 和 full existing suite 通过 | CI run URL |

只有 P0-01 至 P0-10、P0-12 全绿，且 P0-11 不再是 `unknown`，才允许开始 Phase 1。

## 6. 实施任务

### Task 1：建立 Phase 0 验收矩阵与 dependency guard

**Files**

- Create: `agentbean-next/docs/phase-0-pi-contract-compatibility-verification-matrix.md`
- Create: `scripts/check-phase-0-pi-boundary.mjs`
- Create: `scripts/check-phase-0-pi-boundary.test.mjs`
- Modify: `package.json`

**TDD**

1. 先写 checker tests，要求只有 `packages/pi-management-runtime/package.json` 可以声明或 import `@earendil-works/pi-*`。
2. fixture 中加入 Server/Device 直接 import PI，确认 checker fail 并报告 file/line。
3. 实现 checker；当前 wrapper package 尚不存在时返回明确的 `P0_NOT_SCAFFOLDED`，而不是假绿。
4. root 增加 `test:phase0-boundary` 与 `check:phase0-pi-boundary`。

**Acceptance**

- checker tests 全绿。
- 对真实仓库运行时，在 Task 2 完成前明确 Red；Task 2 完成后 Green。
- checker 扫描 source、tests、package manifests 和 lockfile，不扫描 build artifacts。

### Task 2：创建唯一 PI wrapper package

**Files**

- Create: `packages/pi-management-runtime/package.json`
- Create: `packages/pi-management-runtime/tsconfig.json`
- Create: `packages/pi-management-runtime/vitest.config.ts`
- Create: `packages/pi-management-runtime/src/types.ts`
- Create: `packages/pi-management-runtime/src/pi-session-adapter.ts`
- Create: `packages/pi-management-runtime/src/index.ts`
- Create: `packages/pi-management-runtime/tests/pi-session-adapter.test.ts`
- Modify: `package-lock.json`
- Modify: `package.json`

**Dependency contract**

- `dependencies["@earendil-works/pi-coding-agent"] = "0.80.6"`，使用 exact version。
- package `engines.node = ">=22.19.0"`、`private = true`、`type = "module"`。
- 如实现必须直接 import `pi-agent-core` 或 `pi-ai`，只能在证据证明 coding-agent 未 re-export 所需类型时精确锁定同版 `0.80.6`；不得预先增加。

**TDD**

1. 写 wrapper public API type tests，确认原始 `AgentSession` 不可从 AgentBean package import。
2. 用 deterministic fake model 创建真实 PI Session，不请求外部模型。
3. 依次验证 prompt/event、steer、followUp、compaction、abort、waitForIdle、dispose。
4. adapter 将 PI 原生 event 归一化为 AgentBean `ManagementRuntimeEvent`；未知 event 只能进入显式 `unsupported` diagnostic，不能自由透传任意对象。
5. 运行 `npm run build:pi-management-runtime` 和 package tests。

**Acceptance**

- Node 24.15 下 package build/test 通过。
- public declaration file 不包含 `@earendil-works` import。
- fake model 零网络访问；测试在空 HOME、空 cwd 下可重复通过。

### Task 3：实现 hermetic resource loader 与 management tool catalog

**Files**

- Create: `packages/pi-management-runtime/src/management-resource-loader.ts`
- Create: `packages/pi-management-runtime/src/management-tool-catalog.ts`
- Create: `packages/pi-management-runtime/tests/resource-loader.test.ts`
- Create: `packages/pi-management-runtime/tests/tool-boundary.test.ts`

**Contract**

- 固定 `ManagementToolName` 为设计 §10 的工具名集合。
- 每个 tool definition 必须声明 `effect: "read" | "write"`、Phase、输入 schema version。
- 所有 write tool 输入共同要求 `managementRunId`、`leaseToken`、`idempotencyKey`；read tool 至少要求 `managementRunId`、`leaseToken`。
- executor 由 Phase 1 注入；Phase 0 只提供 fake executor，不连接 Server。

**Negative tests**

- HOME 中放置恶意全局 extension、cwd 中放置项目 extension/skill/AGENTS 文件，Session effective resources 仍为空。
- 传入 `bash`、`read`、`write`、`edit`、`grep`、`find`、`ls` 或未登记 tool name 时创建 Session 失败。
- allowlist 缺失一个声明 tool 或 effective tools 多一个时 fail closed。
- resource loader diagnostic 不能包含 secret、完整 prompt、本地绝对路径或文件内容。

### Task 4：冻结 Management、Invocation、Event 与 Checkpoint contracts

**Files**

- Create: `packages/contracts/src/management.ts`
- Create: `packages/contracts/src/management-event.ts`
- Create: `packages/contracts/src/invocation.ts`
- Create: `packages/contracts/src/task-coordination.ts`
- Create: `packages/contracts/src/management-memory.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/tests/management-contracts.test.ts`
- Modify: `packages/contracts/tests/contracts.test.ts`

**Rules**

- 所有 versioned records 使用 literal `schemaVersion: 1`。
- `ManagementEventV1` 是 discriminated union，不允许 `payload: Record<string, unknown>`。
- Event payload 类型禁止 secret、token、prompt、reasoning、absolute path、source code、raw log 和 Memory 原文等字段名。
- `ManagementCheckpointV1.authoritative` 只保存 Server IDs/revisions/sequences；`contextHints` 不能作为状态转换输入。
- `AgentInvocationIntentV1` 是 immutable snapshot；`AgentInvocationView` 的状态和 attempts 是派生 view。
- `TaskCoordinationDto` 在 Phase 0 独立定义，不挂入现有 `TaskDto`。
- `MemoryCapsuleRefDto` / `MemoryCandidateRefDto` 只冻结引用，不创建内容 DTO。

**Acceptance**

- 新旧 DTO compile tests 通过。
- 现有 `TaskDto`、`DispatchDto` fixture 无需新增字段。
- contracts build 后 declaration exports 完整且无 PI import。

### Task 5：实现纯领域 rollout、idempotency 与 checkpoint 规则

**Files**

- Create: `packages/domain/src/management-policy.ts`
- Create: `packages/domain/src/invocation-policy.ts`
- Create: `packages/domain/src/checkpoint-policy.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/tests/management-policy.test.ts`
- Create: `packages/domain/tests/invocation-policy.test.ts`
- Create: `packages/domain/tests/checkpoint-policy.test.ts`

**Table tests**

- `direct` 不创建 management side effects。
- `shadow` 只能产生 namespaced decision record，不能创建 Task/Invocation/Message/Memory/Dispatch。
- `managed` 预检必须同时满足 worker、credential、placement、budget、target availability。
- barrier 前只有显式单 Agent 请求可受控回退 direct；多 Agent/分解请求不可回退。
- 首个 managed idempotency reservation 或任一持久/用户可见 side effect 越过 barrier；越过后所有错误路径都禁止 direct。
- 相同 invocation idempotency key + intent hash 返回 existing；相同 key + 不同 hash 返回 conflict。
- checkpoint event gap、revision 落后或 authoritative ID 缺失时返回 `rebuild_required` 并丢弃 context hints。

Phase 0 不实现 hash 的数据库唯一约束；只固定 canonical serialization/hash input 和纯函数结果。

### Task 6：锁定现有执行事实边界

**Files**

- Create: `apps/server-next/tests/phase-0-management-boundary.test.ts`
- Modify only if a missing test seam is proven: `apps/server-next/src/application/usecases.ts`
- Modify: `apps/server-next/tests/readiness-check.test.ts`
- Modify: `scripts/check-agentbean-next-readiness.mjs`

**Regression cases**

- 现有 direct channel/DM message 仍只创建现有 Dispatch，不创建 Invocation 或 Management Event。
- Dispatch status 仍来自 Dispatch repository；Message 只投影 `dispatchStatus/dispatchId`，见 `packages/contracts/src/message.ts:32-39`。
- Task create/update/delete 行为和 `in_review -> done` 人类审核语义不改变。
- Artifact 与 Workspace Run 继续关联 `dispatchId`，不要求 `invocationId`。
- Socket event map 不新增 management commands。
- Server repositories 不新增 management repositories 或 SQLite migrations。

若测试不需要 production code seam，必须保持 source 零修改；不得为了测试便利预埋 Phase 1 runtime。

### Task 7：验证 Node SEA 兼容性

**Files**

- Create: `packages/pi-management-runtime/src/sea-smoke-entry.ts`
- Create: `scripts/build-pi-management-sea.mjs`
- Create: `scripts/check-pi-management-sea.mjs`
- Create: `.github/workflows/pi-sea-compatibility.yml`
- Modify: `package.json`
- Modify: `package-lock.json`

**Build strategy**

- 使用 exact dev dependency `esbuild@0.28.1` 将 wrapper、PI runtime 与 fake model bundle 成一个 SEA entry。
- 使用 Node `26.5.0` 的 `node --build-sea`；生产 workflow 的 Node 24.15 保持不变。
- matrix：`ubuntu-latest` x64、`macos-14` arm64、`windows-latest` x64。
- macOS 执行 ad-hoc codesign；Windows 使用 `.exe`，不要求发布证书。
- 每个平台上传 verdict JSON；不上传模型凭证、Session 内容或用户数据。

**Verdict schema**

```ts
interface PiSeaCompatibilityVerdictV1 {
  schemaVersion: 1;
  os: 'linux' | 'macos' | 'windows';
  arch: 'x64' | 'arm64';
  nodeVersion: string;
  piVersion: '0.80.6';
  status: 'compatible' | 'blocked-for-phase5';
  checks: Array<{ id: string; ok: boolean; diagnosticCode?: string }>;
}
```

任一失败必须转成稳定 diagnostic code；不能用 `continue-on-error` 把未知结果伪装成成功。workflow 可以让 matrix job 失败，但最终 aggregator 必须总能上传完整 verdict，并由验收矩阵记录结论。

### Task 8：接入 root CI gate

**Files**

- Modify: `package.json`
- Modify: `.github/workflows/ci-cd.yml`
- Modify: `scripts/check-agentbean-next-readiness.mjs`
- Modify: `apps/server-next/tests/readiness-check.test.ts`

**Root scripts**

- `test:pi-management-runtime`
- `test:phase0`
- `build:pi-management-runtime`
- `build:phase0`
- `check:phase0-pi-boundary`
- `check:pi-sea-compatibility`（消费 verdict，不在 Node 24 job 构建 SEA）

`test:phase0` 包含 wrapper、Contracts、Domain、boundary checker 和 Server management boundary regressions。现有 `test:phase1` 保留兼容入口，但 CI 改为依次运行 Phase -1/现有产品回归与 Phase 0 gate；后续可在独立任务统一命名，Phase 0 不顺手重命名全部历史 scripts。

CI change detector 必须覆盖新 package、SEA scripts、Phase 0 matrix 和 workflow。PI wrapper/contract 变更时，普通 validate job 与 SEA workflow 都必须触发。

### Task 9：完成验收矩阵和 Phase 1 handoff

**Files**

- Modify: `agentbean-next/docs/phase-0-pi-contract-compatibility-verification-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`（只链接实际 verdict，不改设计边界）
- Modify: `README.md`（只增加开发者入口，不宣传用户可用 PI 管理能力）

**Closeout evidence**

- exact npm version、lockfile integrity 和 license/source link。
- wrapper API declaration snapshot。
- effective resources/tools negative-test evidence。
- Contracts/Domain/Server regression counts。
- Node 24 build/runtime evidence。
- SEA 三平台 verdict 和日志 URL。
- main CI run URL。

Phase 0 closeout PR 只能在所有 P0 条目有实际证据后把状态改为 `complete`。如果 SEA 有平台 blocker，Phase 0 可以完成，但必须同时创建带 `phase-5-blocker` 标签的 Issue；P0-11 记录 `blocked-for-phase5`，不得写 Green compatible。

## 7. PR 切片与依赖

| 顺序 | PR | 内容 | 前置 |
|---|---|---|---|
| 0 | 本计划 | Phase 0 边界、任务和验收合同 | Phase -1 complete |
| 1 | Runtime boundary | Task 1-3：checker、wrapper、hermetic resources/tools | 计划已评审 |
| 2 | Contract boundary | Task 4-5：Contracts 与纯 Domain rules | PR 1 的 wrapper public vocabulary |
| 3 | Existing behavior lock | Task 6：Server/direct regression 与 readiness | PR 2 contracts |
| 4 | SEA verdict | Task 7：bundle、三平台 SEA workflow、verdict | PR 1 wrapper |
| 5 | CI integration | Task 8：root scripts、validate closure | PR 2-4 |
| 6 | Verification-only closeout | Task 9：实际证据与 Phase 1 handoff | PR 5 main CI |

PR 2 与 PR 4 可以从 PR 1 合并后的 `main` 并行；其他依赖按表顺序执行。每个 PR 必须有独立 Issue 和中文 GitHub 内容。

## 8. 验证命令

```bash
npm ci
npm run test:phase0-boundary
npm run check:phase0-pi-boundary
npm run test:pi-management-runtime
npm run test:contracts
npm run test:domain
npm run test:server-next
npm run test:phase0
npm run build:contracts
npm run build:domain
npm run build:pi-management-runtime
npm run build:server-next
npm run build:phase0
npm run test:phase1
npm run build:packages
npm run check:agentbean-next-readiness
npm run test:team-terminology
npm run check:team-terminology
```

SEA workflow 不能用本机单平台结果替代，必须引用 GitHub matrix run。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| PI API 快速变化 | exact pin `0.80.6`；所有 PI import 限制在 wrapper；升级必须单独 PR 重跑 SEA 与 API snapshot |
| 默认资源发现加载用户代码 | 自定义 hermetic loader；空 HOME/cwd 恶意 fixture；effective resource 等值断言 |
| coding tools 意外进入管理 Agent | `noTools: "builtin"` + catalog allowlist + runtime effective tool inspection + import guard |
| wrapper 泄漏 PI 类型导致全仓耦合 | declaration scan；public API 不出现 `@earendil-works`；其他 package import guard |
| type-only contract 被误当已实现能力 | 不接 Socket/repository/migration；README 不宣传用户功能；P0 matrix 明确 unavailable |
| Invocation 与 Dispatch 双事实源 | Invocation view 只定义派生规则；Phase 0 不增加 status writer；Server boundary regressions |
| SEA 对 native/dynamic resource 不兼容 | 三平台真实 Session smoke；稳定 diagnostic；失败形成 Phase 5 blocker，不阻塞 Phase 1 Node runtime |
| Node 26 SEA 与生产 Node 24 混淆 | 独立 workflow；生产 Node 不升级；wrapper 必须先在 Node 24.15 build/test |
| fake model 让测试偏离真实 SDK | fake 只替代 provider 响应，Session/resource/tool/event 路径使用真实 PI SDK |

## 10. 回滚

- Phase 0 没有生产 rollout、schema 或用户数据迁移。
- 任一实现 PR 可通过 Git revert 完整撤销。
- 删除 wrapper package 后必须同步删除 root scripts、CI paths 和 lockfile entries。
- Contracts 已被下游引用后不得静默重写；变更 schemaVersion 或新增 V2，并保留明确拒绝/升级策略。
- PI 升级失败时回退 exact package version并重跑 wrapper、boundary 与 SEA 全套证据；不能让 Server/Device 直接绕过 wrapper 使用新 SDK。

## 11. Phase 1 启动门禁

Phase 1 独立实施计划只能在以下条件同时成立后编写：

1. P0-01 至 P0-10、P0-12 全部 Green。
2. P0-11 已是 `compatible` 或明确的 `blocked-for-phase5`，不允许 `unknown`。
3. wrapper 在 Node 24.15 下通过 deterministic Session lifecycle tests。
4. no coding tools / no resource discovery 负向测试全绿。
5. contracts 和 domain rules 已进入 `main`，main CI 成功。
6. 现有 direct Dispatch/Task/Artifact/Workspace Run 回归全绿。
7. Phase 0 verification-only closeout PR 已合并。

Phase 1 才开始实现 `DeviceServiceCore`、`PiManagerWorkerHost`、`ManagementRun` persistence/lease 和单外部 Agent targeted invocation。

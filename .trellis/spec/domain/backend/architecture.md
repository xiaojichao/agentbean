# 架构：@agentbean/domain 的角色与核心抽象

## 何时适用

- 第一次接触 `packages/domain/` 任何文件时。
- 判断"某个业务决策应该写在哪一层"时。
- 需要理解 identity / task-claim / output-package / channel / memory-hashing 之一的职责边界时。

## 本包的角色

**纯领域逻辑**。具体地：

- 做：定义 `*-policy.ts` 决策函数（取快照输入 → 返回 `readonly` 判别联合决策）；值对象 normalizer（`identity.ts` / `routing.ts` / `search.ts`）；Record / Snapshot / Decision 类型形状。
- 不做：不定义 Repository 接口（那些在 `apps/server-next/src/application/*-repositories.ts`）；不做任何 SQLite 访问、网络、文件、时钟、随机。

证据：`grep -rln "Repository" packages/domain/src/` 零命中。包内全文对 `node:fs` / `node:http` / `fetch(` / `console.` / `Date.now` / `performance` / `Math.random` / `process.env` / `setTimeout` 零命中（已扫描 `packages/domain/src/`）。唯一运行时 import 是 `createHash` from `node:crypto`，且仅出现在 3 个文件：

- `packages/domain/src/memory-hashing.ts:1`
- `packages/domain/src/active-memory-context.ts:1`
- `packages/domain/src/pi-provider-test-policy.ts:6`

依赖清单见 `packages/domain/package.json:18-20`：唯一 dependency 是 `@agentbean/contracts`（`file:../contracts` 软链）。

## 目录结构：扁平 + 桶

```
packages/domain/
├── src/
│   ├── index.ts              # 桶：73 个 export，re-export 全部公共模块
│   ├── identity.ts           # Agent 身份键、合并投影
│   ├── task-claim-policy.ts  # Task claim 状态机
│   ├── output-package-policy.ts
│   ├── channel.ts            # 频道可见性与更新授权
│   ├── memory-hashing.ts     # 确定性 SHA-256
│   └── ...（约 70 个文件，一概念一文件）
├── tests/                    # 镜像 src/，66 个 *.test.ts
├── package.json
├── tsconfig.json             # strict + noUncheckedIndexedAccess + declaration
└── vitest.config.ts          # environment: 'node'
```

约定：**一概念一文件**。`src/` 扁平，无子目录。每个 `src/foo.ts` 配一个 `tests/foo.test.ts`。公共 API 一律经 `src/index.ts` 桶 re-export，包外（以及 server-next）只从桶导入。

## 核心抽象

### 1. Agent 身份 —— `src/identity.ts`

`AgentIdentityRecord`（`identity.ts:11-29`）是 Agent 的快照形状。`identityKeyFor`（`identity.ts:105`）把一条 record 规范化为 `AgentIdentityKey` 判别联合（custom / self-register / agentos-concrete / agentos-gateway / runtime），用于跨扫描源去重。`shouldMergeAgents`（`identity.ts:153`）判定两条 record 是否同一 Agent；`mergeAgentProjection`（`identity.ts:172`）把多条合并成一条 `AgentProjection`，按 displayRank + lastSeenAt 选展示 record、按时间选 status。

### 2. Task claim 状态机 —— `src/task-claim-policy.ts`

四个纯函数覆盖 claim 全生命周期：

- `evaluateTaskClaimAcquire`（`task-claim-policy.ts:186`）→ `TaskClaimAcquireDecision`（granted / existing / rejected）
- `evaluateTaskClaimRenew`（`task-claim-policy.ts:260`）→ renewed / rejected
- `evaluateTaskClaimRelease`（`task-claim-policy.ts:273`）→ released / already-released / rejected
- `authorizeTaskClaimWrite`（`task-claim-policy.ts:282`）→ authorized / rejected
- `inspectTaskClaim`（`task-claim-policy.ts:151`）→ 只读状态查询（unclaimed / active / expired / released / invalid）

时钟以 `now: number` 注入（见 `TaskClaimAcquireInput.now`，`task-claim-policy.ts:32`），不读系统时钟。

### 3. OutputPackage 成形 —— `src/output-package-policy.ts`

`evaluateOutputPackageFormation`（`output-package-policy.ts:111`）是单一入口，输入全部是 Server 加载的已持久化快照（staging / revision / task / coordination / claim / invocation / workspaceRun），返回 `OutputPackageFormationDecision`（`output-package-policy.ts:102-104`）：

- `rejected` + 结构化 `reasonCode`（无副作用，committed revision 保持可恢复）
- `create` + 完整 `OutputPackageFormationPlan`（冻结成员、delivery lineage，落库后不可变）

关键不变量见文件头注释（`output-package-policy.ts:3-17`）：package 出现不推进 Task；同一 delivery 同一逻辑 collection 至多一个 delivered version。

### 4. 频道授权 —— `src/channel.ts`

- `canViewChannel`（`channel.ts:31`）：public 频道全员可见；private 频道查成员表。
- `canApplyChannelUpdate`（`channel.ts:50`）：归档频道拒绝任何元数据修改（`archivedAt != null` 即 false）；非创建者拒绝；默认频道（`name === 'all'`）只允许改 title。

### 5. 确定性哈希 —— `src/memory-hashing.ts`

`hashMemoryContent` / `hashSourceRefs` / `computeProjectionHash` / `hashCapsuleItems`（`memory-hashing.ts:19/23/48/65`）是 capsule 内容与来源指纹的**单一哈希源**。源按 `sourceKind:sourceId:snapshotHash` 升序 join `|`，与输入顺序无关——这是 replay 测试能稳定通过的前提。

## domain 与 infra 的接缝

domain 定义 Record / Snapshot 形状，但**Repository 契约 + 全部 SQLite 访问在 server-next**。canonical 流程见 `apps/server-next/src/application/output-package-handler.ts:30`：

> handler 只加载事实 → 调 domain 纯函数 evaluateOutputPackageFormation → 组装 record/write → 调 OutputPackageRepository.recordPackageFormation（单事务原子提交）

即：application handler 负责加载事实、调纯函数、组装写入、单事务提交；domain 只回答决策。新功能按此分层，不要在 domain 里加持久化或把 SQL 放进来。

## 佐证文件

- `packages/domain/package.json`
- `packages/domain/tsconfig.json`
- `packages/domain/src/index.ts`
- `packages/domain/src/identity.ts`
- `packages/domain/src/task-claim-policy.ts`
- `packages/domain/src/output-package-policy.ts`
- `packages/domain/src/channel.ts`
- `packages/domain/src/memory-hashing.ts`
- `apps/server-next/src/application/output-package-handler.ts`
- `apps/server-next/src/application/*-repositories.ts`（Repository 契约所在）

## 反模式

- 在 `packages/domain/src/` 下新增子目录拆分——保持扁平一概念一文件。
- 把 Repository 接口或 SQL 写进 domain——本包零 `Repository` 命中，接缝在 server-next。
- 在 policy 函数里读系统时钟或生成随机数——破坏 replay，见 [gotchas.md](./gotchas.md) 确定性泄漏。
- 跨过桶直接 `import { ... } from '../src/foo.js`（包外）——公共 API 必须经 `src/index.ts`。

## 验证命令

```bash
# 确认零禁用 import（应零命中）
grep -rnE "from 'node:fs'|from 'node:http'|from 'node:net'|fetch\(|console\.|Date\.now|Math\.random|process\.env|setTimeout" packages/domain/src/

# 确认 node:crypto 只在 3 个文件
grep -rn "from 'node:crypto'" packages/domain/src/

# 确认 domain 不含 Repository 接口（应零命中）
grep -rln "Repository" packages/domain/src/

# 编译 + 测试
pnpm --filter @agentbean/domain build
pnpm --filter @agentbean/domain test
```

# 编码约定：纯函数纪律与分层边界

## 何时适用

- 在 `packages/domain/src/` 下新增或修改任何 `.ts` 时。
- 判断一个新决策该写成纯函数还是放进 application handler 时。
- 审查本包 PR 时核对纪律是否被守住。

## 1. 纯函数纪律（严格可验证）

每个 `*-policy.ts` 导出的决策函数：输入只读快照，返回 `readonly` 判别联合，无副作用。**唯一允许的运行时 import 是 `createHash` from `node:crypto`**（确定性 SHA-256），且只在 3 个文件出现：

- `packages/domain/src/memory-hashing.ts:1`
- `packages/domain/src/active-memory-context.ts:1`
- `packages/domain/src/pi-provider-test-policy.ts:6`

`src/` 全文对以下符号**零命中**（已扫描）：`node:fs` / `node:http` / `node:net` / `fetch(` / `console.` / `Date.now` / `performance` / `Math.random` / `process.env` / `setTimeout`。

规则：新增 policy 不要 import 任何 `node:` 模块（除 `node:crypto` 且仅在确定性哈希场景）；不要调系统时钟或随机源。需要"当前时间"就要求调用方在 input 里传 `now: number`。

## 2. readonly：输入与输出都 readonly

决策函数的输入接口字段一律 `readonly`，返回的判别联合成员也 `readonly`。示例：

- `TaskClaimAcquireInput`（`task-claim-policy.ts:22-34`）：所有字段 `readonly`，数组字段 `readonly string[]`。
- `TaskClaimAcquireDecision`（`task-claim-policy.ts:45-52`）：`readonly kind` / `readonly lease` / `readonly reason`。
- `OutputPackageFormationPlan`（`output-package-policy.ts:89-100`）：`members: readonly OutputPackageMemberPlan[]`。

## 3. 时钟以 `now: number` 注入

domain 不读系统时钟。需要时间判定的 policy，input 必带 `now: number`，由 application 层注入。

证据：`TaskClaimAcquireInput.now`（`task-claim-policy.ts:32`）、`TaskClaimRenewInput.now`（`task-claim-policy.ts:82`）、`TaskClaimReleaseInput.now`（`task-claim-policy.ts:94`）。`evaluateTaskClaimAcquire` 内部所有 `acquiredAt` / `renewedAt` / `expiresAt` 计算都基于 `input.now`（见 `grantedLease`，`task-claim-policy.ts:171-184`）。

规则：新 policy 需要时间，就在 input 接口加 `readonly now: number`，不要 import 时钟。

## 4. clone-before-sort：从 readonly 输入派生数组必须先复制

`Array.prototype.sort` 原地排序，会破坏 `readonly` 输入。正确写法是先扩展复制再排：

```ts
// identity.ts:177 —— 正确：[...records].sort(...)
const displayRecord = [...records].sort((left, right) => { ... })[0];
```

`mergeAgentProjection`（`identity.ts:172-202`）两处 sort 都用 `[...records].sort(...)`。`memory-hashing.ts:24` 的 `hashSourceRefs` 同样 `[...refs]` 复制后再 map/sort。

规则：对入参数组（哪怕标了 `readonly`）做 sort / map-chaining-mutate 前，先 `[...]` 或 `[...x]` 浅复制。详见 [gotchas.md](./gotchas.md) readonly 幻觉一节。

## 5. domain-vs-infra 边界：决策在 domain，落库在 server-next

domain 定义 Record / Snapshot 形状，**不定义 Repository 接口**，**不做 SQLite 访问**。Repository 契约（如 `OutputPackageRepository.recordPackageFormation`）与全部持久化在 `apps/server-next/src/application/*-repositories.ts`。

canonical 流程见 `apps/server-next/src/application/output-package-handler.ts:30`：

> handler 只加载事实 → 调 domain 纯函数 evaluateOutputPackageFormation → 组装 record/write → 调 OutputPackageRepository.recordPackageFormation（单事务原子提交）

判断新代码归属的规则：

- 回答"能不能 / 是什么决策"（授权、状态机、成形判定、去重指纹）→ `packages/domain/src/`。
- 加载事实、调纯函数、组装写入、开事务提交 → `apps/server-next/src/application/`。
- 定义 `*Repository` 接口或写 SQL → `apps/server-next/src/application/*-repositories.ts`。

## 6. 桶纪律：新 export 必须进 `src/index.ts`

公共 API 一律经桶 re-export。在 `src/foo.ts` 加了 `export function bar`，必须同步在 `src/index.ts` 加 `export { bar } from './foo.js'`。否则：vitest 能过（测试从 `../src/index.js` 导入，但若测试直接从 `../src/foo.js` 导入则照样绿），但 `tsc`/包外消费者会找不到——`pnpm --filter @agentbean/domain build` 失败。详见 [gotchas.md](./gotchas.md) 桶幽灵导出一节。

## 7. 一概念一文件 + 镜像测试

`src/` 扁平，一概念一文件。每个 `src/foo.ts` 配一个 `tests/foo.test.ts`。新增 `src/foo-policy.ts` 就新增 `tests/foo-policy.test.ts`，从 `../src/index.js` 导入（走桶，顺便覆盖桶完整性）。

## 佐证文件

- `packages/domain/package.json`（唯一依赖 contracts）
- `packages/domain/tsconfig.json`（`strict` + `noUncheckedIndexedAccess` + `declaration`）
- `packages/domain/src/task-claim-policy.ts`（now 注入、readonly 判别联合样本）
- `packages/domain/src/identity.ts:177`（clone-before-sort）
- `packages/domain/src/memory-hashing.ts:24`（clone-before-sort on readonly refs）
- `packages/domain/src/output-package-policy.ts`（readonly 计划 + 决策）
- `packages/domain/src/index.ts`（桶，73 export）
- `apps/server-next/src/application/output-package-handler.ts:30`（分层 canonical 流程）

## 反模式

- policy 里 `import { now } from '...'` 或 `Date.now()`——破坏 replay，见 [gotchas.md](./gotchas.md)。
- 直接 sort 入参 `readonly` 数组——原地改写，见 [gotchas.md](./gotchas.md)。
- 把 Repository 接口或 SQL 写进 domain——越界，应放 server-next。
- 在 `src/foo.ts` 加 export 忘加 `src/index.ts`——vitest 绿但 tsc 挂。
- 从 readonly 输入返回派生数组前不 clone——PR#848 修过本包这类共享可变引用泄漏。

## 验证命令

```bash
# 纯函数纪律：零禁用符号
grep -rnE "from 'node:fs'|from 'node:http'|from 'node:net'|fetch\(|console\.|Date\.now|Math\.random|process\.env|setTimeout" packages/domain/src/
# node:crypto 仅 3 文件
grep -rn "from 'node:crypto'" packages/domain/src/

# readonly/类型纪律：tsc 编译（同时验证桶完整）
pnpm --filter @agentbean/domain build

# 测试
pnpm --filter @agentbean/domain test
```

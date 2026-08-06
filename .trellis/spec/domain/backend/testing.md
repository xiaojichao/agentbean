# 测试：风格、代表文件、命令

## 何时适用

- 在 `packages/domain/tests/` 下新增或修改任何 `*.test.ts` 时。
- 新增 `src/*.ts` 需要补对应测试时。
- 排查"vitest 绿但 tsc/CI 红"时。

## 风格

### 框架与环境

- `vitest` + `environment: 'node'`（见 `packages/domain/vitest.config.ts`）。
- include glob：`tests/**/*.test.ts`。
- 一文件配一测试：`src/foo.ts` ↔ `tests/foo.test.ts`，镜像结构，当前 66 个测试文件。

### 导入走桶

测试从 `../src/index.js` 导入被测符号（走桶，顺便覆盖桶完整性）：

```ts
// tests/task-claim-policy.test.ts:4-13
import {
  authorizeTaskClaimWrite,
  evaluateTaskClaimAcquire,
  ...
  type TaskClaimLeaseRecord,
} from '../src/index.js';
```

规则：不要从 `../src/foo.js` 直接导入——那样桶幽灵导出（见 [gotchas.md](./gotchas.md) 第 4 条）会逃过测试。统一走 `../src/index.js`。

### builder 模式构造输入

每个测试文件顶部定义 builder 函数，给出合理默认值，用 `overrides` 局部覆盖。代表：

```ts
// tests/task-claim-policy.test.ts:15-34
function acquireInput(
  current: TaskClaimLeaseRecord | undefined = undefined,
  overrides: Partial<TaskClaimAcquireInput> = {},
): TaskClaimAcquireInput {
  return {
    current,
    taskId: 'task-1',
    taskRevision: 2,
    taskAttempt: 1,
    nodeKind: 'subtask',
    agentId: 'agent-1',
    leaseTokenHash: 'token-hash-1',
    leaseFingerprint: 'fingerprint-1',
    ancestorAgentIds: [],
    now: 100,
    ttlMs: 60,
    ...overrides,
  };
}
```

规则：新增 policy 测试照搬此模式——builder 给默认值，用例只填关心字段；`now` 等注入值用固定整数（如 `100`），不要用 `Date.now()`。

### 断言判别 kind 后 narrow

决策函数返回判别联合，先断言 `kind`，再用类型守卫 narrow 访问负载：

```ts
// tests/task-claim-policy.test.ts:36-41
function granted(input: TaskClaimAcquireInput = acquireInput()): TaskClaimLeaseRecord {
  const decision = evaluateTaskClaimAcquire(input);
  expect(decision.kind).toBe('granted');
  if (decision.kind !== 'granted') throw new Error('expected granted claim');
  return decision.lease;
}
```

`expect(decision.kind).toBe('granted')` 之后跟一个 `if (decision.kind !== 'granted') throw` 让 TS narrow 出 `lease`，避免 `as` 断言。规则：测试断言拒绝/接受都用判别 kind，不要对整个对象做 deep equal 除非确实要锁定全部字段。

## 代表文件

- `packages/domain/tests/task-claim-policy.test.ts`：claim 全生命周期，builder + narrow 断言的范本。
- `packages/domain/tests/output-package-policy.test.ts`：成形判定，覆盖每个 `reasonCode` 拒绝路径与 `create` 成功路径。
- `packages/domain/tests/domain-core.test.ts`：身份键（`identityKeyFor` / `shouldMergeAgents`）、合并投影（`mergeAgentProjection`）等核心逻辑。

查全部测试文件：`ls packages/domain/tests/`。

## 命令

```bash
# 跑本包全部测试（vitest run，非 watch）
pnpm --filter @agentbean/domain test

# 跑单个测试文件
pnpm --filter @agentbean/domain exec vitest run tests/task-claim-policy.test.ts

# tsc 编译（验证桶完整 + 类型，捕获幽灵导出）
pnpm --filter @agentbean/domain build
```

## 判定标准

- `pnpm --filter @agentbean/domain test` 必须全绿。
- **vitest 绿 ≠ 类型正确**。改过 `src/*.ts` 的 export 或桶后，必须额外跑 `pnpm --filter @agentbean/domain build`（`tsc`）确认桶完整、无幽灵导出（见 [gotchas.md](./gotchas.md) 第 4 条、memory `vitest≠tsc 幽灵导出盲点`）。
- 声明全绿前跑完整测试，不要跑子集（见 memory `子集测试漏集成路径`）。

## 佐证文件

- `packages/domain/vitest.config.ts`（environment: node、include glob）
- `packages/domain/tsconfig.json`（strict + noUncheckedIndexedAccess + declaration）
- `packages/domain/package.json:15-17`（`test` script = `vitest run`）
- `packages/domain/tests/task-claim-policy.test.ts:1-41`（builder + 桶导入 + narrow 断言范本）

## 反模式

- 测试从 `../src/foo.js` 直接导入（绕过桶，漏掉幽灵导出）。
- 在 builder 里用 `Date.now()` 或 `Math.random()` 填 `now`（破坏 replay 稳定性）。
- 用 `decision as { kind: 'granted'; ... }` 强断言，而不先 `expect(kind).toBe(...)` + 守卫 narrow。
- 只跑单文件测试就声称全绿——必须跑完整 `pnpm --filter @agentbean/domain test`。
- 改过 export 不跑 `build`（tsc）——幽灵导出在 vitest 下隐藏。

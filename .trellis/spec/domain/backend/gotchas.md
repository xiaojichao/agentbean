# 陷阱：已踩过的坑与成因

## 何时适用

- 在 `packages/domain/src/` 改完代码、跑测试前。
- 审查本包 PR 时逐条核对。
- 测试绿但生产/CI 出现怪异行为时归因。

---

## 1. readonly 是编译期幻觉——嵌套数组/对象仍可变

TypeScript 的 `readonly` 只在编译期挡住顶层字段的重新赋值，嵌套的数组/对象元素运行时仍可被 `sort` / `push` / 属性赋值改写。对本包影响最大的两类操作：

### 1a. `Array.prototype.sort` 原地破坏 readonly 输入

`sort` 原地排序。对入参 `readonly` 数组直接 sort 会改写调用方的数据。

正确写法（`identity.ts:177`）：先 `[...records]` 复制再排：

```ts
const displayRecord = [...records].sort((left, right) => { ... })[0];
```

`mergeAgentProjection`（`identity.ts:172-202`）两处 sort 都这样。`hashSourceRefs`（`memory-hashing.ts:24`）也是 `[...refs]` 复制后再处理。

规则：对 `readonly T[]` 入参做 sort / mutate 前，必须先 `[...]` 浅复制。

### 1b. 从 readonly 输入返回派生数组必须 clone

PR#848 修过本包这类"共享可变引用泄漏"——纯函数把入参数组的引用直接塞进返回值，调用方后续修改会回流污染。从 readonly 输入派生数组返回时，用 `.map()`（生成新数组）、`[...x]`、`Array.from(...)` 等制造新引用，不要原样回传。

佐证：`identity.ts` 的 `mergeVisibleTeamIds` / `mergeUnique`（`identity.ts:271-277`）都走 `Array.from(new Set(...))` 产出新数组；`projectPublishedAgent`（`identity.ts:204-212`）用 `mergeUnique([...])` 复制。

---

## 2. server-next 用相对路径绕过包名导入

domain 编译到 `packages/domain/dist/`，但 server-next **不**通过 `@agentbean/domain` 包名导入。它用相对路径直接指向源码：

- `apps/server-next/src/application/output-package-handler.ts:13` → `from '../../../../packages/domain/src/index.js'`
- 同文件 contracts 也走相对路径：`output-package-handler.ts:4,9` → `'../../../../packages/contracts/src/index.js'`

原因（见 `output-package-handler.ts:2-3` 注释）：server-next 的 vitest 无别名解析、CI 不构建各包的 `dist/`，包名 import 会解析到 `node_modules` 里的 stale 软链 dist 导致 CI 失败。

影响：

- 改 domain 公共 API 时，server-next 是源码级消费，改完要同步检查 server-next 编译。
- worktree 场景下 `node_modules/@agentbean/domain` 软链可能指向主区 stale 包——本地重建参考 memory 中 worktree node_modules 解析陷阱。
- daemon-next（`apps/daemon-next`）消费构建后的 `dist/`，走包名 import——两套消费路径并存。

规则：在 server-next 里 import domain 时照搬相对路径写法（注释明示"server-next 惯例"），不要改成包名 import。

---

## 3. 确定性泄漏：给 policy 加 Date.now/Math.random/crypto.randomUUID 静默破坏 replay

本包所有决策函数设计为 replay-stable：同一输入永远同一输出。一旦在 policy 里引入非确定性来源，replay 测试会间歇性失败，且失败原因极难定位（因为输入看起来"一样"）。

禁区：

- `Date.now()` / `performance.now()` → 时钟总以 `now: number` 注入（见 `TaskClaimAcquireInput.now`，`task-claim-policy.ts:32`）。
- `Math.random()` → 无业务场景应使用；需要随机应让调用方注入种子或值。
- `crypto.randomUUID()` → 只用 `createHash('sha256')`（`memory-hashing.ts:1` 等三处）做确定性指纹，不要用随机 UUID。

规则：review policy 时，对新 import 要特别警惕这三个符号；新增 import 必须能解释清楚为什么不影响确定性。

---

## 4. 桶幽灵导出：vitest 不查，tsc 挂

在 `src/foo-policy.ts` 加 `export function bar`，但忘了在 `src/index.ts` 加对应的 re-export。

现象：

- `tests/foo-policy.test.ts` 如果直接从 `../src/foo-policy.js` 导入 → vitest 绿。
- `pnpm --filter @agentbean/domain build`（`tsc`）可能也绿（取决于是否有人在桶里引用）。
- 但包外消费者（server-next 经相对路径、daemon-next 经 dist）从 `src/index.js` 导入 `bar` → 找不到，编译红。

这是 vitest≠tsc 盲点（见 memory：`vitest≠tsc 幽灵导出盲点`）。审查 barrel/index 类 PR 必跑 `pnpm --filter @agentbean/domain build`，不能只看 vitest。

规则：新增/删除 `src/*.ts` 的 export，必须同步改 `src/index.ts`。当前桶有 73 个 export（`grep -cE '^export ' packages/domain/src/index.ts`）。

---

## 5. PR#848 共享可变引用外泄

历史教训（见 memory `共享可变引用外泄`）：纯函数返回的对象若引用了入参（或模块级可变常量），调用方修改会回流。本包因此强化了 clone 纪律（见 conventions.md 第 4、1b 条）。`readonly` 是编译期幻觉，运行时不挡引用共享——派生数据必须复制。

---

## 佐证文件

- `packages/domain/src/identity.ts:177,271-277`（clone-before-sort、mergeUnique 复制）
- `packages/domain/src/memory-hashing.ts:1,24`（node:crypto 唯一例外、clone refs）
- `packages/domain/src/task-claim-policy.ts:32,82,94`（now 注入点）
- `packages/domain/src/index.ts`（桶，73 export）
- `apps/server-next/src/application/output-package-handler.ts:2-3,4,9,13,30`（相对路径绕包 + canonical 流程注释）

## 反模式（汇总）

- 对 `readonly` 数组直接 `.sort()` 不复制。
- 从 readonly 输入派生数组直接返回原引用（不 clone）。
- 在 policy 里写 `Date.now()` / `Math.random()` / `crypto.randomUUID()`。
- 加了 `src/foo.ts` 的 export 不更新 `src/index.ts`。
- 在 server-next 里把 domain 的相对路径 import 改成包名 import。

## 验证命令

```bash
# 确定性泄漏扫描（应零命中）
grep -rnE "Date\.now|Math\.random|crypto\.randomUUID|performance\.now" packages/domain/src/

# 桶完整性（捕获幽灵导出）
pnpm --filter @agentbean/domain build

# clone-before-sort 抽查：确认 sort 前有 [...]
grep -nE "\.sort\(" packages/domain/src/*.ts

# 确认 server-next 仍用相对路径 import domain（应命中 .js 相对路径）
grep -rn "packages/domain/src/index.js" apps/server-next/src/
```

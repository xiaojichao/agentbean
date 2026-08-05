# 测试：RTL+jsdom、renderToString 首帧、data-smoke

## 何时适用

写新测试、改既有测试、断言「路由派生状态」的首帧、为浏览器 smoke 点选元素时。

## 本地模式

### 1. vitest 默认 env=node；DOM/React 测试首行切 jsdom

`apps/web-next/vitest.config.ts:14-16` 默认 `environment: 'node'`、`include: ['tests/**/*.test.{ts,tsx}']`。用到 DOM 或 React 组件的测试，**首行**写：

```ts
// @vitest-environment jsdom
```

代表：`apps/web-next/tests/members-page-route-selection.test.tsx:1`、`apps/web-next/tests/formal-memory-panel.test.tsx:1`、`apps/web-next/tests/package-review-card.test.tsx:1`。纯逻辑测试（如 `tests/chat-scope.test.ts`、`tests/dispatch-failure.test.ts`）不切 jsdom，跑在 node。

### 2. 用 RTL（`render`/`screen`/`fireEvent`/`waitFor`）+ `@testing-library/jest-dom`

样板见 `apps/web-next/tests/package-review-card.test.tsx:3-5`：

```ts
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
```

`afterEach(() => { cleanup(); vi.clearAllMocks(); })`（同文件 `:36`）。

### 3. imports 前打 `(globalThis as ...).React = React;`

`tests/members-page-route-selection.test.tsx:8`、`tests/formal-memory-panel.test.tsx:8`、`tests/package-review-card.test.tsx:8` 都在 imports 后紧跟：

```ts
(globalThis as typeof globalThis & { React: typeof React }).React = React;
```

这是仓库现有惯例（jsx 自动运行时的兜底），新 DOM/React 测试沿用。

### 4. mock `next/navigation`/`next/link`/`@/lib/store`/`@/lib/socket` 用 `vi.hoisted`

样板见 `tests/members-page-route-selection.test.tsx:11-43`：

```ts
const mocks = vi.hoisted(() => ({
  routeParams: {} as Record<string, string>,
  push: vi.fn(),
  storeState: {} as Record<string, unknown>,
}));

vi.mock('next/navigation', () => ({
  useParams: () => mocks.routeParams,
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (s: unknown) => unknown) => selector(mocks.storeState),
  useCurrentTeamPath: () => 'team-a',
}));
```

`vi.hoisted` 保证 mock 工厂能引用到变量。store mock 的套路：`useAgentBeanStore = (selector) => selector(mocks.storeState)`，在 `beforeEach` 里灌 `mocks.storeState`。

### 5. renderToString 首帧模式（断言路由派生状态回归）

这是仓库里**刻意**的特殊模式，仅用于断言「重挂载后第一帧就应正确」的路由派生状态回归。代表 `tests/members-page-route-selection.test.tsx:70-93`：

```ts
test('首帧（effect 未跑）即渲染成员详情与管理按钮', () => {
  mocks.routeParams = { teamPath: 'team-a', userId: TARGET.userId };
  const html = renderToString(React.createElement(MembersPage));
  expect(html).toContain('data-smoke="human-member-detail"');
  expect(html).toContain('data-smoke="member-role-promote-admin"');
  expect(html).not.toContain('选择左侧成员查看详情');
});
```

为什么要 `renderToString`（from `react-dom/server`）而不是 RTL 的 `render`：注释（`:62-72`）写明——`renderToString` 只做一次同步 render、**effect 完全不跑**，正好等于「首帧」；RTL 的 `render` 内部由 `act()` 包裹会同步 flush passive effect，于是 `useState(null)` + effect 从路由补回的旧实现也能通过，测试对 #853 回归失去敏感度（实测回退产品改动后 act 版断言仍全绿）。

**判定标准**：测的路由段是否是独立 route segment（其 page 体只是 `return <MembersPage />`）→ 列表→详情会整树 unmount/remount → 必须用 `renderToString` 断言首帧。其它常规交互态用 RTL `render`。

### 6. data-smoke 标记浏览器 smoke 点元素

`tests/members-page-route-selection.test.tsx:78,82` 断言的 `data-smoke="human-member-detail"`、`data-smoke="member-role-promote-admin"` 对应产品代码 `apps/web-next/components/member-detail.tsx:602,687`（另有 `:672` `member-confirm-${confirmAction}`、`:698` `member-role-demote-member`、`:709` `member-remove-open`、`:720` `member-transfer-owner-open`）。`app/[teamPath]/members/page.tsx:188` 的列表项也带 `data-smoke="human-member-item"` 与 `data-user-id`/`data-username`/`data-member-role`。

规矩：浏览器 smoke 流程真正要点/核对的元素，加 `data-smoke="<稳定名>"`；命名见名知意（`<区域>-<动作>` 或 `<区域>-<角色>`）。

### 7. 代表测试文件

- `apps/web-next/tests/members-page-route-selection.test.tsx`——renderToString 首帧回归（#853）。
- `apps/web-next/tests/formal-memory-panel.test.tsx`——复杂面板 + socket/store mock 样板。
- `apps/web-next/tests/package-review-card.test.tsx`——RTL render + waitFor 交互样板。
- `apps/web-next/tests/chat-scope.test.ts`——纯逻辑（mergeChannelHistory/isTopLevelAgentReply）。

## 佐证文件

- `apps/web-next/vitest.config.ts:8-16`（别名 `@` 与 `@agentbean/contracts`、env node、include）。
- `apps/web-next/tests/members-page-route-selection.test.tsx:1,3,8,11-43,62-93`（jsdom、renderToString、globalThis.React、vi.hoisted mock、首帧注释）。
- `apps/web-next/tests/formal-memory-panel.test.tsx:1,3-8,10-32`（jsdom、globalThis.React、socket/store mock）。
- `apps/web-next/tests/package-review-card.test.tsx:1,3-8,10-22`（jsdom、projectEvents mock、RTL render）。
- `apps/web-next/components/member-detail.tsx:602,672,687,698,709,720`（data-smoke 锚点）。

## 反模式

- 用 RTL `render`/`act` 去断言「首帧路由派生状态」——passive effect 被 flush，对 #853 类回归不敏感（注释明示回退后仍全绿）。
- DOM/React 测试漏写首行 `// @vitest-environment jsdom`——跑在 node env 报 `document is not defined`。
- 漏写 `(globalThis as ...).React = React;`——与现有测试惯例不一致。
- 把 `data-smoke` 用作纯样式锚点或随意改名——它是 smoke 流程稳定契约。
- mock store 用整对象解构而非 `(selector) => selector(state)`——选择器断言会失败。

## 验证命令

```bash
cd apps/web-next && npm test                                              # 全量
cd apps/web-next && npx vitest run tests/members-page-route-selection.test.tsx   # #853 首帧回归
cd apps/web-next && npx vitest run tests/formal-memory-panel.test.tsx            # 面板+mock 样板
cd apps/web-next && npx vitest run tests/chat-scope.test.ts                      # 纯逻辑

# 从仓库根
npm run test:web-next
```

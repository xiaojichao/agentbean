# Research: web-next 测试惯例

- **Query**: 组件测试放哪、用什么工具、首帧断言惯例
- **Scope**: internal（apps/web-next + .trellis/spec）
- **Date**: 2026-08-10

## Findings

### 主要来源

- 规范文档：`.trellis/spec/web-next/frontend/testing.md`（本主题权威来源，以下全部有佐证）。
- 配置：`apps/web-next/vitest.config.ts:8-16`（别名 `@`、`@agentbean/contracts`；默认 `environment: 'node'`；`include: ['tests/**/*.test.{ts,tsx}']`）。

### 核心规则

1. **测试位置**：`apps/web-next/tests/*.test.{ts,tsx}`（平铺，不建子目录）。组件测试与纯逻辑测试混放，按文件名见名知意。
2. **工具链**：vitest + `@testing-library/react`（render/screen/fireEvent/waitFor）+ `@testing-library/jest-dom` + jsdom。
3. **DOM/React 测试首行必须写** `// @vitest-environment jsdom`（默认 env 是 node，漏写报 `document is not defined`）。纯逻辑测试（如 chat-scope.test.ts）不切。
4. **imports 后紧跟** `(globalThis as typeof globalThis & { React: typeof React }).React = React;`（jsx 自动运行时兜底，仓库惯例）。
5. **mock 用 `vi.hoisted`**：`next/navigation`（useParams/useRouter/useSearchParams）、`@/lib/store`（`useAgentBeanStore = (selector) => selector(mocks.storeState)`，beforeEach 灌 state）、`@/lib/socket`（projectEvents/taskEvents 等方法级 mock）。样板：tests/members-page-route-selection.test.tsx:11-43、tests/stage-delivery-review-workspace.test.tsx:10-43。
6. **afterEach**：`cleanup(); vi.clearAllMocks();`
7. **renderToString 首帧模式**：仅用于「路由派生状态首帧必须正确」的回归（独立 route segment 会整树 unmount/remount 的场景）。`renderToString` 只做一次同步 render、effect 完全不跑=首帧；RTL render 内部 act() 会 flush passive effect，对 #853 类回归不敏感（实测回退产品改动仍全绿）。代表：tests/members-page-route-selection.test.tsx:70-93。**常规交互态仍用 RTL render**。
8. **data-smoke 契约**：浏览器 smoke 真正要点/核对的元素加 `data-smoke="<区域>-<动作|角色>"`，是稳定契约，不能当纯样式锚点或随意改名。

### 与本任务最相关的代表测试

| 测试文件 | 覆盖 |
|---|---|
| `apps/web-next/tests/stage-delivery-review-workspace.test.tsx` | #1177 阶段工作区：mock projectEvents.queryStageDeliveryReviewWorkspace/taskEvents，RTL render 断言区块/按钮/对话框 |
| `apps/web-next/tests/package-review-card.test.tsx` | RTL render + waitFor 交互样板 |
| `apps/web-next/tests/project-files-board.test.tsx` | Files 板 |
| `apps/web-next/tests/output-package-reference.test.tsx`、`output-package-reference-builders.test.ts` | 引用构建层 |
| `apps/web-next/tests/chat-thread-mention.test.ts` | thread @ 选择器逻辑 |
| `apps/web-next/tests/channel-task-card.test.tsx`、`channel-project-overview.test.tsx`、`channel-project-progress.test.tsx` | 任务/阶段卡片 |

### 验证命令

```bash
cd apps/web-next && npm test                      # 全量（vitest run）
npm run test:web-next                              # 从仓库根
cd apps/web-next && npx vitest run tests/<file>    # 单文件
```

## Caveats / Not Found

- 无 playwright/浏览器层测试在 apps/web-next 内（data-smoke 是给外部 smoke 流程的锚点契约）。

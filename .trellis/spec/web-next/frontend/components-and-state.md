# 组件与状态：use client、路由派生状态、单字段选择器

## 何时适用

新增页面/组件、在 Zustand store 加字段、写或改 Props 类型、决定选中态/路由参数如何驱动 UI 时。

## 本地模式

### 1. 交互组件首行 `'use client'`，页是默认导出 React 函数

- 所有 `app/**/page.tsx`、所有 `components/*.tsx`（除非纯类型工具）首行 `'use client'`。代表：`apps/web-next/app/[teamPath]/members/page.tsx:1`、`apps/web-next/components/conversation-page.tsx:1`、`apps/web-next/components/socket-provider.tsx:1`。
- 页文件 `page.tsx` 默认导出一个 React 函数。

### 2. 选中态/详情态从路由参数派生，**不**用 `useState` + passive effect 补回

这是 #853 的核心教训。`apps/web-next/app/[teamPath]/members/page.tsx:61-80` 给出正解：

- `routeAgentId`/`routeUserId` 直接从 `useParams()` 读（`:72-73`）；
- `routeSelectedId = routeAgentId ?? (routeUserId ? 'user:' + routeUserId : null)`（`:78`）；
- `selectedId = routeSelectedId ?? optimisticSelectedId`（`:80`）；
- `optimisticSelectedId` 只服务「点击后、导航落地前」这段即时高亮，不承担真相源职责。

原因：`app/[teamPath]/human/[userId]/page.tsx` 与 `app/[teamPath]/agent/[agentId]/page.tsx` 是独立 route segment，page 体只是 `return <MembersPage />`。从列表跳详情会整树 unmount/remount、所有 `useState` 清零；旧实现 `useState(null)` + effect 从路由补回，导致重挂载后到 effect 提交之间存在一帧空态，详情子树（含 `data-smoke` 按钮）不在 DOM。

> 子路由别名页体（`app/[teamPath]/human/[userId]/page.tsx`、`app/[teamPath]/agent/[agentId]/page.tsx`）只写：
> ```tsx
> 'use client';
> import MembersPage from '../../members/page';
> export default function HumanDetailPage() { return <MembersPage />; }
> ```

### 3. Zustand 用**逐字段**选择器订阅，绝不选整 state

- 正解（`apps/web-next/app/[teamPath]/members/page.tsx:48-59`、`:95`）：
  ```ts
  const conn = useAgentBeanStore((s) => s.conn);
  const devices = useAgentBeanStore((s) => s.devices);
  const agentList = useAgentBeanStore((s) => s.visibleAgents);
  ```
- 反例：`const s = useAgentBeanStore();` 或 `const { conn, devices } = useAgentBeanStore();`——会让组件在任何 state 变化时都重渲染。
- Action 函数也用选择器取（`const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);`），不要从 store hook 解构。

### 4. 页里用 `useEffect` 订阅 socket，return 清理

代表 `apps/web-next/components/conversation-page.tsx:17-62`：在 effect 内 `getWebSocket()`、订阅各事件、`return () => { offX(); socket.off(...); }`。`apps/web-next/components/socket-provider.tsx:9-40` 同款：订阅 connect/disconnect/snapshot，return 里逐个 `socket.off`。

### 5. Props 内联类型；复杂 Props 用同文件 `interface`/`type` 并 `export` 复用

- 简单 props 直接内联（如 `apps/web-next/components/conversation-page.tsx:11` 的 `{ channelId, mode }: { channelId: string; mode: 'channel' | 'dm' }`）。
- 复杂/被外部复用的 props 写成同文件 `export interface`。例：`apps/web-next/components/ProjectArtifactLibrary.tsx:26` `export interface PromoteArtifactDraft`，同文件 `:71`、`:560` 复用，外部组件从此处 import。

### 6. 样式只用 Tailwind class，图标用 lucide-react

如 `apps/web-next/app/[teamPath]/members/page.tsx:130` `className="flex flex-1 overflow-hidden"`；图标 `import { Bot, Circle, ChevronRight, Monitor, User } from 'lucide-react'`（`:5`）。

### 7. 新页规矩（贡献者必做清单）

1. 在 `apps/web-next/app/[teamPath]/<segment>/page.tsx` 建文件；
2. 首行 `'use client'`，默认导出 React 函数；
3. 路由派生状态用 `useParams`/`useRouter`/`useSearchParams`，**不**用 `useState` + effect（见 #853）；
4. Zustand 用逐字段选择器；
5. 需要实时数据时在 `useEffect` 内订阅并在 return 清理。

### 8. 新组件规矩

1. 在 `apps/web-next/components/<name>.tsx` 建文件，首行 `'use client'`；
2. 仅 Tailwind class（无 CSS module），图标 `lucide-react`；
3. Props 内联类型，复杂/复用的 `export interface`；
4. 浏览器 smoke 点的元素加 `data-smoke="<name>"`（见 [testing.md](./testing.md)）。

### 9. 新状态规矩

1. 在 `apps/web-next/lib/store.ts` 的 `interface State`（`:171` 起）加字段；
2. 加类型化的 action 签名（如 `applyChannelHistory(channelId, msgs): void;`，`:202`）；
3. 用 `set((s) => ({ ... }))` 在 store 工厂里实现；
4. 消费侧用单字段选择器订阅。

## 佐证文件

- `apps/web-next/app/[teamPath]/members/page.tsx:1,61-80`（`'use client'`、路由派生状态注释与实现）。
- `apps/web-next/app/[teamPath]/human/[userId]/page.tsx`、`apps/web-next/app/[teamPath]/agent/[agentId]/page.tsx`（别名页体）。
- `apps/web-next/components/conversation-page.tsx:11,17-62`（Props 内联、effect 订阅+清理）。
- `apps/web-next/components/socket-provider.tsx:1-45`（SocketProvider effect+cleanup）。
- `apps/web-next/lib/store.ts:171-215`（State 接口）、`:202`（`applyChannelHistory` 签名）、`:338-343`（实现调 `mergeChannelHistory`）。
- `apps/web-next/components/ProjectArtifactLibrary.tsx:26,71,560`（`PromoteArtifactDraft` export 复用）。

## 反模式

- 用 `useState(null)` + passive effect 从路由补回选中态（#853 回归来源）。
- 选整 store 或解构 store hook（性能与正确性双输）。
- 在 effect 里订阅但不 return 清理（socket listener 泄漏、跨页重复触发）。
- 引入 CSS module 或非 Tailwind 样式。
- 复杂 Props 没导出，导致外部组件重新定义同结构（漂移风险）。

## 验证命令

```bash
cd apps/web-next && npm test                       # 全量 vitest
cd apps/web-next && npx vitest run tests/members-page-route-selection.test.tsx   # 单测 #853 首帧回归
cd apps/web-next && npx tsc --noEmit -p tsconfig.json   # 类型
```

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

### 10. 跨 surface 共享的业务构建逻辑抽到 `lib/` 纯函数，页面/卡片只做接线

讨论串文件包卡片与文件库工具栏共用同一套「整包投影预览 → 引用选择构建」逻辑，
抽到 `apps/web-next/lib/output-package-reference.ts`（#1060-#1063 文件库对齐）：

- `loadPackageProjection(channelId, packageId, policy)`：`getOutputPackage` 带
  projection（delivered/current/final），`!ok` 或缺 projection 返回 `null`；
- `buildPackageProjectionSelection(packageId, policy, projection)`：ready → 带
  `expectedMemberRevisions` fence 的 `ProjectReferenceSelectionRequestDto`；
  not_ready → blockers 清单（`shortLabel ?? ''` 回落，供 UI 展示缺失项）；
- `buildPackageMembersSelection(packageId, members)`：多选 → `package_members` 选择，
  空列表返回 `null`。

规矩：**抽取只允许移动，禁止顺手改语义**——以原调用方（OutputPackageCard）测试
原样通过为门槛。同理，文件库的聚合/排序/筛选/搜索谓词在
`lib/file-group-model.ts` 纯函数（`buildFileGroupCards` / `filterFileGroupCards`），
组件内不写业务逻辑。

### 11. 文件库「逻辑产物」视图 = `ProjectFilesBoard`：左文件组卡 + 右七列文件表 + 工具栏引用

`apps/web-next/components/project/ProjectFilesBoard.tsx` 是所有会话（频道、默认频道
#all、私聊）文件标签页的唯一视图（替换旧的 OutputPackageList +
ProjectArtifactLibrary 上下堆叠，也不向用户暴露「文件/逻辑产物」子切换；产品决策
2026-08-30 起恒渲染本组件——有项目画像/输出包/pending 交付/产物集合时呈现数据面，
无数据时呈现空板形态，`ConversationFiles` 附件浏览已退役，聊天附件只走消息内链路）：

- 左栏 `FileGroupRail`：输出包 / 文件集合 / **等待上游**（有阶段无产物，纯前端差集）
  三类卡片混排，按 `lastActivityAt` 倒序；kind 用不同 chip 色；已经属于
  **当前可见 OutputPackage** 的 collection 由包卡整体承载，禁止在包外再次生成集合卡；
  不可见历史包的 membership 不能据此隐藏集合，否则包列表分页后文件将失去入口；
- 右栏 `FileVersionTable`：七列（名称+collection id / 类型·阶段 / 来源 / 当前版 /
  最终版 / 审核 / 动作），选中输出包列成员行（`getOutputPackage` + projection current
  懒加载，`Map<packageId, {detail, projection}>` 缓存），选中集合列版本行，
  选中等待上游卡显示阶段占位说明；
- 工具栏固定顺序：搜索 / 全部角色 / 全部状态 / 多选引用 / 引用最终版包 /
  引用当前包（走共享抽取层，见第 10 条）；内部 `deliverable` 等通用 kind 不得作为
  “类型 / 阶段”项目语义直接展示；
- `rejected` / `changes_requested` current 阻断整包默认正式输入，但仍保留单选、
  多选稳定版本引用，并明确标为“引用以修改”，用于 Agent 重做或继续修改；
- 审核 / 设最终版 / 提升为逻辑产物版本复用 `ProjectArtifactLibrary` 导出的
  `VersionDecisionPanel` / `FinalizationHistory` / `PromoteArtifactForm`，
  不复制第二套；提升候选必须独立遍历频道完整文件树及全部分页，不得复用普通文件视图的
  当前 URL 目录、搜索、角色筛选或已加载页。

**缓存失效双通道**：`dataRevision`（`onArtifactsUpdated` 时 +1）+ `packages` 数组引用
变化（新包/新 delivery），任一变化重置包投影缓存。

> **Warning**: 删除/替换旧组件前先 `grep -rn "<组件名>" apps/web-next` 查复用方。
> `OutputPackageList` 被 `app/[teamPath]/tasks/page.tsx` 复用，`ProjectArtifactLibrary`
> 被文件库复用其子导出——「不再被文件库使用」不等于「无引用」，贸然删除会断其他页面。

## 佐证文件

- `apps/web-next/app/[teamPath]/members/page.tsx:1,61-80`（`'use client'`、路由派生状态注释与实现）。
- `apps/web-next/app/[teamPath]/human/[userId]/page.tsx`、`apps/web-next/app/[teamPath]/agent/[agentId]/page.tsx`（别名页体）。
- `apps/web-next/components/conversation-page.tsx:11,17-62`（Props 内联、effect 订阅+清理）。
- `apps/web-next/components/socket-provider.tsx:1-45`（SocketProvider effect+cleanup）。
- `apps/web-next/lib/store.ts:171-215`（State 接口）、`:202`（`applyChannelHistory` 签名）、`:338-343`（实现调 `mergeChannelHistory`）。
- `apps/web-next/components/ProjectArtifactLibrary.tsx:26,71,560`（`PromoteArtifactDraft` export 复用）。
- `apps/web-next/lib/output-package-reference.ts`（跨 surface 共享的引用构建抽取层）。
- `apps/web-next/lib/file-group-model.ts`（文件组聚合/筛选/搜索纯函数）。
- `apps/web-next/components/project/ProjectFilesBoard.tsx`（文件库逻辑产物视图：左卡右表 + 工具栏引用三入口）。

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

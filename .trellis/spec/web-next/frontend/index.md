# web-next 前端实战编码指南

本目录是 `@agentbean/web-next`（`apps/web-next`）生产 Web 前端的实战编码规范。读者=未来 AI agent 与新成员。每条规则都来自真实代码路径，无佐证不写。

## 你是谁、在改什么

`apps/web-next` 是 AgentBean 的生产 Web 前端。所有页面 client-only 渲染，数据走 socket.io-client 与 `fetch(authedApiUrl(...))`，没有 RSC/server actions。你在这里改的通常是：新增/调整某个团队作用域页面、组件、状态字段、实时事件订阅或对应测试。

## 技术栈（已核对）

- Next.js 14 App Router（`next ^14.2.13`、`reactStrictMode: true`），React 18（`react ^18.3.1`）。见 `apps/web-next/package.json` 与 `apps/web-next/next.config.mjs:3`。
- 样式 Tailwind 3.4 + PostCSS/Autoprefixer（`tailwindcss ^3.4.10`）。`apps/web-next/tailwind.config.ts:3` 扫描 `./app`、`./components`、`./lib` 下 `**/*.{ts,tsx}`。
- 状态 Zustand 4（`zustand ^4.5.5`），单 store。
- 实时 `socket.io-client ^4.7.5`，外加一层薄事件工厂包装。
- 图标 `lucide-react`；流程图 `@xyflow/react`；类名拼接 `clsx` + `tailwind-merge` + `class-variance-authority`。
- 测试 `vitest`（默认 env node）+ `@testing-library/react` + `@testing-library/jest-dom` + `jsdom`。
- 路径别名 `@/*` → 仓库根（`apps/web-next/tsconfig.json:26-30`、`apps/web-next/vitest.config.ts:8-13`）。contracts 经 `@agentbean/contracts`。

## 主题表

| 想做的事 | 先读 |
|---|---|
| 新增页面/组件/状态，理解 App Router 与目录/构建边界 | [architecture.md](./architecture.md) |
| 写交互组件、路由派生状态、Zustand 选择器、Tailwind、Props 类型 | [components-and-state.md](./components-and-state.md) |
| 新增实时事件流、合并服务端 history、系统消息过滤、顶层 Agent 回复判定 | [realtime.md](./realtime.md) |
| 写或改测试、断言首帧路由派生状态、加浏览器 smoke 点 | [testing.md](./testing.md) |
| 避坑：消息覆盖、成员详情重挂载、dispatch hint、tsconfig 排除、归因丢失 | [gotchas.md](./gotchas.md) |

每篇都包含：何时适用 / 本地模式 / 佐证文件 / 反模式 / 验证命令。

## 测试命令

```bash
# web-next 全量（vitest run）
cd apps/web-next && npm test

# 从仓库根跑 web-next 子集
npm run test:web-next
```

- `apps/web-next/package.json` 的 `test` 脚本 = `vitest run`。
- `package.json:19`（仓库根）`test:web-next` = `cd apps/web-next && npm run test -- tests --config vitest.config.ts`。
- `vitest.config.ts:14-16` 默认 `environment: 'node'`、`include: ['tests/**/*.test.{ts,tsx}']`；DOM/React 测试须首行切 jsdom（见 [testing.md](./testing.md)）。

## 全局纪律（所有篇通用）

- 注释和文档用中文；代码标识符、文件路径、命令保持英文原文（遵循仓库惯例与 `feedback-docs-language`）。
- 技术选型沿用现有惯例，实现细节照搬仓库现状（`feedback-tech-choice-follow-convention`）。
- 不要留 `TODO`、`// To be filled`、空标题。要么写完，要么不写。

## 相关 ADR（决策真相源）

本包约定由以下 ADR 治理（spec 讲"怎么动手"，ADR 讲"为什么"）：

- `docs/adr/0027-agent-pages-manage-exposure-pi-pages-consume-it.md` — agent 页管 exposure、PI 页消费
- `docs/adr/0028-pi-management-is-a-top-level-settings-area.md` — PI 管理是顶级 settings 区
- `docs/adr/0044-memory-visibility-follows-source-scope.md` — memory 可见性跟随来源 scope（`shouldHideSystemMessage` 对齐）
- `docs/adr/0060-system-admin-console-hosts-global-ops-and-pi-management.md` — 系统管理台
- `docs/adr/0066-system-activity-uses-audience-scoped-projections.md` — 系统活动受众投影（影响 activity 渲染/过滤）

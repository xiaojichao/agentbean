# 架构：Next 14 App Router、纯客户端、扁平 lib

## 何时适用

新增页面/组件、调整路由结构、改动 `lib/` 或 `src/`、修改构建配置、引入新的依赖或数据获取方式前。

## 本地模式

### 1. Next 14 App Router，纯客户端渲染，没有 RSC/server actions

- 根布局 `apps/web-next/app/layout.tsx:14-24` 默认导出 `RootLayout`，把 children 包成 `<SocketProvider><AppShell>{children}</AppShell></SocketProvider>`，`<html lang="zh-CN">`。
- 所有交互组件首行 `'use client'`（如 `apps/web-next/lib/socket.ts:1`、`apps/web-next/components/socket-provider.tsx:1`、`apps/web-next/components/conversation-page.tsx:1`、`apps/web-next/app/[teamPath]/members/page.tsx:1`）。
- 数据获取走 client-side：socket `emitWithAck`（见 `lib/socket.ts` 的 `emitWithTimeout`）与 `fetch(authedApiUrl(path))`（`apps/web-next/lib/socket.ts:90-93`）。**禁止**引入 server components、server actions、`getServerSideProps` 等。

### 2. app/ 目录=App Router，团队作用域挂在 `[teamPath]` 下

- `apps/web-next/app/` 直挂：`layout.tsx`、`page.tsx`、`globals.css`、Auth 页（`login`、`signup`、`register`、`join`、`device-login`）。
- 团队作用域路由在动态段 `app/[teamPath]/` 下：`channel/[channelId]`、`channels`、`chat`、`dm/[dmId]`、`members`、`agent/[agentId]`、`agents/[agentId]`、`human/[userId]`、`devices`、`runs`、`tasks`、`settings`、`teams`、`dashboard`。
- `dashboard` 再分子页：`agents`、`devices`、`memory`、`pi`、`pi-auto`、`runs`、`teams`、`users`（见 `apps/web-next/app/[teamPath]/dashboard/` 目录）。
- 页文件是 `page.tsx` 默认导出 React 函数；子路由别名直接 `return <MembersPage />`（见 [components-and-state.md](./components-and-state.md) 的路由别名模式）。

### 3. lib/ 扁平单文件模块，无嵌套

`apps/web-next/lib/` 全是扁平 `*.ts`：`socket.ts`、`store.ts`、`chat-scope.ts`、`system-messages.ts`、`dispatch-failure.ts`、`schema.ts`、`artifact-upload.ts`、`display-names.ts` 等（目录无子目录）。新 lib 逻辑加成 `lib/<name>.ts` 纯函数（不依赖 React），配 `tests/<name>.test.ts`。

### 4. components/ 扁平 .tsx + 少量子目录

`apps/web-next/components/` 大多扁平 `.tsx`；仅 `artifact/`、`channel-documents/`、`project/` 是子目录。新组件加 `components/<name>.tsx`。

### 5. src/ 是独立公共入口，**不进 Next build**

- `apps/web-next/tsconfig.json:43-47` `exclude` 列了 `node_modules`、`tests`、`src`。改 `src/` 不影响 `next build`。
- `apps/web-next/tsconfig.lib.json:13` `include: ["src/**/*"]`、`outDir: "dist"`、`rootDir: "../.."`。`apps/web-next/package.json` 的 `build:client` = `tsc -p tsconfig.lib.json`，`build` = `build:client && build:app`。
- `apps/web-next/src/index.ts` 导出公共 `WebSocketTransport` 类型（给 daemon 等复用），从 `../../../packages/contracts/src/index.js` re-export DTO。改 `src/index.ts` 后须跑 `npm run build:client` 让 `dist/` 更新。

### 6. 样式只走 Tailwind class

`tailwind.config.ts:3` 扫描 `./app`、`./components`、`./lib`。组件只用 Tailwind class（如 `className="flex flex-1 overflow-hidden"`），**无 CSS module**、无 styled-components。全局样式集中在 `app/globals.css`。

## 佐证文件

- `apps/web-next/next.config.mjs:3`（`reactStrictMode: true`）、`apps/web-next/package.json`（依赖版本与 scripts）。
- `apps/web-next/app/layout.tsx:14-24`（RootLayout 包装链）。
- `apps/web-next/tsconfig.json:26-30`（`@/*` 别名）、`:43-47`（exclude）。
- `apps/web-next/tsconfig.lib.json:13`（src 编译）、`apps/web-next/src/index.ts`（公共入口）。
- `apps/web-next/tailwind.config.ts:3`（扫描范围）、`apps/web-next/vitest.config.ts:8-16`（别名与 include）。
- `apps/web-next/app/[teamPath]/` 目录结构（团队作用域路由）。

## 反模式

- 引入 `'use server'`、server components、server actions、`getServerSideProps`/`getStaticProps`——本前端是 client-only。
- 在 `app/`、`components/`、`lib/` 用 CSS module 或非 Tailwind 的样式方案。
- 以为改 `src/` 会进 `next build`——它被 `tsconfig.json` 排除，只经 `tsconfig.lib.json` 进 `dist/`。
- 把 lib 嵌成 `lib/foo/bar.ts` 子目录——保持扁平。

## 验证命令

```bash
# Next 构建（含 build:client 编 src/ + build:app 编 app/）
cd apps/web-next && npm run build

# 仅编公共 lib 入口
cd apps/web-next && npm run build:client   # = tsc -p tsconfig.lib.json

# 仅 Next 应用构建
cd apps/web-next && npm run build:app      # = next build

# 类型检查由 vitest 触发；想单独跑 tsc 用
cd apps/web-next && npx tsc --noEmit -p tsconfig.json   # 查 app/components/lib 类型
```

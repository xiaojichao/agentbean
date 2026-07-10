# 第七十一切片状态：web-next App Router 页面迁移底座

## 背景

旧 `apps/web` 已经包含完整 Next.js App Router 产品页面，但 `apps/web-next` 仍长期停留在 `preview/index.html` 单页 workbench。生产 cutover 与 core smoke 已经成立后，下一阶段目标应调整为：旧版所有页面都必须进入 AgentBean Next，而不是继续把 preview shell 当成长期 WebUI。

## 本切片范围

本切片先建立迁移底座，并继续把生产式 Web 入口切到 `apps/web-next` App Router：

- 将旧 `apps/web/app` 页面树迁入 `apps/web-next/app`。
- 将旧 `apps/web/components` 与 `apps/web/lib` 迁入 `apps/web-next`。
- 将旧 Web 的 Next/Tailwind/PostCSS 配置迁入 `apps/web-next`。
- 让 `apps/web-next` 同时支持：
  - `src/index.ts` socket client package build。
  - App Router 产品页面 `next build`。
  - 现有 `preview/index.html` 与 preview/browser smoke 测试。

后续推进中，本切片继续把生产式入口切到 App Router：

- `server-next` 新增 `AGENTBEAN_NEXT_WEB_ENTRY` / `--web-entry`，支持 `preview` 与 `app` 两种 Web 入口。
- 生产式 `PORT` 启动默认 `webEntry=app`；本地无 `PORT` 默认保留 `preview`，方便继续跑既有 preview smoke。
- `/preview` 永远保留为诊断/回归入口。
- `webEntry=app` 时，`server-next` 先处理 `/healthz`、team/workspace/artifact HTTP API 和 Socket.IO，再把页面请求交给 `apps/web-next` Next handler。

## 已迁入页面

- `/`
- `/login`
- `/signup`
- `/register`
- `/join/[token]`
- `/device-login/[code]`
- `/[teamPath]/dashboard`
- `/[teamPath]/chat`
- `/[teamPath]/channels`
- `/[teamPath]/channels/[channelId]`
- `/[teamPath]/channel/[channelId]`
- `/[teamPath]/dm/[dmId]`
- `/[teamPath]/tasks`
- `/[teamPath]/runs`
- `/[teamPath]/runs/[runId]`
- `/[teamPath]/members`
- `/[teamPath]/human/[userId]`
- `/[teamPath]/agents`
- `/[teamPath]/agents/[agentId]`
- `/[teamPath]/agent/[agentId]`
- `/[teamPath]/agents/metrics`
- `/[teamPath]/devices`
- `/[teamPath]/devices/[id]`
- `/[teamPath]/teams`
- `/[teamPath]/settings`
- `/api/teams/[teamId]/artifacts/upload`

## 仍需后续切片

- 继续逐页把旧 `apps/web/lib/socket.ts` 里的 legacy event/payload 适配到 `packages/contracts` 与 `server-next` 的 canonical event contract。本切片已先修 chat/tasks/thread 主链路：
  - 默认 API/WebSocket URL 改为同源 `window.location.origin`。
  - `channel:join` 通过 `WEB_EVENTS.channel.join` 发送 `{ teamId, channelId }`。
  - `message:send` 发送 `{ teamId, channelId, body, clientMessageId, threadId, artifactIds }`，不再使用旧 `clientMsgId` / `parentMessageId`。
  - dispatch cancel 使用 `WEB_EVENTS.dispatch.cancel`。
  - message metadata 优先读取 canonical `meta`，再兼容旧 `metaJson`。
  - thread grouping 优先读取 canonical `threadId`。
- 已补第一版登录后页面级 browser smoke：脚本会通过 `/web` socket 创建隔离 session，把 `agentbean.token` / `agentbean.teamPath` 注入真实 Chrome，然后覆盖 `dashboard/chat/tasks/runs/members/devices/settings`。该 smoke 抓到并修复了 `/runs` 页面在 route team 尚未 resolve 时请求旧 `/api/teams/default/workspace-runs` 的 403。
- 已补登录后业务交互 smoke：
  - `chat` 页面通过真实 composer 发送普通消息，并刷新页面确认 channel history 恢复。
  - `tasks` 页面通过真实表单创建任务、更新状态到 `in_progress`，并刷新页面确认状态恢复。
  - `runs` 页面通过 canonical `agent:create` -> `message:send` -> daemon `dispatch:result.workspaceRun` 创建真实 workspace run，再从列表点进 `/runs/[runId]` 并刷新详情页确认恢复。
  - `members` 页面通过 canonical `join:create` + `auth:register(joinCode)` 造出第二个人类成员，再在真实页面里执行 owner 视角的 `member:update-role` 提升为 admin、降回 member，并刷新详情页确认恢复。
  - `devices` 页面通过真实 daemon `device:hello` / `device:runtimes` 造出在线设备，在 App Router 详情页执行 `device:rename`，并刷新详情页确认 canonical `name/ownerId/teamId` 恢复。
  - `settings` 页面在真实团队设置页执行 `team:update` 改名、`join:create` 创建加入链接、`join:revoke` 撤销加入链接，并刷新后确认团队名与撤销状态恢复。
  - `agents` 页面通过真实 daemon `device:hello` / `device:runtimes` 创建自定义 agent，验证列表与详情页按 route team 渲染，执行 `agent:publish` / `agent:unpublish` 切换目标团队可见性，再通过 `message:send` 触发 dispatch 并验证 metrics 页展示该 agent。
  - `channels` 页面通过真实 UI 创建频道，进入频道详情，打开编辑弹窗执行 `channel:archive`，并返回列表确认该频道不再可见。
  - Team 管理页面通过真实 UI 创建新团队，执行 `team:switch` 切到新团队并验证当前团队标记，再进入 settings 执行受控 `team:delete`，确认 fallback 回原团队且临时团队从列表消失。
  - 为稳定驱动 React controlled inputs，CDP helper 改为调用原生 value setter 后派发 input/change 事件；同时补 `icon.svg`，清理 `/favicon.ico` 404 console 噪音。
- 后续继续补充更深业务交互 smoke，重点转向更完整 admin/audit 产品面、workspace explorer 与日志检索等尚未冻结的产品面。
- 本轮 Team 管理 smoke 同时补齐了 App Router team management 适配：
  - `/:teamPath/teams` 页面为 `team:create` 表单、team 列表、当前团队标记与 `team:switch` 增加稳定 `data-smoke` hooks。
  - `team:switch` 成功后会跳转到目标 team path 的 Team 管理页，避免 URL route team 与 server current team 脱节。
  - browser smoke 在验证新 team 可切换后通过 settings 危险区域删除该临时 team，确认路由离开被删 team，并在原 Team 管理页确认临时 team 不再出现。
  - `server-next` SQLite `teams.delete` 改为按真实 schema 与 team/global DB 边界级联删除 messages、tasks、artifacts、workspace_runs、dispatches、channels、agents 与 publications，并回归覆盖非 primary team 删除后 actor fallback team 恢复。
- 本轮 `channels` 加深 smoke 同时补齐了 canonical payload 适配：
  - `channel:create` 从裸 socket emit 改为 `channelEvents().create`，显式发送 `teamId`、`humanMemberIds`、`agentMemberIds`。
  - `channel:update` / `channel:members` / `channel:add-*` / `channel:remove-*` / `channel:archive` / `channel:delete` 等 App Router 调用显式携带当前 team id，不再依赖 server-side cached current team。
  - channels 列表页按 route `teamPath` resolve team，并为创建、列表、编辑、归档确认增加稳定 `data-smoke` hooks。
- 本轮 `agents` 加深 smoke 同时补齐了 canonical payload/DTO 适配：
  - server-next 与 web-next socket 边界直接使用 canonical `primaryTeamId/visibleTeamIds`，不再为页面生成第二套空间字段。
  - `agent:publish` / `agent:unpublish` / `agent:update-config` / `agent:delete` 客户端调用支持显式管理 team id，避免详情页依赖 cached current team。
  - agents 列表、详情、metrics 页按 route `teamPath` resolve team，不再隐式依赖可能滞后的 store `currentTeamId`。
- 本轮 `devices` 加深 smoke 同时抓到并修复了 canonical contract/UI 问题：
  - 设备页统一按 server-next canonical `ownerId/teamId/name` 判断权限与显示名称。
  - `device:rename` ack 返回的 canonical device 应立即 merge 回 web store，不能只等后续 broadcast，否则页面级保存反馈可能滞后。
  - 设备 rename input 的保存逻辑需要读取当前 DOM 值兜底，避免“输入后立即保存”时 React state 尚未 flush 导致静默 no-op。
- 本轮 `settings` 加深 smoke 同时补齐了 canonical payload 适配：
  - `join:list` / `join:create` / `join:revoke` 以及 `team:update` 在 App Router settings 页显式携带当前 route team id，不再依赖 cached socket session 的 current team 兜底。
  - settings 页为 team rename 与 join link management 增加稳定 `data-smoke` hooks，真实浏览器 smoke 可验证 create/revoke 后的刷新恢复。
- 本轮 `members` 加深 smoke 同时抓到两个 canonical contract 问题并修复：
  - App Router `members:list` / `member:update-*` 不能依赖可能早于 auth token 创建的 cached socket session，必须显式带 `teamId`。
  - `server-next` SQLite `listAllMembers` 需要把可空 `users.display_name` 当 nullable 字段读取，否则新注册成员会触发 `INTERNAL_ERROR`。
- 页面级 smoke 已覆盖当前迁入 App Router 的核心业务流；完成旧版一比一替代前，剩余风险主要集中在更完整 admin/audit、workspace explorer、日志检索与长尾 UI parity。

## 验证

```bash
npm run build:web-next
npm run build:server-next
npm run test:web-next -- --api.host 127.0.0.1
npm run check:agentbean-next-readiness -- --json
```

本切片验证结果：

- `npm run build:web-next` 通过，`next build` 产出所有迁入 App Router 路由。
- `npm run build:server-next` 通过。
- `npm run test:web-next -- --api.host 127.0.0.1` 通过，3 个 test file、44 个用例。
- `npm run test:server-next -- --api.host 127.0.0.1 tests/browser-smoke-script.test.ts` 通过，23 个 test file、201 个用例。
- `npm run smoke:agentbean-next-webui -- --skip-build --timeout-ms 30000 --json` 通过，真实 Chrome 渲染 4 个公开 App Router 页面 + 7 个登录后业务页面，并覆盖 chat send/refresh restore、channels create/archive/list disappearance、Team create/switch/delete/restore、tasks create/status update/refresh restore、workspace run list/detail/refresh restore、member join/role update/refresh restore、device rename/refresh restore、settings team rename/join link create+revoke/refresh restore、agents create/publish/unpublish/metrics，且 console clean。
- `npm run build:packages` 通过。
- `npm run check:agentbean-next-readiness -- --json` 通过，38/38。

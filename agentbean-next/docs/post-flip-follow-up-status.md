# AgentBean Next post-flip follow-up status

本文记录 AgentBean Next final flip 后的 follow-up 收敛状态。它不是新的生产操作记录，而是给后续切片选择使用的当前项目地图。

## 核对时间

- 日期：2026-06-12
- 本地分支：`main` 与 `origin/main` 对齐后创建本文档分支
- GitHub 状态：核对时 open issues 与 open PR 均为空
- 最近 CI/CD：最近 8 个 `CI/CD` run 均为 `success`
- 本地 readiness：`npm run check:agentbean-next-readiness` 通过 `31/31`

这些状态会随 GitHub 与生产环境变化而漂移；执行外部操作前仍应重新核对。

## 已从 post-flip follow-up 中收敛的能力

以下能力已经不应继续作为未完成 blocker 处理：

- Final flip 与 post-flip production smoke gate。
  - strict cutover audit、public entry smoke、business smoke、rollback old-entry smoke guard 与 browser smoke CI gate 已进入主线验证。
- Authenticated socket session 与 current team 恢复。
  - web socket 可以通过 session token 恢复 user/current team；preview/browser smoke 覆盖刷新后的 session restore 与 resubscribe。
- Team/join/device invite 第一版。
  - `team:create`、`team:switch`、`join:create`、`join:validate`、`device-invite:create`、`device-invite:wait`、`device-invite:complete` 已有 contracts、use cases 与 tests。
- Dispatch lifecycle 第一版。
  - `dispatch:cancel` 已进入 web/agent event contract；server-next runtime 会定期调度 `failTimedOutDispatches` 并广播 dispatch status。
- Agent 管理面第一版。
  - `agent:publish`、`agent:unpublish`、`agent:update-config` 与 `agent:delete` 已覆盖 owner/admin 权限、visible projection、envKeys-only snapshot 与 tombstone 删除语义。
- DM/thread 第一版。
  - direct channel model、DM snapshot/history、thread id 继承与 dispatch history 去重已在 server-next 层落地。
- Artifacts/workspace runs repository/usecase 第一版。
  - daemon `dispatch:result` 可以上报 artifact metadata 与 workspace run metadata；server-next 已做 team-scoped metadata authorization。
- 真正浏览器级 E2E 第一版。
  - `npm run smoke:agentbean-next-browser` 已覆盖真实 Chrome 登录/session restore、刷新重订阅、custom agent 创建、message dispatch 与 agent reply 可见，并在 CI 上传截图/console artifacts。

## 仍需补齐的边界

### P0：生产观察证据

- 记录 final flip 后真实 Railway production volume 重启持久化证据。
- 在 24-72 小时窗口内记录 production runtime logs、socket/API 错误日志与手工浏览器观察。
- 如决定不做受控 rollback 演练，需要在 #140 或后续运维记录中写明原因。

### P1：下一条推荐实现切片

优先补 `artifact HTTP upload/download/preview route + web artifact viewer`。

原因：

- server-next 已有 artifacts/workspace runs 的 metadata model、authorization 与 message projection。
- 旧 AgentBean 已有文件上传、下载、预览和 message attachment 体验。
- 这一切片用户可见、范围清楚，并且能把已落地的 repository/usecase 能力接到真实 API/UI。

建议切片边界：

- server-next HTTP route：upload、download、preview 与 metadata read，必须复用 team/channel authorization。
- web-next preview/product shell：展示 message artifacts 与 workspace run metadata，支持下载/预览。
- tests：repository/usecase 保持现有覆盖，新增 HTTP route auth tests、web DOM/browser smoke 覆盖 artifact 可见性。
- docs：更新 `known-gaps.md`、`verification-matrix.md` 与本文件，避免再把 metadata 第一版误判为完整 artifact 产品能力。

### P2：后续产品 parity

- Tasks 与 assignee model。
- Message search。
- Channel archive/delete。
- Saved messages 与 reactions。
- Admin、metrics 与 audit requirements。
- 更完整的 settings/member/device 页面，而不是仅依赖 preview shell。

## 下一步判定

当前不应再从旧 #141-#148 follow-up 清单直接挑“未完成项”开工。下一步应先基于本文档开新的 scoped issue/PR，优先实现 artifact HTTP/viewer 切片；如果先做运维验证，则只处理 P0 生产观察证据，不混入产品功能改动。

# 设备页 / 设备详情页对等性 —— 坐实诊断与对齐计划（2026-06-21，实测修订版）

> 本文档取代同日早先的「初判版」。初判基于过时分支与 preview demo 视图，结论已被 origin/main 实测推翻。

## 0. 结论先行（实测推翻初判）

**「设备页/详情页与原 AgentBean 不一致」的主因不是前端 UI 缺失，而是：本地 preview 锁定单 HTML demo 模式 + 生产部署状态 + daemon 数据上报。**

> origin/main web-next App Router 的 `DeviceDetail` 组件**已完整实现**：设备重命名、删除、系统信息富字段（OS/架构/CPU/内存）、connectCommand、selectDirectory、daemon 版本/latest、运行时+扫描、AgentOS/自定义 Agent 分区。代码齐全（含 `data-smoke` hook）。
>
> 早先（含本会话初判）所有「设备对等性缺失」的判断，高度疑似**在 `preview`（单 HTML demo）模式下误判** —— 该模式只渲染简化面板，看不到完整 DeviceDetail。

## 1. 实测证据（origin/main HEAD `3a2ddae`，2026-06-21，本地 4100）

### 1.1 本地 preview = 单 HTML demo 模式（看不到完整页的根因）
- `dev:agentbean-next`（full-preview）默认 `webEntry='preview'`：`dev-server.ts:112` `webEntry = args['web-entry'] ?? env.AGENTBEAN_NEXT_WEB_ENTRY ?? (env.PORT ? 'app' : 'preview')`，full-preview 未设 PORT → 落到 `'preview'`。
- 根 `/` 渲染简化 demo 面板：✅ 删除 / daemon 版本 / Daemon latest / 运行时+扫描 / AgentOS+自定义 Agent 分区；❌ connectCommand / 设备重命名 / 系统信息（OS/架构）。
- `/default/devices`、`/AgentBean/devices` → **HTTP 404 + `application/json` `{"ok":false,"error":"NOT_FOUND"}`**（Next app handler 未启用，`dev-server.ts:148` `webEntry==='app'` 才 `createWebAppHandler`）。
- 实测设 `AGENTBEAN_NEXT_WEB_ENTRY=app` 重启 full-preview **仍 404** → full-preview 不切 app 模式。**本地没有一个标准命令能看到完整 App Router 设备详情页。** 这是当前最大障碍。

### 1.2 完整 DeviceDetail 代码（origin/main `apps/web-next/app/[networkPath]/devices/page.tsx` 1516 行）
| 能力 | 代码位置 | 状态 |
|---|---|---|
| 设备重命名（S1） | L380-578，`data-smoke="device-rename-{open,input,save,error}"` | ✅ 完整 |
| 删除设备（S1） | 操作区 button「删除设备」 | ✅ |
| 系统信息富字段（S2a） | L585-591 `{device.systemInfo && ...}`（OS/架构/CPU/核心/内存） | ✅ 条件渲染 |
| daemon 版本 + latest / 更新提示（S2b） | 信息区 + 硬件信息区 | ✅ |
| connectCommand | L610-627（历史命令 + 「生成连接命令」CTA） | ✅ 完整 |
| selectDirectory（S3） | L123 `deviceEvents().selectDirectory(deviceId)` 调用链 | ✅ |
| 运行时 + 扫描 | 运行时区 + 「扫描」button | ✅ |

### 1.3 数据层
- preview daemon 未上报 systemInfo → 系统信息区不渲染（**数据问题，非 UI gap**）。
- preview daemon 无 connectCommand 数据（历史命令区不渲染，但「生成连接命令」CTA 常驻）。

## 2. 坐实的真实 Gap

| # | Gap | 性质 | 优先级 |
|---|---|---|---|
| G1 | 本地 preview 无法展示完整 App Router 设备页（full-preview 锁 preview 模式） | 工具链/可用性 | **高** |
| G2 | 生产是否已部署 #312+ 且用 app 模式 serve | 部署确认 | **高** |
| G3 | daemon 未上报 systemInfo（系统信息区空） | 数据链路 | 中 |
| G4 | select-directory 后端 request-response 链路在 `feat/device-select-directory` 未合并 | 分支收敛 | 中 |
| G5 | 设备对等性工作分散多分支，未收敛到 web-next | 过程债 | 低（代码已齐） |

**明确剔除**：没有「UI 大面积缺失」这一条。初判的 S1/S2a/S2b/connectCommand/selectDirectory 缺失，实为 preview demo 模式误判。

## 3. 修正后的计划（按 Slice）

### Slice 0（先做）让完整设备页可被看到/验证 —— 解 G1
- 方案 A（推荐）：让 full-preview 支持 `webEntry='app'`，使 `dev:agentbean-next` 能 serve 完整 App Router（排查 `full-preview.ts:107 startServerNextDevServer` 是否丢弃 webEntry）。
- 方案 B：独立起 `apps/web-next`（`next dev`/`next start`）+ `server-next`，连真实/preview daemon。
- 验收：浏览器打开 `/default/devices/[id]`，能看到完整 DeviceDetail（重命名编辑、连接命令 CTA、系统信息卡片）。

### Slice 1 确认生产部署 —— 解 G2
- Railway `AGENTBEAN_DEPLOY_TARGET=next` 部署是否含 #312/#313/#319；生产 serve 是否 app 模式（决定线上 `/default/devices` 能否打开）。

### Slice 2 daemon 数据上报 —— 解 G3
- daemon-next hello/heartbeat 上报 systemInfo（OS/架构/CPU/内存）→ 系统信息区渲染。

### Slice 3 收敛后端链路 —— 解 G4
- `feat/device-select-directory` 的 select-directory request-response（server-next `emitWithAck` + daemon 原生目录选择器 + contracts 常量）rebase 到 origin/main；web-next 前端调用（L123）随之激活。

### Slice 4 收尾尾巴分支 —— 解 G5
- 合并 `feat/web-next-device-detail`、`fix/device-invite-auto-complete`、`codex/fix-device-detail-route`、`codex/fix-device-dedupe-online`（各领先 origin/main 1-2 提交）。

## 4. 关键教训
- **不要在 `preview`（单 HTML demo）模式下判断功能缺失** —— 那是简化面板，完整 DeviceDetail 在 App Router 路由，preview 模式不渲染且 `/default/*` 404。
- 本地 `main` 常落后 `origin/main` 上百提交；开工前必须 `git fetch` 并基于 origin/main。
- 已纠正记忆 [[agentbean-web-target-arch]]：web-next（App Router）才是生产前端，apps/web 是 legacy。

# AgentBean → AgentBean-next 功能对等性审计

- **日期**：2026-06-25
- **审计范围**：`apps/server ↔ apps/server-next`、`apps/daemon ↔ apps/daemon-next`、`apps/web ↔ apps/web-next` 三对子系统
- **共享层**：`packages/contracts`（socket 事件常量）、`packages/domain`
- **审计目标**：找出"旧版有、新版没有或未完整实现"的功能缺口，为切换上线（cutover）后的功能补全提供依据

---

## 摘要（TL;DR）

经三对子系统逐维对比 + grep 级交叉验证，**AgentBean-next 在功能上基本是旧版的超集**。三个并行探索 agent 初报了 10+ 个"严重缺口"，逐条核实后绝大多数是**协议层重命名/重设计**或**配套架构调整**，并非真实功能丢失。

去伪存真后，**唯一实打实的用户可见功能回退是「修改密码」（`auth:change-password`），且为 server + web 双层缺失**。另有 2 项轻微缺口（`channel:leave`、主动 `agents:discover`）存在替代路径。新版反而新增了消息反应/收藏、workspace 日志流式读取、artifact 上传 fallback、设备权限模型等旧版没有的能力。

---

## 一、审计范围与方法

### 1.1 代码规模

| 子系统 | 旧版（文件 / 行数） | 新版（文件 / 行数） | 信号 |
|---|---|---|---|
| server | 21 / 7254 | 13 / 11161 | 新版更集中且行数更多，疑似超集 |
| daemon | 21 / 3659 | 20 / 3177 | 规模相当，刻意收窄为轻量执行器 |
| web | 29 / 11103 | 31 / 12091 | 新版略大，持续接入中 |

### 1.2 方法

1. 派发 3 个并行 Explore agent（server / daemon / web 各一），产出功能清单与缺口初稿。
2. 对初稿中**所有标记为「严重」的缺口声称**，用 `grep` 直接查证源码，按"确认缺失 / 部分实现 / 实现不同但等价 / 重命名 / 配套设计"五档定性。
3. 对"新版独有"的声称反向核实（确认旧版确实没有），避免方向性误判。

> **方法论提示**：此类新旧版对比最大的陷阱是把"重命名/重设计"误判成"缺失"。本仓库共享 `packages/contracts`（同一份 socket 事件常量表 `contracts/src/socket.ts`），事件对齐在契约层已保证，剩余差异多为"实现有无"问题，grep 即可定性。

---

## 二、Agent 初报「严重缺口」逐条核实（去伪存真）

以下为三个 agent 标红、但经源码核实**不成立或被重新定性**的判断。**保留这一节的目的：阻止未来重复审计时再次掉进同样的误判坑。**

| Agent 声称 | 初报严重度 | 核实证据 | 最终定性 |
|---|---|---|---|
| server-next **无 HTTP 路由**（无 healthz / upload / download）| 🔴 严重 | `/healthz`：`apps/server-next/src/dev-server.ts:156`；artifact upload/download/preview：`dev-server.ts:439,445,571-572` | ❌ **误判**。新版有完整 HTTP 层 |
| daemon-next **丢失心跳** → 断线检测失效 | 🔴 严重 | server-next 也移除了 heartbeat scanner（旧版 `apps/server/src/index.ts:16,983` 的 `startDeviceHeartbeatScanner` 在新版已删）| ✅ **配套设计**。改用 socket.io 连接状态判断在线，daemon 不发 heartbeat 是与新 server 配套 |
| gemini / kimi-cli **执行器残缺** | 🔴 严重 | `apps/daemon-next/src/executor.ts:78` 注释：「Unregistered agents (codex, gemini, kimi-cli, …) keep the generic stdin contract」| ✅ **有意设计**。仅 hermes/openclaw 走 argv-mode、codex 走 PTY，其余 generic stdin；记忆中已查证兼容 |
| 设备详情对等性缺失（device parity）| 🔴 严重 | `docs/superpowers/plans/2026-06-21-device-parity-web-next-realignment.md` 已记录：早期判断基于 preview 单 HTML demo 误判；完整 DeviceDetail 在 App Router 已实现（`apps/web-next/app/[networkPath]/devices/page.tsx:380-627`）| ❌ **误判**。已在 main 修复，设备管理 100% 对等且有增强 |
| `auth:device-login` 缺失 | 🟡 中 | 旧版 `index.ts:2671`；新版重设计为两步 `device-invite:complete`，web 层已适配 | ⚠️ **重设计**。非用户可见缺口 |
| `agents:discover` 主动发现丢失 | 🟡 中 | 旧版 `index.ts:1216-1233`（web→server→`io.of('/agent').emit('agents:discover')`）；新版改走 `device:scan` request-response 转发（`apps/server-next/src/transport/socket-handlers.ts:36-91`，`socket-server.ts:168`）触发 daemon 重扫 | ⚠️ **入口语义变化**。功能可达成 |

---

## 三、真实功能缺口（去伪存真后）

### 3.1 🟡 中等 — 唯一实打实的功能回退

#### 修改密码（`auth:change-password`）

- **旧版**：`apps/server/src/index.ts:2704`（socket handler）+ `apps/web/lib/socket.ts:318,342`（前端接口与调用）
- **新版**：server-next 与 web-next **双层完全缺失**（`grep` 全空）
- **影响**：用户无法通过界面修改密码。若未接入外部 IdP / OAuth 改密流程，这是真实的自助功能丢失。
- **处理建议**：见第六节。

### 3.2 🟢 轻微 — 有替代路径

| 缺口 | 旧版位置 | 新版状态 | 替代方案 |
|---|---|---|---|
| `channel:leave`（离开频道）| `apps/server/src/index.ts:2118` | 无独立事件 | `channel:remove-member` 移除自己 |
| `agents:discover`（即时发现）| `index.ts:1216` | 改为被动 + `device:scan` | 点"扫描设备"触发 daemon rescan |
| per-agent 集中式 workspace | `~/.agentbean/teams/{tid}/agents/{aid}/runs/` | per-run 项目本地 `{cwd}/.agentbean/runs/{rid}/` | 架构转向，非缺口 |

---

## 四、新版独有增强（旧版无）

> 注意：web 探索 agent 初报曾将部分项误标为"两端都有"。反向核实后确认以下均为**新版独有**。

| 新增能力 | 证据 |
|---|---|
| 消息表情反应 / 收藏 / 收藏列表 | `packages/contracts/src/socket.ts:93-95` + `apps/server-next/src/infra/memory/repositories.ts:890-917` + `apps/web-next/lib/socket.ts:346-355` |
| Workspace 运行日志流式读取（tail / maxBytes）| `apps/web-next/lib/socket.ts:154-175` |
| Artifact 上传 3 层 fallback（直连 → 代理 → 备用）| `apps/web-next/lib/socket.ts:54-82` + `artifact-upload.ts` |
| 数据规范化自动兼容旧字段（`normalizeAgentSnapshot`）| `apps/web-next/lib/socket.ts:18-26` |
| 设备权限模型（`canManageDeviceForUser` / `canAddCustomAgentToDevice`）| `apps/web-next/lib/device-permissions.ts:50,65` |
| `channel:join` / `channel:create` 独立事件 | `apps/web-next/lib/socket.ts:330,332` |
| Clean Architecture（usecase / repository 分层 + DB migration 系统）| `apps/server-next/src/{application,infra,domain,transport}` |

---

## 五、分领域结论

### 5.1 server-next

功能基本是旧版超集。HTTP 路由（healthz + artifact upload/download/preview）、socket 事件（web + agent 命名空间）、持久化（global + per-team sqlite + 版本化 migration）、后台任务（dispatch 超时扫描 + daemon 版本刷新）齐全。唯一回退是 `auth:change-password`。

### 5.2 daemon-next

刻意收窄为"轻量命令执行器"的设计目标已达成。六类 agent（codex / claude-code / hermes / openclaw / gemini / kimi-cli）调用契约均已正确（含近期 hermes/openclaw/codex 的 PTY/argv 修复），附件下载、产物归档（per-run 隔离 + SHA256 去重 + HTTP upload）对等甚至增强。**无"不该丢却丢了"的严重能力**——heartbeat 移除、gemini/kimi-cli generic stdin 均为配套/有意设计。

### 5.3 web-next

路由 100% 对等（27/27 页面）、UI 组件 100% 对等（14/14）、状态管理逻辑一致（仅 `useCurrentTeamPath`→`useCurrentNetworkPath` 命名差异）、设备管理对等且增强。唯一缺口是配合 server 缺失的改密码 UI。

---

## 六、建议

1. **`change-password`（P0，唯一真实缺口）**：
   - 若产品仍需用户自助改密 → 在 server-next 补 usecase + socket handler，web-next 补 UI。
   - 若已改走 OAuth / 外部 IdP → 在迁移文档中明确标注"刻意移除"，避免未来被当作回归误报。
2. **`channel:leave`（可选，P1）**：若产品有"退出频道"交互诉求，补独立事件比让用户 remove-member 自己更顺手。
3. **其余无需处理**：heartbeat、gemini/kimi-cli、device-login、agents:discover 均为配套重设计或有意收窄。

---

## 七、证据索引

| 证据 ID | 文件 | 行号 | 说明 |
|---|---|---|---|
| E001 | `apps/server/src/index.ts` | 2704 | 旧版 `auth:change-password` handler |
| E002 | `apps/web/lib/socket.ts` | 318, 342 | 旧版 `changePassword` 接口与调用 |
| E003 | `apps/server-next/src/dev-server.ts` | 156, 439, 445, 571-572 | 新版 HTTP 路由（healthz + artifact）|
| E004 | `apps/server/src/index.ts` | 16, 983 | 旧版 heartbeat scanner（新版已删）|
| E005 | `apps/daemon-next/src/executor.ts` | 78, 511 | gemini/kimi-cli generic stdin 有意设计 |
| E006 | `apps/server/src/index.ts` | 2118 | 旧版 `channel:leave`（新版无）|
| E007 | `apps/server/src/index.ts` | 1216-1233 | 旧版 `agents:discover` 主动触发 |
| E008 | `apps/server-next/src/transport/socket-handlers.ts` | 36-91 | 新版 `device:scan` request-response 转发 |
| E009 | `packages/contracts/src/socket.ts` | 93-95 | 消息 react/save 事件契约（新版独有）|
| E010 | `apps/server-next/src/infra/memory/repositories.ts` | 890-917 | 消息 reactions / savedMessages 实现（新版独有）|
| E011 | `apps/web-next/app/[networkPath]/devices/page.tsx` | 380-627 | 设备详情完整实现（parity 已修复）|
| E012 | `docs/superpowers/plans/2026-06-21-device-parity-web-next-realignment.md` | — | 设备 parity 误判纠正记录 |

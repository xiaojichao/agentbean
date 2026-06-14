# AgentBean Web 协议对等性审计（apps/web × server-next）

> 日期：2026-06-13
> 作者：迁移前评估（路径 A · 协议对等性审计）
> 目的：评估完整的 `apps/web` UI 客户端能否对接 `apps/server-next` 作为生产 Web 入口，**逐事件**定位协议层 gap，为后续「本地对接探针」与逐域收敛提供地基。
> 范围：socket.io `/web` 命名空间的事件协议 + 关联 REST API。不含 UI 视觉/交互对等（那是后续切片）。

---

## 一、结论摘要

`apps/web` 与 `apps/server-next` 的协议**命名同源（均为冒号风格）且共享 `packages/contracts/src/socket.ts` 的 `WEB_EVENTS`**，但 `apps/web` 仍保留一批**面向旧 `apps/server` 的硬编码事件名**，未对齐到当前 contracts。gap 可枚举、可逐项收敛：

| 类别 | 含义 | 数量 | 处置方向 |
|---|---|---|---|
| **A · 命名差异** | web 发旧名，contracts/server 用新名 → 直接接不上 | 3 | web 改用 `WEB_EVENTS` 常量 |
| **B · web 硬编码、contracts 无定义** | 多为 device 管理长尾 + 部分 auth/join/channel | 13 | 逐项决策：补 server 还是裁剪 UI |
| **C · contracts 有定义、server 静态引用未见** | 主要是 snapshot/status/metrics 类广播 | 7 | 本地探针核实（静态扫描有盲区） |

**整体判断**：协议层**不是「改个 env 就能连」**，但 gap 集中、边界清晰。路径 A（apps/web 对接 server-next）**可行**，工作量集中在 B 类长尾收敛与 A 类命名统一。后端业务用例（server-next）已基本达到 parity（chat/channel/task/member/device/agent/DM/saved/reaction/search/artifact 均已实现），协议层是当前唯一系统性阻塞。

---

## 二、方法论

三方比对：

- **UI 期望**：`apps/web/lib/socket.ts`（`emitWithTimeout(…, '事件名')` 的 request + `socket.on('事件名')` 的订阅）。注：少量事件散落在组件，本审计以 socket.ts 为权威基线，组件级差异留给探针。
- **共享契约**：`packages/contracts/src/socket.ts` 的 `WEB_EVENTS`（权威协议定义）。
- **server-next 实现**：`apps/server-next/src/transport/` 对 `WEB_EVENTS`/`AGENT_EVENTS` 的全部引用（bind 监听 + emit 广播）。**server-next 零硬编码字符串事件**，全部走常量。

**图例**：✅ 对齐 ｜ ⚠️ 命名差异 ｜ ❌ web 硬编码、contracts 无定义 ｜ ❓ contracts 有定义但 server 静态引用未见（待核实） ｜ — 不适用

---

## 三、对等性矩阵（按域）

### 3.1 认证 Auth

| UI 事件 | contracts (WEB_EVENTS) | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `auth:register` | `auth.register` | ✅ | ✅ | |
| `auth:login` | `auth.login` | ✅ | ✅ | |
| `auth:whoami` | `auth.whoami` | ✅ | ✅ | |
| `auth:device-login` | —（未定义） | — | ❌ | 设备登录链路；web 硬编码老事件，需补 contracts+server |
| `auth:change-password` | —（未定义） | — | ❌ | 同上 |
| `invite:create` | —（应为 `deviceInvite.create`=`device-invite:create` 或 `join.create`） | deviceInvite.create 已实现 | ❌ | web 老事件名，需对齐到 `device-invite:create` / `join:create` |

### 3.2 加入链接 Join

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `join:create` | `join.create` | ✅ | ✅ | |
| `join:list` | —（未定义） | — | ❌ | 列表/吊销未在 contracts；post-flip 标注 join 收敛中，剩 list/revoke |
| `join:revoke` | —（未定义） | — | ❌ | 同上 |
| `auth:join:validate` | `join.validate`=`join:validate` | ✅（`join:validate`） | ⚠️ | **命名差**：web 发 `auth:join:validate`，应改为 `join:validate` |

### 3.3 团队 Team

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `team:list` / `create` / `switch` / `update` / `delete` | team.* | ✅ 全部 | ✅ | 完全对齐 |
| 订阅 `teams:snapshot` | `team.snapshot`=`teams:snapshot` | ✅ | ✅ | 2026-06-14 回填核实：server-next 已在 team mutation 后广播 |

### 3.4 成员 Member

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `members:list` | `member.list` | ✅ | ✅ | |
| `member:update-human` | `member.updateHuman` | ✅ | ✅ | |
| `member:update-role` | `member.updateRole` | ✅ | ✅ | |
| `member:remove` | `member.remove` | ✅ | ✅ | |
| `member:transfer-owner` | `member.transferOwner` | ✅ | ✅ | 完全对齐（#199/#200 补齐） |

### 3.5 Agent

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `agent:create` | `agent.create` | ✅ | ✅ | |
| `agent:publish` / `unpublish` / `delete` | agent.* | ✅ | ✅ | |
| `agent:config:update` | `agent.updateConfig`=`agent:update-config` | ✅（`agent:update-config`） | ⚠️ | **命名差**：web 发 `agent:config:update`，应改为 `agent:update-config` |
| `agent:custom:list` | —（未定义） | — | ❌ | web 硬编码；自定义 agent 列表，需补 contracts+server 或改用 snapshot |
| `agent:metrics` | `agent.metrics`（已定义） | ✅ | ✅ | 2026-06-14 回填核实：request/ack 已绑定 `summarizeAgentMetrics` |
| `agents:subscribe` | `agent.subscribe` | ✅ | ✅ | |
| 订阅 `agents:snapshot` | `agent.snapshot` | ✅ | ✅ | |
| 订阅 `agent:status` | `agent.status` | ✅ | ✅ | 2026-06-14 续：agent subscriber refresh 后同步广播最新 agent 状态 |
| 订阅 `agents:discovered` | `agent.discovered` | ❓ 静态引用未见 | ❓ | 仍未见 server-next 广播路径；待按 scanner/discovery UI 需求决策 |

### 3.6 频道 Channel

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `channel:update` / `members` / `archive` / `delete` | channel.* | ✅ | ✅ | |
| `channel:add-agent` / `add-member` / `remove-agent` / `remove-member` | channel.addAgent 等 | ✅ | ✅ | 完全对齐 |
| `channel:create` / `join` / `history` / `message` / snapshot | channel.* | ✅ | ✅ | （组件级使用，server 已实现） |
| `channel:leave` | —（未定义） | — | ❌ | web 硬编码；需补 server 或 UI 改用 remove-member |
| `channel:stop-agents` | —（未定义） | — | ❌ | web 硬编码；停止频道内 agent，需补 server（可能与 dispatch:cancel 关联） |

### 3.7 消息与反应 Message / Reaction

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `message:send` / `search` | message.* | ✅ | ✅ | |
| `message:react` / `save` / `list-saved` | message.* | ✅ | ✅ | 完全对齐（#198） |
| 订阅 `message:dispatch-status` | `message.dispatchStatus` | ✅ | ✅ | |

### 3.8 任务 Task

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `task:create` / `list` / `update` / `delete` / `reorder` | task.* | ✅ | ✅ | 完全对齐（#195） |
| 订阅 `tasks:snapshot` / `task:updated` | `task.snapshot` / `task.updated` | ⚠️ | ⚠️ | `task:updated` 已广播；`tasks:snapshot` 仍未见 server-next 广播路径 |

### 3.9 设备 Device（gap 最密集）

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `device:get` | `device.get` | ✅ | ✅ | |
| `device:scan` | `device.scan` | ✅ | ✅ | |
| `devices:list` | `device.list`=`device:list`（单数） | ✅（`device:list`） | ⚠️ | **命名差**：web 发 `devices:list`（复数），应改为 `device:list` |
| `devices:subscribe` | —（未定义） | — | ❌ | web 硬编码；contracts 无 device subscribe |
| `device:agents:list` | —（未定义） | — | ❌ | 设备上的 agent 列表；需补 contracts+server |
| `device:select-directory` | —（未定义） | — | ❌ | 目录选择（daemon 交互）；需补 |
| `device:delete` | —（未定义） | — | ❌ | 需补 |
| `device:rename` | —（未定义） | — | ❌ | 需补 |
| 订阅 `devices:snapshot` | `device.snapshot` | ✅ | ✅ | |
| 订阅 `device:status` | `device.status` | ✅ | ✅ | 2026-06-14 续：device subscriber refresh 后同步广播最新 device 状态 |

### 3.10 私聊 DM

| UI 事件 | contracts | server-next | 状态 | 说明 |
|---|---|---|---|---|
| `dm:start` / `list` | dm.* | ✅ | ✅ | |
| 订阅 `dms:snapshot` | `dm.snapshot` | ✅ | ✅ | 完全对齐 |

### 3.11 关联 REST API

apps/web 还依赖若干 HTTP 路由（`apps/web/lib/socket.ts` 的 `fetch` 调用）：

| UI 调用 | server-next 现状 | 状态 |
|---|---|---|
| `GET /api/teams/{teamId}/workspace-runs/{runId}` | ✅ 已实现（dev-server.ts） | ✅ |
| `POST /api/.../artifacts/upload` | ⚠️ web 用 `/api/networks/{networkId}/artifacts/upload`，server-next 用 `/api/teams/{teamId}/artifacts/*` | ⚠️ **路径前缀差异**（`networks` vs `teams`）+ multipart/preview/download 需对齐 |
| `GET /api/networks/{id}/agents/{id}/workspace` | ❓ server-next 有 workspace-runs，旧 `agents/workspace` 路由待核实 | ❓ |

> 注：REST 路径中 `networks` ↔ `teams` 的命名迁移（PR #202 已在事件层做了 `network:* → team:*`）尚未完全覆盖 HTTP 路由前缀，是另一处系统性差异。

---

## 四、Gap 汇总

### A 类 · 命名差异（3 项，最易修，应优先）

1. `agent:config:update` → `agent:update-config`
2. `devices:list` → `device:list`
3. `auth:join:validate` → `join:validate`

**处置**：在 `apps/web/lib/socket.ts` 直接改字符串（或改用 `WEB_EVENTS` 常量）。建议同时把 socket.ts 里所有硬编码事件名迁移到从 `packages/contracts` 导入的 `WEB_EVENTS`，从根本上杜绝此类漂移。

### B 类 · web 硬编码、contracts/server 无定义（13 项）

按子域：

- **Device 长尾（6）**：`devices:subscribe`、`device:agents:list`、`device:select-directory`、`device:delete`、`device:rename`、（`device:list` 命名差见 A 类）
- **Auth（2）**：`auth:device-login`、`auth:change-password`
- **Join（2）**：`join:list`、`join:revoke`
- **Channel（2）**：`channel:leave`、`channel:stop-agents`
- **Agent（1）**：`agent:custom:list`
- **Invite（1）**：`invite:create`（→ 对齐 `device-invite:create` 或 `join:create`）

**处置**：逐项决策矩阵——

| 子域 | 建议处置 |
|---|---|
| Device 长尾 | 多为设备管理 UI 必需；优先补 contracts + server-next 用例（device 是 Next 平台核心差异化能力之一） |
| Channel leave/stop-agents | leave 可复用 `channel:remove-member`；stop-agents 与 `dispatch:cancel` 关联，补 server |
| Auth device-login/change-password | 补 server（onboarding 完整性需要） |
| Join list/revoke | 补 server（post-flip 标注 join 收敛中，这是剩余项） |
| agent:custom:list | 改用 `agents:snapshot` 过滤 custom，或补专用事件 |
| invite:create | 对齐到 `device-invite:create` / `join:create` |

### C 类 · contracts 有定义、server 静态引用未见（2026-06-14 续核实）

原始 7 项中，`teams:snapshot`、`task:updated`、`agent:status`、`device:status` 已回填广播，`agent:metrics` 已作为 request/ack 实现。当前仍需决策/补齐的剩余项：

- `tasks:snapshot`
- `agents:discovered`

**说明**：本审计的 server-next 数据来自 `transport/` 目录对 `WEB_EVENTS.*.*` 引用模式的静态扫描。这些事件多为 **server → web 的广播**（snapshot/status/discovered）或 metrics 请求，可能：① 在 transport/ 之外用别的方式 emit；② 确未实现。初始静态扫描不能直接断言缺失；上面的当前状态来自 2026-06-14 后续代码核实与 socket integration 覆盖。

---

## 五、下一步（路径 A 推进顺序）

1. **本地对接探针**（核实 C 类 + 暴露遗漏）：
   - `apps/web/.env.local` 设 `NEXT_PUBLIC_AGENT_BEAN_SERVER_URL=http://localhost:<server-next 端口>`，本地起 server-next + apps/web。
   - 跑通：登录 → 切团队 → 进频道 → 发消息 → 建/改任务 → 看成员/设备。
   - 用真实报错核实 C 类 7 项是否广播、暴露 socket.ts 之外的组件级事件差异。
   - 产出：本矩阵的 C 类从 ❓ 转为 ✅/❌ 定论。
2. **收敛 A 类**（3 项命名差，一次小 PR）。
3. **逐域收敛 B 类**（按上面子域优先级，device 长尾优先）。
4. **REST 路径对齐**：`/api/networks/*` → `/api/teams/*`（配合 #202 的事件层迁移）。
5. **生产 UI 入口切换**：apps/web 作为 server-next 生产 UI，更新 cutover/runbook。

> 并行可做：P0 生产 volume 重启持久化观察（与 UI 工作不冲突）。

---

## 六、附录：数据来源

- UI 期望：`apps/web/lib/socket.ts`（行 134–466，各 `*Events` 接口与实现）
- 共享契约：`packages/contracts/src/socket.ts`（`WEB_EVENTS` 行 1–91、`AGENT_EVENTS` 行 93–113）
- server-next 实现：`apps/server-next/src/transport/socket-handlers.ts` + `socket-server.ts`（`WEB_EVENTS`/`AGENT_EVENTS` 引用全集，66 项，零硬编码）
- 迁移上下文：`agentbean-next/docs/post-flip-gap-audit.md`、`post-flip-follow-up-status.md`、`migration-plan.md`、`verification-matrix.md`

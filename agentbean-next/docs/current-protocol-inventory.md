# 当前协议盘点

本文档盘点当前 Socket.IO 与 HTTP 协议表面。它是重写的 Phase 0 输入，不是兼容性承诺。

当前协议可作为行为地图使用，但重写版不需要保留 event names、payload shapes、ack shapes 或 legacy aliases。

## `/web` Namespace

Browser clients 连接到 `/web`。当前实现允许 anonymous sockets 用于 auth 与 invite flows，也允许 authenticated sockets 用于 app operations。

### Auth 与 Session

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `auth:register` | Web -> Server | 注册用户、创建 private team，并可选消费 invite。 | 保留行为，重新设计 payload/result。 |
| `auth:login` | Web -> Server | 登录并返回 token/current team。提供 join code 时也会消费。 | 保留行为；在更干净时把 login 与 join consumption 拆开。 |
| `auth:whoami` | Web -> Server | 返回当前用户。 | 保留。 |
| `auth:change-password` | Web -> Server | 校验当前密码后修改密码。 | 保留，但延后到 account settings slice。 |
| `auth:invite:validate` | Web/Daemon -> Server | 校验 device 或 user invite；对 device invite 还会记录等待中的 daemon socket。 | 拆分为显式 user-invite 与 device-invite flows。 |
| `auth:device-login` | Web -> Server | 面向等待中 device invite 的 browser login；向 daemon 交付 token。 | 保留行为，重设计为 device invite completion use case。 |
| `auth:join:validate` | Web -> Server | 校验 user join link，并返回目标 team display info。 | 保留行为，重命名到 join/invite domain 下。 |
| `auth:token:deliver` | Server -> Waiting socket | 向 daemon 或 invite session 交付 token。 | 保留行为，但让 delivery target 显式化。 |

### Teams

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `team:list` | Web -> Server | 列出当前用户可见的 teams。 | 保留。 |
| `team:create` | Web -> Server | 创建 team 与 default channel。 | 保留。 |
| `team:switch` | Web -> Server | 设置 socket current team，并持久化 user current team。 | 保留。 |
| `team:update` | Web -> Server | 重命名 current team。 | 保留，延后到 settings slice。 |
| `team:delete` | Web -> Server | 删除 team，并广播 fallback team state。 | 保留行为，延后到 settings/admin slice。 |
| `teams:snapshot` | Server -> Web | 广播可见 team list。 | 保留为 snapshot，payload 应类型化。 |
| `team:deleted` | Server -> Web | 当 current team 被删除时通知 sockets。 | 如果 delete 仍在范围内则保留行为。 |

### Members

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `members:list` | Web -> Server | 列出某 team 的 human members 与 visible agents。 | 保留。 |
| `member:update-human` | Web -> Server | 更新 human description。 | 保留，延后到 profile/member settings slice。 |

### Devices

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `devices:subscribe` | Web -> Server | 订阅 current team 的 device snapshot。 | 保留为 `device:list` 加 `devices:snapshot`。 |
| `devices:list` | Web -> Server | 列出 current team 的 devices。 | 保留；如有需要可规范为单数 command 命名。 |
| `device:get` | Web -> Server | 获取 device detail。 | 保留。 |
| `device:agents:list` | Web -> Server | 列出某个 device 的 agents 与 runtimes。 | 保留行为，可能拆入 `device:get` detail DTO。 |
| `device:scan` | Web -> Server -> Daemon | 请求 online daemon 重新扫描。 | 保留。 |
| `device:select-directory` | Web -> Server -> Daemon | 请求 daemon 打开 native directory picker。 | 保留行为，延后到 custom agent setup slice。 |
| `device:delete` | Web -> Server | 删除 device。 | 保留，延后。 |
| `device:rename` | Web -> Server | 重命名 device/hostname。 | 保留，延后。 |
| `devices:snapshot` | Server -> Web | 广播/列出 devices。 | 保留。 |
| `device:status` | Server -> Web | 广播 device status 或 metadata changes。 | 保留。 |

### Agents

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `agents:subscribe` | Web -> Server | 发送 current team 的 visible agent snapshot。 | 保留。 |
| `agents:discover` | Web -> Server -> Daemon | 向 daemons 广播 rescan request。 | 保留行为，targeted scans 可能通过 `device:scan` 路由。 |
| `agents:snapshot` | Server -> Web | Visible agent snapshot。 | 保留。 |
| `agents:discovered` | Server -> Web | 转发 daemon discovery payload。 | 保留为 typed discovery event。 |
| `agent:status` | Server -> Web | 广播 agent online/busy/error/offline state。 | 保留。 |
| `agent:metrics` | Web -> Server | 返回 metrics summaries。 | 保留，延后到 metrics slice。 |
| `agent:create` | Web -> Server | 创建 custom 或 hosted agent config。 | 保留，但重设计 command/config DTO。 |
| `agent:update` | Web -> Server | 更新 agent 的 visibility/team fields。 | 替换为显式 `agent:publish`、`agent:unpublish` 与 config update。不要保留宽泛 update。 |
| `agent:config:update` | Web -> Server | 更新 custom agent name/runtime config。 | 保留为 `agent:update-config` 或等价命令。 |
| `agent:custom:list` | Web -> Server | 列出 custom agents，可选按 device 过滤。 | 合并到 `agents:subscribe`、`device:get` 或 filtered `agent:list`。 |
| `agent:delete` | Web -> Server | 在允许时删除 custom 或 AgentOS agent。 | 保留行为，延后到 agent management slice。 |
| `agent:publish` | Web -> Server | Publish agent 到 team。 | 保留。 |
| `agent:unpublish` | Web -> Server | 从 team unpublish agent。 | 保留。 |

### Channels、DMs、Messages

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `channels:subscribe` | Web -> Server | 发送 channel 与 DM snapshots。 | 保留；若更干净可拆分 channel 与 DM snapshots。 |
| `channels:snapshot` | Server -> Web | Channel list snapshot。 | 保留。 |
| `channel:create` | Web -> Server | 创建包含 agents 与 users 的 public/private channel。 | 保留。 |
| `channel:join` | Web -> Server | 加入 room 并返回 message history。 | 保留。 |
| `channel:history` | Server -> Web | Channel history result。 | 优先使用 `channel:join` 的 ack result；event 可选。 |
| `channel:message` | Server -> Web | 广播已持久化 message。 | 保留。 |
| `channel:members` | Web -> Server | 获取 channel 的 human 与 agent members。 | 保留。 |
| `channel:add-member` | Web -> Server | 添加 human member。 | 保留。 |
| `channel:remove-member` | Web -> Server | 移除 human member。 | 保留。 |
| `channel:add-agent` | Web -> Server | 添加 agent member。 | 保留。 |
| `channel:remove-agent` | Web -> Server | 移除 agent member。 | 保留。 |
| `channel:update` | Web -> Server | 重命名/更新 description/visibility。 | 保留，延后到 channel settings slice。 |
| `channel:leave` | Web -> Server | 标记用户离开 channel。 | 如果 leave UX 保留，则保留行为。 |
| `channel:archive` | Web -> Server | Archive channel。 | 延后；仅当产品需要 archive 时保留。 |
| `channel:delete` | Web -> Server | Delete channel。 | 延后；仅当产品需要 hard delete 时保留。 |
| `channel:stop-agents` | Web -> Server | 取消与 channel 关联的 running agents。 | 保留行为，围绕 dispatch cancellation 重设计。 |
| `dm:start` | Web -> Server | 创建/获取与 agent 的 DM channel。 | 保留。 |
| `dm:list` | Web -> Server | 列出 DMs。 | 保留。 |
| `dms:snapshot` | Server -> Web | DM list snapshot。 | 保留。 |
| `message:send` | Web -> Server | 持久化 human message，route 并 dispatch 给 agents。 | 保留为第一切片行为。 |
| `message:search` | Web -> Server | 在 current team 中搜索 messages。 | 保留，延后到 search slice。 |

### Tasks

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `task:create` | Web -> Server | 创建 team/channel task。 | 保留；除非需要，否则延后到第一条 chat/dispatch slice 之后。 |
| `task:list` | Web -> Server | 列出 tasks，可选按 channel 过滤。 | 保留。 |
| `task:update` | Web -> Server | 更新 fields/status/assignment/sort。 | 保留。 |
| `task:delete` | Web -> Server | 删除 task。 | 保留。 |
| `task:reorder` | Web -> Server | 更新 task sort order。 | 除非专用 command 更清晰，否则合并进 `task:update`。 |
| `task:updated` | Server -> Web | 广播 task update。 | 保留。 |

### Invites 与 Join Links

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `invite:create` | Web -> Server | 创建 user/device invite。 | 保留行为，拆成显式 user invite 与 device invite commands。 |
| `join:create` | Web -> Server | 为 current team 创建 user join link。 | 保留，重命名到 invite/join domain 下。 |
| `join:list` | Web -> Server | 列出 active join links。 | 保留，延后。 |
| `join:revoke` | Web -> Server | 撤销 join link。 | 保留，延后。 |

### Admin

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `admin:list-users` | Web -> Server | Admin user inventory。 | 从第一版产品中删除。只有在明确 admin requirements 后才重新引入。 |
| `admin:delete-user` | Web -> Server | 删除 user。 | 删除/延后。 |
| `admin:list-teams` | Web -> Server | Admin team inventory。 | 删除/延后。 |
| `admin:delete-team` | Web -> Server | 以 admin 身份删除 team。 | 删除/延后；正常 owner delete 可保留。 |
| `admin:list-devices` | Web -> Server | Admin device inventory。 | 删除/延后。 |
| `admin:transfer-device-owner` | Web -> Server | 转移 device ownership。 | 删除/延后；更可能通过 device re-invite 支持。 |
| `admin:list-agents` | Web -> Server | Admin agent inventory。 | 删除/延后。 |
| `admin:delete-agent` | Web -> Server | 以 admin 身份删除任意 agent。 | 删除/延后。 |

## `/agent` Namespace

Daemon clients 连接到 `/agent`。

### Daemon -> Server

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `register` | Daemon -> Server | 注册一个 agent。 | 替换为 device hello 加 typed batch registration，除非仍需要 single-agent registration。 |
| `heartbeat` | Daemon -> Server | 刷新 agent/device heartbeat 与 status。 | 保留行为，定义显式 heartbeat DTO。 |
| `reply` | Daemon -> Server | 返回某 request 的 agent text/artifact result。 | 替换为 `dispatch:result`。 |
| `error_event` | Daemon -> Server | 报告 agent execution 或 request error。 | 替换为 `dispatch:error` 与 device/agent error events。 |
| `agents:discovered` | Daemon -> Server | 发送 discovered agents，并转发给 web。 | 替换为 typed discovery/report events。 |
| `device:register-agents` | Daemon -> Server | 批量注册 scanned agents，并把 missing agents 标为 offline。 | 保留行为为 `agent:register-batch`。 |
| `device:register-runtimes` | Daemon -> Server | 上报 installed runtimes。 | 保留为 `device:runtimes`。 |

### Server -> Daemon

| 事件 | 方向 | 当前目的 | 重写处置 |
|---|---|---|---|
| `agents:discover` | Server -> Daemon | 请求 rescan。 | 保留为 `device:scan-requested`。 |
| `device:select-directory` | Server -> Daemon | 请求 native directory picker。 | 保留，延后到 custom agent setup。 |
| `dispatch` | Server -> Daemon | 执行 agent request。 | 保留行为为 `dispatch:request`。 |
| `dispatch:cancel` | Server -> Daemon | 取消 pending/running request。 | 保留。 |

## HTTP Routes

| Route | 当前目的 | 重写处置 |
|---|---|---|
| `GET /healthz` | Health check。 | 保留。 |
| `/api/teams/:teamId/artifacts/*` 下的 artifact upload/download routes | 上传、预览与下载 artifacts。 | 保留行为；定义 auth、team scoping 与 metadata contract。 |
| `apps/web/app/api/teams/[teamId]/artifacts/upload/route.ts` 中的 Web proxy artifact upload route | Frontend fallback/proxy upload。 | 重新评估。除非 deployment 需要 proxy，否则优先使用 direct typed server route。 |

## 当前协议问题

- Event naming 不一致：单数和复数形式都存在（`device:*` 与 `devices:*`）。
- 一些 events 做得太多，尤其是 `message:send`、`agent:create` 与 invite/auth flows。
- 当前 ack shapes 不统一。
- 一些 server-to-client responses 使用 events，而 request acks 会更清晰，例如 `channel:history`。
- Admin events 存在，但没有完整的产品表面规格。
- 当前 web client 几乎把所有 protocol calls 都集中在 `apps/web/lib/socket.ts`。
- Daemon protocol 混合了 agent registration、device registration、runtime report、dispatch 与 discovery concerns。

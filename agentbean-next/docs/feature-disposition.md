# 功能处置矩阵

本矩阵将当前功能表面映射到重写计划。

状态值：

- `First Slice`：第一条端到端重写切片必需。
- `Keep`：产品行为应保留，但不一定进入第一切片。
- `Defer`：有用行为，核心流程稳定后再实现。
- `Merge/Rename`：保留行为，但替换当前 event/API 形状。
- `Drop`：除非出现新的产品需求，否则不带入重写版。

## Auth 与 Accounts

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| 注册用户并创建 private team | First Slice | `auth:register` use case 与类型化 contract。 |
| 登录并恢复 current team | First Slice | `auth:login` use case。 |
| `auth:whoami` | First Slice | 保留。 |
| `auth:change-password` | Defer | 保留在 account settings 中。第一切片不需要。 |
| User invite 注册 | Keep | 保留为 user invite flow。 |
| Device invite login/token delivery | Keep | 保留为 device onboarding flow，在第一条 daemon 切片之后实现。 |

## Teams 与 Members

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| Team list/create/switch | First Slice | 保留。 |
| Team rename/update | Defer | 保留给 settings。 |
| Team delete | Defer | 如果产品 UX 需要，仅保留 owner delete。 |
| Admin team delete | Drop | 明确指定前不提供 admin surface。 |
| Team members list | Keep | 保留。 |
| Human profile/description update | Defer | 保留为 member/profile settings。 |
| Public team auto-join | Reevaluate | 实现前先澄清产品规则。 |

## Devices

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| Daemon/device registration | First Slice | 替换为 `device:hello`。 |
| Device runtime report | First Slice | 替换为 `device:runtimes`。 |
| Device list/status snapshots | First Slice | 保留类型化 snapshots。 |
| Device detail | Keep | 保留。 |
| Device scan request | Keep | 保留为 `device:scan-requested`。 |
| Native directory picker | Defer | 保留给 custom agent creation。 |
| Device rename | Defer | 保留。 |
| Device delete | Defer | 如果 device management UX 需要则保留。 |
| Device ownership transfer | Drop | 除非出现清晰的 admin 需求，否则用 re-invite/reconnect 替代。 |

## Agents

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| Agent visible snapshot/status | First Slice | 保留。 |
| Daemon 上报的 agent discovery | First Slice | 用类型化 runtime/agent reports 替换旧 discovery payloads。 |
| `agent:create` custom agent | Keep | 保留，在 device/runtime 切片之后实现。 |
| `agent:update` broad update | Merge/Rename | 删除。拆分为 publish/unpublish 与 config update。 |
| `agent:config:update` | Keep | 已收敛为 `agent:update-config`；只允许 custom agent，ack/snapshot 只暴露 `envKeys`。 |
| `agent:delete` | Keep | 已保留给 custom agents；删除采用 server-side tombstone，隐藏 visible list 并保留 message/dispatch 历史。 |
| `agent:custom:list` | Merge/Rename | 合并进 filtered agent list 或 device detail。 |
| `agent:publish` / `agent:unpublish` | Keep | 已定义 source/target team 权限与 visible projection 规则。 |
| Agent metrics | Defer | 核心协作流程之后保留。 |
| Legacy `standalone-cli` | Drop | 不保留。 |

## Channels 与 Membership

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| Channel list/snapshot | First Slice | 保留。 |
| Channel create | Second Slice | 支持 public/private channel；private channel 自动包含 creator。 |
| Channel join/history | First Slice | 保留，history 优先通过 ack result 返回。 |
| `channel:add-member` / `channel:remove-member` | Third Slice | Creator-only；真实更新 private channel 可见性。 |
| `channel:add-agent` / `channel:remove-agent` | Third Slice | Creator-only；agent 必须对 team 可见。 |
| `channel:members` | Seventh Slice | 返回 human/agent member id 列表与详情 DTO；详情由 server projection 负责。 |
| Channel update/rename/visibility | Second Slice | 非默认频道 creator-only；默认 `all` 只允许 creator 更新 `title`。 |
| Channel leave | Defer | 仅当 left/hidden channel UX 仍保留时实现。 |
| Channel archive | Reevaluate | 延后或删除；需要产品决策。 |
| Channel delete | Reevaluate | 延后；决定 hard-delete 还是 archive。 |
| 停止 channel 中的 agents | Keep | 保留为 dispatch cancellation，而不是 channel-specific transport logic。 |

## DMs 与 Threads

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| `dm:start` | Keep | Next server 已实现为 start/get DM with agent；重复调用复用同一 direct channel。 |
| `dm:list` / `dm:snapshot` | Keep | Next server 已实现 DM list 与单 DM snapshot/history。 |
| DM mention filtering | Keep | Direct channel 固定路由到 DM target agent；普通 channel mention 支持多词 agent name。 |
| Thread message context | Keep | 使用 `messages.thread_id`；dispatch history 只包含同 thread 的 previous messages，不重复当前 prompt。 |
| Formal thread data model | Keep | 第一版选择 root-message convention，不引入独立 `threads` table。 |

## Messages、Search、Dispatch

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| `message:send` | First Slice | 保留核心行为：持久化 human message、route、dispatch、持久化 reply。 |
| `channel:message` broadcast | First Slice | 保留。 |
| `message:search` | First Slice | 已保留为 server-side simple DB search，第一版只覆盖当前用户可见普通 channels。 |
| Agent dispatch `dispatch` | First Slice | 重命名为 `dispatch:request`。 |
| Agent reply `reply` | First Slice | 重命名为 `dispatch:result`。 |
| Agent error `error_event` | First Slice | 重命名为 `dispatch:error`。 |
| `dispatch:cancel` | First Slice | 已实现 web command、server 状态更新、daemon cancel signal 与 dispatch status 广播。 |
| Dispatch persistence | First Slice | 已加入一等 dispatch table/model，并接入 result/error/cancel/timeout 状态。 |

## Artifacts 与 Workspace

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| Artifact upload/download | Keep | 在 text dispatch slice 之后、rich agent workspace 之前保留。 |
| Artifact preview | Defer | 保留。 |
| Artifact-message binding | Keep | 保留。 |
| Workspace runs | Keep | 加入显式 model；当前行为建模不足。 |
| Web upload proxy route | Reevaluate | 仅当 deployment constraints 需要时保留。 |

## Tasks

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| `task:create` | Defer | 核心 chat/dispatch 之后保留。 |
| `task:list` | Defer | 保留。 |
| `task:update` | Defer | 保留。 |
| `task:delete` | Defer | 保留。 |
| `task:reorder` | Merge/Rename | 除非 UI 明显受益于显式 command，否则合并进 `task:update`。 |
| `task:updated` | Defer | 保留。 |
| Task-channel/message link | Keep | 作为产品行为保留。 |

## Invites 与 Join Links

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| `invite:create` with `purpose: device` | Keep | 替换为显式 `device-invite:create`。 |
| `invite:create` with `purpose: user` | Merge/Rename | 优先使用 user join link commands。 |
| `join:create` | First Slice | Next 已实现为 user join link creation，不覆盖 device invite。 |
| `join:validate` | First Slice | Next 已实现为 user join link validation，替换旧 `auth:join:validate`。 |
| `join:list` | Defer | 保留。 |
| `join:revoke` | Defer | 保留。 |
| `auth:join:validate` | Merge/Rename | 由 `join:validate` 承接。 |

## Admin 表面

| 当前表面 | 状态 | 目标方向 |
|---|---|---|
| `admin:list-users` | Drop | 不属于第一版产品。 |
| `admin:delete-user` | Drop | 只有在有明确 admin spec 与 audit model 后才重新引入。 |
| `admin:list-teams` | Drop | 不属于第一版产品。 |
| `admin:delete-team` | Drop | Owner team delete 可单独保留。 |
| `admin:list-devices` | Drop | 不属于第一版产品。 |
| `admin:transfer-device-owner` | Drop | 除非 admin spec 要求 transfer，否则使用 re-invite/reconnect。 |
| `admin:list-agents` | Drop | 不属于第一版产品。 |
| `admin:delete-agent` | Drop | 不属于第一版产品。 |

## 最小第一切片

在构建其余内容前，只需要这些行为：

1. Register/login。
2. Current team selection。
3. Device hello。
4. Runtime 与 agent report。
5. Agent/device snapshots。
6. Channel list/create/join。
7. Message send。
8. Dispatch request/result/error。
9. 持久化 human 与 agent messages。

其余功能都应在第一切片稳定后实现。

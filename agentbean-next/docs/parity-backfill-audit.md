# AgentBean Next parity backfill audit

本文把 AgentBean Next final flip 后的工作从“迁移清单”切到“证据清单”。已经迁入 `apps/web-next` / `apps/server-next` 的入口，只有同时具备页面语义、server query、subscription/broadcast、兼容路径、回归测试与 gate 证据时，才标为 Green。

## 核对时间

- 日期：2026-06-24
- 基线：`origin/main` = `3af3107`（#341 之后的 main，含 daemon adapter 后续修复）
- GitHub 状态：以当前 PR/Actions 为准；本表只记录 parity 证据状态。
- 最新 main CI/CD：#341 合并后的 main run `28016639898` 已成功，包含 Validate web/server/daemon/AgentBean Next、Deploy production、Publish agent to npm 与 AgentBean Next production smoke；后续 main 提交需继续按 Actions truth 核对。

## 状态定义

| 状态 | 判定 |
|---|---|
| Green | 旧版关键行为已有入口级回归测试或 browser smoke，并且关键合同进入 verification/readiness gate。 |
| Yellow | 入口已迁入且主路径可用，但仍有旧版长尾行为、页面级 smoke、或 gate 证据不足。 |
| Red | 入口缺少旧版核心行为，或只能证明模块/API 存在，不能证明产品入口可用。 |

## 入口审计

| 入口 | 状态 | 已有证据 | 仍需补齐 |
|---|---|---|---|
| `members` | Green | `members:list` 已覆盖 human members、当前用户补回、scanned AgentOS agent、custom agent、canonical host device 与 stale/canonical device 去重；App Router browser smoke 覆盖 join、role update 与刷新恢复；readiness gate 保护 `members-list-agent-parity-regression` 与 product-surface parity contract。 | 后续只按新增需求补：human profile/description update、更完整 remove/transfer 浏览器路径。 |
| `devices` | Green | `device:list`、`device:get`、`device:agents:list`、scan routing、rename、delete redirect、owner/admin 权限、canonical device identity、runtime/agent 投影、connect command、old daemon `device:register-agents` 与 daemon-next `agent:register-batch` 兼容均已有 server/web 回归；App Router `webui-devices-business-flow` 覆盖 list -> detail、runtime 投影、自定义 Agent 投影、targeted scan 后 AgentOS 托管 Agent 投影、rename/refresh restore 与 delete redirect/list disappearance；readiness gate 保护 `devices-parity-browser-smoke`。 | 后续只按新增需求补：更完整 owner transfer 浏览器路径、真实 reconnect/cached scan UX、设备 audit trail。 |
| `agents` | Green | custom agent create、list/detail、config update、publish/unpublish、metrics dispatch 与 delete/list disappearance 已进入 App Router `webui-agents-business-flow`；server/usecase 侧已有 config envKeys、delete tombstone、metrics request/ack 与 daemon-next scanned-agent dispatch 证据；readiness gate 保护 `agents-parity-browser-smoke` 与稳定 selector。 | 后续只按新增需求补：更完整 admin/audit 产品面、advanced metrics drilldown、批量 publication 管理。 |
| `chat` | Green | message send、session restore、dispatch status/cancel、thread reply、artifact upload/viewer、workspace run source message 与 App Router chat send/refresh restore 均已有测试或 browser smoke。 | 更完整 saved/reactions/search UI 仍按各自入口继续补，不阻塞 chat 主入口。 |
| `channels` / `channel members` | Green | channel create/archive/list disappearance、channel creator controls、private channel visibility、`channel:members` usecase 与 subscription broadcast 已有测试；App Router `webui-channel-members-business-flow` 覆盖 private channel 创建、频道成员弹窗、creator 添加 human member、添加 agent member、移除 human member、`channel:members` projection、private visibility 回收与 mention scope；readiness gate 保护该 browser smoke 与稳定 selectors。 | 后续只按新增需求补：更完整频道成员 profile/edit、批量成员管理、频道级 audit trail。 |
| `tasks` | Yellow | task create/status update/refresh restore 已进入 browser smoke；delete/reorder 协议与 usecase 第一版已收敛。 | typed assignee、task 自动生成、更完整 task page、delete/reorder 的 App Router browser path 仍需后续切片。 |
| `runs` | Yellow | workspace run list/detail/refresh restore、source message jump、full log artifact、artifact tree 与 inline log search 已进入 App Router smoke。 | 复杂 team-wide workspace explorer、分段日志存储/检索、更完整运行专页布局仍未冻结。 |
| `settings` / `networks` | Yellow | team rename、join link create/revoke、team create/switch/delete/fallback restore 已进入 App Router smoke；SQLite delete cascade 已有回归。 | account settings（change password/profile）、invite management 更完整 UX、rollback/old target drill 仍按后续产品或运维切片补。 |
| `dashboard` / `admin` | Yellow | `admin:list-teams/users/devices/agents` 与 `admin:transfer-device-owner` 已回填 socket/usecase 回归和 readiness gate；dashboard 页面已迁入。 | 更完整 admin/metrics/audit 产品面未冻结，仍缺浏览器级 admin 操作证据与 audit requirements。 |
| `daemon onboarding` | Yellow | npm canonical daemon 已切到 daemon-next；device invite、CLI token persistence、多 profile/YAML、scan summary、scanner parity、CLI wiring tests 与 production smoke 已有证据。 | auth token refresh/renewal、profile delete/rename CLI、formal reconnect guarantees 仍未冻结。 |

## 下一条 backfill slice

优先做 `tasks`。原因：

1. `tasks` 入口仍是 Yellow，目前 browser smoke 只覆盖 create、status update 与 refresh restore。
2. delete/reorder 协议与 usecase 已有第一版，但还没有 App Router browser-level 闭环证据。
3. agents 入口已经用 browser smoke 证明 list/detail/config/publish/metrics/delete，下一条应继续把任务页的旧版长尾行为从“代码存在”推进到“入口级证据存在”。

最小 slice：

1. 盘点现有 tasks 入口证据，把 create/status/delete/reorder/assignee/refresh restore 按入口级 checklist 汇总。
2. 先补 delete/reorder 的最小 regression 或 browser smoke；如果现有测试已覆盖，就把证据写进本 audit 与 `verification-matrix.md` 并加 readiness/static gate。
3. 避免把 `task:create` 或 usecase 单测误当成完整任务页 parity。

## 维护规则

- 新增或修复已迁移入口时，必须更新本表的状态或“仍需补齐”列。
- 如果某个 Yellow/Red 被修复，先补 regression test，再补 readiness/static gate，最后改本文档。
- 不允许用模块级测试替代入口级证据。例如 `agents:subscribe` 通过，不能自动代表 `members`、`devices` 或 `channel members` Green。

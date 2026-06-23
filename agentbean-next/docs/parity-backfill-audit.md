# AgentBean Next parity backfill audit

本文把 AgentBean Next final flip 后的工作从“迁移清单”切到“证据清单”。已经迁入 `apps/web-next` / `apps/server-next` 的入口，只有同时具备页面语义、server query、subscription/broadcast、兼容路径、回归测试与 gate 证据时，才标为 Green。

## 核对时间

- 日期：2026-06-23
- 基线：`origin/main` = `9dd7ba5`（PR #338 已合并）
- GitHub 状态：open PR 为空；open issue 为空。
- 最新 main CI/CD：run `28012932531` 成功，包含 Validate web/server/daemon/AgentBean Next、Deploy production、Publish agent to npm 与 AgentBean Next production smoke。

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
| `devices` | Yellow | `device:list`、`device:get`、scan routing、rename、delete redirect、owner/admin 权限、canonical device identity、runtime/agent 投影与 connect command 已有 server/web 回归；App Router browser smoke 覆盖 device rename 与刷新恢复。 | 还缺一张设备入口级闭环证据：list/detail/scan/delete/owner transfer/reconnect/cached scan/old daemon 与 daemon-next 兼容路径统一列入 audit 或 browser smoke。 |
| `agents` | Yellow | custom agent create、publish/unpublish、config envKeys、delete tombstone、metrics request/ack 与 browser smoke metrics 路径已存在；daemon-next 扫描与 runnable scanned-agent dispatch 已补。 | 还缺完整 agent 管理面 parity：delete/config 的 App Router browser-level 覆盖、跨团队 publication 投影、metrics 口径、admin/audit 需求边界。 |
| `chat` | Green | message send、session restore、dispatch status/cancel、thread reply、artifact upload/viewer、workspace run source message 与 App Router chat send/refresh restore 均已有测试或 browser smoke。 | 更完整 saved/reactions/search UI 仍按各自入口继续补，不阻塞 chat 主入口。 |
| `channels` / `channel members` | Yellow | channel create/archive/list disappearance、channel creator controls、private channel visibility、`channel:members` usecase 与 subscription broadcast 已有测试；App Router smoke 覆盖 create/archive。 | 频道成员弹窗仍需单独入口级 browser smoke：human/agent member add/remove、private channel visibility 回收、mention scope 与 `channel:members` projection 不能只靠 usecase 证明。 |
| `tasks` | Yellow | task create/status update/refresh restore 已进入 browser smoke；delete/reorder 协议与 usecase 第一版已收敛。 | typed assignee、task 自动生成、更完整 task page、delete/reorder 的 App Router browser path 仍需后续切片。 |
| `runs` | Yellow | workspace run list/detail/refresh restore、source message jump、full log artifact、artifact tree 与 inline log search 已进入 App Router smoke。 | 复杂 team-wide workspace explorer、分段日志存储/检索、更完整运行专页布局仍未冻结。 |
| `settings` / `networks` | Yellow | team rename、join link create/revoke、team create/switch/delete/fallback restore 已进入 App Router smoke；SQLite delete cascade 已有回归。 | account settings（change password/profile）、invite management 更完整 UX、rollback/old target drill 仍按后续产品或运维切片补。 |
| `dashboard` / `admin` | Yellow | `admin:list-teams/users/devices/agents` 与 `admin:transfer-device-owner` 已回填 socket/usecase 回归和 readiness gate；dashboard 页面已迁入。 | 更完整 admin/metrics/audit 产品面未冻结，仍缺浏览器级 admin 操作证据与 audit requirements。 |
| `daemon onboarding` | Yellow | npm canonical daemon 已切到 daemon-next；device invite、CLI token persistence、多 profile/YAML、scan summary、scanner parity、CLI wiring tests 与 production smoke 已有证据。 | auth token refresh/renewal、profile delete/rename CLI、formal reconnect guarantees 仍未冻结。 |

## 下一条 backfill slice

优先做 `channels / channel members`。原因：

1. 它是独立产品入口，不能被 `members:list`、`agents:subscribe` 或 channel list smoke 替代。
2. 旧版已有频道成员弹窗和 creator-only controls；当前 server/usecase 证据较强，但 App Router browser 证据还薄。
3. 它和 mention scope、private channel visibility、agent membership 都共享边界，风险高但可切成小 PR。

最小 slice：

1. 补一个频道成员弹窗或页面级 regression/browser smoke，覆盖 creator 添加 human member、添加 agent member、移除 member 后 private channel visibility 回收。
2. 如发现 server query 或 subscription 缺口，先补最小 usecase/socket regression，再修一条路径。
3. 更新本 audit 与 `verification-matrix.md`，把该入口的对应行从 Yellow 推进到 Green 或记录剩余边界。

## 维护规则

- 新增或修复已迁移入口时，必须更新本表的状态或“仍需补齐”列。
- 如果某个 Yellow/Red 被修复，先补 regression test，再补 readiness/static gate，最后改本文档。
- 不允许用模块级测试替代入口级证据。例如 `agents:subscribe` 通过，不能自动代表 `members`、`devices` 或 `channel members` Green。

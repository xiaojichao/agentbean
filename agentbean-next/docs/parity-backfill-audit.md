# AgentBean Next parity backfill audit

本文把 AgentBean Next final flip 后的工作从“迁移清单”切到“证据清单”。已经迁入 `apps/web-next` / `apps/server-next` 的入口，只有同时具备页面语义、server query、subscription/broadcast、兼容路径、回归测试与 gate 证据时，才标为 Green。

## 核对时间

- 日期：2026-06-25
- 基线：`origin/main` = `51d6c6e`（PR #356 已合并）
- GitHub 状态：以当前 PR/Actions 为准；本表只记录 parity 证据状态。
- 最新 main CI/CD：PR #356 合并后的 main run `28144631955` 已成功，包含 Validate web/server/daemon/AgentBean Next、Deploy production、Publish agent to npm 与 AgentBean Next production smoke；后续 main 提交需继续按 Actions truth 核对。

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
| `tasks` | Green | task create、status update、reorder、delete/list disappearance 与 refresh restore 已进入 App Router `webui-task-business-flow`；server/usecase 侧已有 delete/reorder 的可见性、已删除任务、无效 sortOrder 与 wrong-team 边界；readiness gate 保护 `tasks-parity-browser-smoke` 与稳定 selector。 | 后续只按新增需求补：typed assignee 深化、task 自动生成、更丰富 task 产品流。 |
| `runs` / `运行记录` | Green | 用户侧 `/runs` 执行记录入口已覆盖 team 级最近执行列表、状态/Agent/设备筛选、状态分组、分页入口、详情页刷新恢复、执行命令、退出码、日志摘要、完整日志 artifact、文件树、inline 日志搜索、返回执行记录列表与返回触发消息；server 侧 `workspace-runs` list/detail/log HTTP route 与 workspace artifact 授权已有回归；readiness gate 保护 `runs-parity-browser-smoke`。 | 后续只按新增需求补：更强日志脱敏、跨运行全文检索、audit trail、长时间运行进度流。 |
| `settings` / `teams` | Green | account tab 当前用户身份与 logout 入口、browser preferences 持久化/刷新恢复/reset、team rename、join link create/revoke/refresh restore、team create/switch/delete/fallback restore 已进入 App Router smoke；readiness gate 保护 `settings-parity-browser-smoke`、`teams-parity-browser-smoke` 与稳定 selector；SQLite delete cascade 已有回归。 | 后续只按新增需求补：change password/profile 编辑、更完整 invite management、rollback/old target drill。 |
| `dashboard` / `admin` | Green | `admin:list-teams/users/devices/agents` 与 `admin:transfer-device-owner` 已回填 socket/usecase 回归；App Router `webui-admin-dashboard-business-flow` 覆盖 global admin 入口、teams/users/devices/agents tab、设备详情 runtime/public agent 投影、owner transfer 与 Agent owner projection；readiness gate 保护 `admin-dashboard-parity-regression` 与 `admin-dashboard-parity-browser-smoke`。 | 后续只按新增需求补：更完整 admin audit trail、批量删除/恢复、metrics drilldown。 |
| `daemon onboarding` | Green | npm canonical daemon 已切到 daemon-next；device invite wait/complete、CLI token persistence、多 profile/YAML、profile list/clear/rename CLI、token refresh persistence、scan summary、scanner parity、reconnect re-announce、reconnect latest-scan snapshot、targeted scan、custom agent env device-token boundary、canonical npm install smoke 与 production smoke 均已有证据；`daemon-onboarding-lifecycle-green` readiness gate 把 invite、saved profile、token refresh、reconnect、latest scan snapshot、targeted scan、npm install smoke 与本文 Green 状态绑在一起。 | 后续只按新增需求补：更完整 onboarding UX 可视化演练、设备接入 audit trail、异常网络/长时间运行 drill。 |

## 下一条 backfill slice

所有核心产品入口已经进入 Green。后续不再按“迁移补账”继续扫入口，而是按新增产品需求或真实线上症状开小切片。当前基线判断如下：

1. `runs` / `运行记录` 已作为正式产品入口补账：用户能从侧栏进入执行记录，筛选最近执行，打开详情，查看命令、日志、完整日志文件、输出文件树，并回到触发消息。
2. `dashboard` / `admin` 已补浏览器级 admin tab、device detail、owner transfer 与 agent owner projection 证据，状态为 Green。
3. `daemon onboarding` 已补设备接入生命周期 gate，覆盖邀请连接、保存 profile、token 续签、断线重连、最新扫描快照、targeted scan 与 canonical npm install smoke，状态为 Green。

最小 slice：

1. 如果后续出现真实用户症状，先按具体产品入口复现，不再从旧迁移清单泛扫。
2. 如果是新增产品能力，例如 admin audit trail、设备接入异常演练、metrics drilldown、搜索高亮或 task typed assignee，按新增需求开独立小切片。
3. 如果修改现有 Green 入口，必须同步补入口级 regression/browser smoke、readiness gate 与本文状态，避免 Green 证据退化。

## 维护规则

- 新增或修复已迁移入口时，必须更新本表的状态或“仍需补齐”列。
- 如果某个 Yellow/Red 被修复，先补 regression test，再补 readiness/static gate，最后改本文档。
- 不允许用模块级测试替代入口级证据。例如 `agents:subscribe` 通过，不能自动代表 `members`、`devices` 或 `channel members` Green。

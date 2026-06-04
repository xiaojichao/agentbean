# 当前数据模型盘点

本文档盘点当前 persistence model。它是重写的 Phase 0 输入，不是 schema compatibility requirement。

旧 SQLite files 不需要迁移，因为产品尚未发布。使用这份盘点来保留 domain concepts，而不是 table shapes。

## 存储范围s

当前实现有两个活跃 storage scopes：

- 来自 `apps/server/src/db.ts` 的 Global DB
- 来自 `apps/server/src/storage.ts` 的 Per-network DB

`apps/server/src/db.ts` 中还有一个较旧的 `SCHEMA` block，看起来像包含 agents、channels、messages、artifacts 与 tasks 的单数据库。除非当前 code paths 需要它，否则把它视为 legacy implementation history。

## 全局 DB

### `users`

目的：

- Human account identity 与 login。
- Current network preference。
- Admin/member role metadata。

当前字段包括：

- `id`
- `username`
- `email`
- `description`
- `password_hash`
- `role`
- `current_network_id`
- `created_at`
- `updated_at`

重写说明：

- 保留 user/account concept。
- 保留 password hash 与 current network behavior。
- 没有产品决策前，不保留当前 token payload 或精确 role model。

### `networks`

目的：

- Channels、devices、agents、tasks 与 artifacts 的 team/network container。

当前字段包括：

- `id`
- `owner_id`
- `name`
- `path`
- `description`
- `visibility`
- `type`
- `created_at`

重写说明：

- 保留 network/team 作为 core aggregate。
- 决定产品语言使用 `team`、`network`，还是两者都用。当前 docs 两者都在使用。
- 如果 Web routing 仍使用 `[networkPath]`，保留 URL/path slug behavior。

### `network_members`

目的：

- 用户在 networks 中的 membership。

当前字段包括：

- `network_id`
- `user_id`
- `role`
- `joined_at`

重写说明：

- 保留。
- 显式定义 roles，而不是依赖 loose strings。

### `devices`

目的：

- 已注册 daemon/device identity 与 last known metadata。

当前字段包括：

- `id`
- `user_id`
- `network_id`
- `machine_id`
- `profile_id`
- `hostname`
- `last_seen_at`
- `connect_command`
- `system_info`
- `runtimes`

重写说明：

- 保留 device identity、owner、network、machine/profile identity 与 runtime reporting。
- 只有 query needs 证明有必要时，才考虑把 runtimes 规范化成独立表。第一版重写中，只要 contract 类型化，JSON 可以接受。
- `connect_command` 可以改为派生，而不是存储。

### `agents`

目的：

- 独立于 live socket state 的 persisted agent identity/configuration。

当前字段包括：

- `id`
- `name`
- `role`
- `adapter_kind`
- `device_id`
- `network_id`
- `visibility`
- `category`
- `source`
- `first_seen_at`
- `last_seen_at`
- `last_error`
- `command`
- `args`
- `cwd`
- `env`
- `owner_id`
- `description`

重写说明：

- 保留 persisted agent identity 与 configuration。
- 尽可能用显式 network publishing 与 channel membership semantics 替换宽泛的 `visibility`。
- 保留 `category` 与 `source`，但实现前先敲定词汇。
- 将 `command`、`args`、`cwd` 与 `env` 视为 custom-agent runtime config。
- 如果引入更干净的 identity rules，不保留 old agent IDs。

### `agent_network_publish`

目的：

- 将 agents many-to-many publish 到额外 networks。

当前字段包括：

- `agent_id`
- `network_id`
- `published_by`
- `published_at`

重写说明：

- 保留产品行为。
- 建模为 `AgentPublication` 或等价概念。

### `agent_network_unpublish`

目的：

- 跟踪 agents 的显式 unpublishing/hidden state。

当前字段包括：

- `agent_id`
- `network_id`
- `unpublished_at`

重写说明：

- 重新评估。这可能是 scan/publish ambiguity 的 workaround。
- 只有存在需要 remembered suppressions 的清晰产品规则时才保留。

### `invites`

目的：

- User join links 与 device invites。

当前字段包括：

- `id`
- `code`
- `created_by`
- `network_id`
- `purpose`
- `used_at`
- `expires_at`
- `max_uses`
- `uses_count`
- `created_at`

重写说明：

- 保留 invite concept。
- 即使一张表支撑二者，也要在 application services 中拆分 user invite 与 device invite behavior。
- 显式定义 max-use behavior 与 used/revoked state。

### 提到但未完全分离的概念

当前 docs 提到这些概念：

- `join_links`
- `agent_metrics`

当前实现看起来通过 `invites` 存储 join links。Metrics 由 `agent-metrics.ts` 处理，取决于 code path，可能是 in-memory 或 partially persisted。

重写说明：

- 决定 join links 是否只是 user invites，还是独立 aggregate。
- Metrics persistence 延后到 metrics feature slice。

## Per-Network DB

每个 network 都有一块由 `StorageManager` 管理的 SQLite 空间。

### `channels`

目的：

- Public/private channels 与 DM channels。

当前字段包括：

- `id`
- `name`
- `description`
- `visibility`
- `created_by`
- `created_at`
- `archived_at`
- `is_dm`
- `dm_target_id`

重写说明：

- 保留 channels。
- 考虑将 DMs 建模为 specialized channel type，或独立的 `dm_threads` concept。当前 `is_dm` 可用但隐式。
- 只有产品需要时才保留 archive。

### `channel_members`

目的：

- Channels 中的 agent members。

当前字段包括：

- `channel_id`
- `agent_id`
- `joined_at`

重写说明：

- 保留。
- 重写时重命名为 `channel_agent_members`，避免歧义。

### `channel_user_members`

目的：

- Private channels 与显式 channel membership 中的 human members。

当前字段包括：

- `channel_id`
- `user_id`
- `joined_at`

重写说明：

- 保留。
- 在所有 reads 与 joins 中强制执行 server-side channel visibility。

### `channel_user_leaves`

目的：

- 跟踪用户对 channels 的 leave state。

当前字段包括：

- `channel_id`
- `user_id`
- `left_at`

重写说明：

- 重新评估。只有 target UX 保留 leave/hide channel 时才保留。

### `messages`

目的：

- Channel/DM/thread message persistence。

当前字段包括：

- `id`
- `channel_id`
- `sender_kind`
- `sender_id`
- `body`
- `created_at`
- `meta_json`

重写说明：

- 保留 messages。
- 尽可能用 typed metadata 替换 unstructured `meta_json`：thread、attachments、task link、display sender name、route/dispatch metadata。
- 根据 search 与 history requirements 添加 indexes。

### `artifacts`

目的：

- Uploaded/generated files 的 metadata。

当前字段包括：

- `id`
- `message_id`
- `uploader_id`
- `filename`
- `mime_type`
- `size_bytes`
- `storage_path`
- `created_at`
- `meta_json`

重写说明：

- 保留。
- 如果 access control 与 workspace views 需要，添加显式 network、channel、agent、workspace run linkage。
- 不要只依赖 filesystem path 做 authorization decisions。

### `tasks`

目的：

- Network/channel task board items。

当前字段包括：

- `id`
- `title`
- `description`
- `status`
- `creator_id`
- `assignee_id`
- `channel_id`
- `tags`
- `sort_order`
- `created_at`
- `updated_at`

重写说明：

- 保留。
- 决定 assignees 可以是 humans、agents，还是两者都可以。
- 只有 history/audit 需要时，才考虑 typed task status 与独立 task-event log。

## 缺失或定义不足的模型

这些概念存在于产品行为中，但尚未被干净建模：

- Dispatch requests 与 dispatch results。
- Workspace runs。
- Artifact-to-run linkage。
- Message thread root/reply relationship。
- `dm_target_id` 之外的 DM participant model。
- Agent runtime availability history。
- Device ownership transfer。
- Admin audit trail。
- Search index 或 searchable projection。
- Notification/reminder preferences。
- Saved/bookmarked messages 与 reactions。

## 重写数据模型方向

使用 fresh schemas 与显式 migrations。

推荐的 first-slice tables：

- `users`
- `networks`
- `network_members`
- `devices`
- `device_runtimes` 或 device runtime JSON
- `agents`
- `agent_publications`
- `channels`
- `channel_human_members`
- `channel_agent_members`
- `messages`
- `dispatches`
- `artifacts`

后续添加：

- `invites`
- `tasks`
- `workspace_runs`
- `message_threads`，如果没有用 `messages.thread_id` 表示
- `saved_messages`
- `message_reactions`
- `agent_metrics`
- `audit_events`

## 当前数据模型问题

- Schema creation 与 migration 嵌入在大型 TypeScript 文件中。
- 一些数据重复存在于 global agent rows、runtime registry state 与 web store projections 中。
- 一些重要概念隐藏在 JSON fields 中。
- DM 与 channel 共用一张表，但缺少强 typed abstraction。
- Dispatch lifecycle 不是一等 persisted model。
- Workspace runs 与 generated artifacts 需要更清晰 linkage。
- 由于没有 shipped data compatibility requirement，现有 schemas 不应约束重写。

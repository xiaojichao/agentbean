# Current Data Model Inventory

This document inventories the current persistence model. It is a Phase 0 input for the rewrite, not a schema compatibility requirement.

The old SQLite files do not need to be migrated because the product has not shipped. Use this inventory to preserve domain concepts, not table shapes.

## Storage Scopes

The current implementation has two active storage scopes:

- Global DB from `apps/server/src/db.ts`
- Per-network DB from `apps/server/src/storage.ts`

There is also an older `SCHEMA` block in `apps/server/src/db.ts` that resembles a single database containing agents, channels, messages, artifacts, and tasks. Treat it as legacy implementation history unless current code paths require it.

## Global DB

### `users`

Purpose:

- Human account identity and login.
- Current network preference.
- Admin/member role metadata.

Current fields include:

- `id`
- `username`
- `email`
- `description`
- `password_hash`
- `role`
- `current_network_id`
- `created_at`
- `updated_at`

Rewrite notes:

- Keep the user/account concept.
- Keep password hash and current network behavior.
- Do not preserve current token payload or exact role model without a product decision.

### `networks`

Purpose:

- Team/network container for channels, devices, agents, tasks, and artifacts.

Current fields include:

- `id`
- `owner_id`
- `name`
- `path`
- `description`
- `visibility`
- `type`
- `created_at`

Rewrite notes:

- Keep network/team as a core aggregate.
- Decide whether the product language is `team`, `network`, or both. Current docs use both.
- Keep URL/path slug behavior if the Web routing still uses `[networkPath]`.

### `network_members`

Purpose:

- User membership in networks.

Current fields include:

- `network_id`
- `user_id`
- `role`
- `joined_at`

Rewrite notes:

- Keep.
- Define roles explicitly rather than relying on loose strings.

### `devices`

Purpose:

- Registered daemon/device identity and last known metadata.

Current fields include:

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

Rewrite notes:

- Keep device identity, owner, network, machine/profile identity, and runtime reporting.
- Consider normalizing runtimes into a separate table only if query needs justify it. JSON is acceptable for first rewrite if contract is typed.
- `connect_command` may be derived instead of stored.

### `agents`

Purpose:

- Persisted agent identity/configuration independent of live socket state.

Current fields include:

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

Rewrite notes:

- Keep persisted agent identity and configuration.
- Replace broad `visibility` with explicit network publishing and channel membership semantics where possible.
- Keep `category` and `source`, but finalize vocabulary before implementation.
- Treat `command`, `args`, `cwd`, and `env` as custom-agent runtime config.
- Do not preserve old agent IDs if cleaner identity rules are introduced.

### `agent_network_publish`

Purpose:

- Many-to-many publishing of agents into additional networks.

Current fields include:

- `agent_id`
- `network_id`
- `published_by`
- `published_at`

Rewrite notes:

- Keep product behavior.
- Model as `AgentPublication` or equivalent.

### `agent_network_unpublish`

Purpose:

- Tracks explicit unpublishing/hidden state for agents.

Current fields include:

- `agent_id`
- `network_id`
- `unpublished_at`

Rewrite notes:

- Reevaluate. This may be a workaround for scan/publish ambiguity.
- Keep only if there is a clear product rule requiring remembered suppressions.

### `invites`

Purpose:

- User join links and device invites.

Current fields include:

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

Rewrite notes:

- Keep invite concept.
- Split user invite and device invite behavior in application services, even if one table backs both.
- Define max-use behavior and used/revoked state explicitly.

### Mentioned But Not Fully Separate

Current docs mention these concepts:

- `join_links`
- `agent_metrics`

Current implementation appears to store join links through `invites`. Metrics are handled through `agent-metrics.ts` and may be in-memory or partially persisted depending on code path.

Rewrite notes:

- Decide whether join links are just user invites or a separate aggregate.
- Defer metrics persistence until the metrics feature slice.

## Per-Network DB

Each network has its own SQLite space managed by `StorageManager`.

### `channels`

Purpose:

- Public/private channels and DM channels.

Current fields include:

- `id`
- `name`
- `description`
- `visibility`
- `created_by`
- `created_at`
- `archived_at`
- `is_dm`
- `dm_target_id`

Rewrite notes:

- Keep channels.
- Consider modeling DMs either as a specialized channel type or a separate `dm_threads` concept. Current `is_dm` is serviceable but implicit.
- Keep archive only if product needs it.

### `channel_members`

Purpose:

- Agent members in channels.

Current fields include:

- `channel_id`
- `agent_id`
- `joined_at`

Rewrite notes:

- Keep.
- Rename to `channel_agent_members` in the rewrite to avoid ambiguity.

### `channel_user_members`

Purpose:

- Human members in private channels and explicit channel membership.

Current fields include:

- `channel_id`
- `user_id`
- `joined_at`

Rewrite notes:

- Keep.
- Enforce channel visibility server-side in all reads and joins.

### `channel_user_leaves`

Purpose:

- Tracks user leave state for channels.

Current fields include:

- `channel_id`
- `user_id`
- `left_at`

Rewrite notes:

- Reevaluate. Keep only if leave/hide channel is in target UX.

### `messages`

Purpose:

- Channel/DM/thread message persistence.

Current fields include:

- `id`
- `channel_id`
- `sender_kind`
- `sender_id`
- `body`
- `created_at`
- `meta_json`

Rewrite notes:

- Keep messages.
- Replace unstructured `meta_json` with typed metadata where possible: thread, attachments, task link, display sender name, route/dispatch metadata.
- Add indexes based on search and history requirements.

### `artifacts`

Purpose:

- Metadata for uploaded/generated files.

Current fields include:

- `id`
- `message_id`
- `uploader_id`
- `filename`
- `mime_type`
- `size_bytes`
- `storage_path`
- `created_at`
- `meta_json`

Rewrite notes:

- Keep.
- Add explicit network, channel, agent, workspace run linkage if needed by access control and workspace views.
- Avoid relying only on filesystem path for authorization decisions.

### `tasks`

Purpose:

- Network/channel task board items.

Current fields include:

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

Rewrite notes:

- Keep.
- Decide whether assignees can be humans, agents, or both.
- Consider typed task status and a separate task-event log only if history/audit is needed.

## Missing Or Under-Specified Models

These concepts exist in product behavior but are not cleanly modeled yet:

- Dispatch requests and dispatch results.
- Workspace runs.
- Artifact-to-run linkage.
- Message thread root/reply relationship.
- DM participant model beyond `dm_target_id`.
- Agent runtime availability history.
- Device ownership transfer.
- Admin audit trail.
- Search index or searchable projection.
- Notification/reminder preferences.
- Saved/bookmarked messages and reactions.

## Rewrite Data Model Direction

Use fresh schemas and explicit migrations.

Recommended first-slice tables:

- `users`
- `networks`
- `network_members`
- `devices`
- `device_runtimes` or device runtime JSON
- `agents`
- `agent_publications`
- `channels`
- `channel_human_members`
- `channel_agent_members`
- `messages`
- `dispatches`
- `artifacts`

Add later:

- `invites`
- `tasks`
- `workspace_runs`
- `message_threads` if not represented by `messages.thread_id`
- `saved_messages`
- `message_reactions`
- `agent_metrics`
- `audit_events`

## Current Data Model Problems

- Schema creation and migration are embedded in large TypeScript files.
- Some data is duplicated between global agent rows, runtime registry state, and web store projections.
- Some important concepts are hidden in JSON fields.
- DM and channel share a table without a strong typed abstraction.
- Dispatch lifecycle is not a first-class persisted model.
- Workspace runs and generated artifacts need clearer linkage.
- Existing schemas should not constrain the rewrite because there is no shipped data compatibility requirement.

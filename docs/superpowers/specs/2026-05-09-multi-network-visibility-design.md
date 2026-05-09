# Multi-Network Agent Visibility + Channel System Redesign

**Date:** 2026-05-09
**Status:** In Progress (Phase 1-2 complete)

## Problem Statement

Current model: each Agent belongs to one network (`agents.network_id`) with a single `visibility` field (public/private). This doesn't support:

1. Devices joining a user's private network
2. Agents visible across multiple networks the user has joined
3. Private channels with specific user members
4. Per-network agent publishing

## Core Design Decision: Multi-to-Many Publish Model

Replace single `visibility` field with `agent_network_publish` junction table. An agent belongs to its **home network** (`agents.network_id`) and can be **published** to additional networks.

### Key Tables

```sql
-- Global DB
CREATE TABLE agent_network_publish (
  agent_id     TEXT NOT NULL,
  network_id   TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, network_id)
);

-- Per-network DB
ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE channels ADD COLUMN created_by TEXT;

CREATE TABLE channel_user_members (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
```

## Phase 1: Multi-Network Agent Publishing

### AgentRegistry changes
- `AgentRuntime.publishedNetworkIds: string[]` — in-memory list of networks this agent is published to
- `updatePublishedNetworks(agentId, networkIds)` — update after publish/unpublish

### Socket events
- `agent:publish { agentId, networkId }` — publish agent to a network (validates ownership + membership)
- `agent:unpublish { agentId, networkId }` — remove publish record
- `agents:subscribe` filter: `a.networkId === networkId || a.publishedNetworkIds.includes(networkId)`

### Frontend
- Agent detail page: per-network toggle switches for publishing
- Device page: "已发布到 N 个网络" badge per agent
- `schema.ts`: `AgentSnapshot.publishedNetworkIds?: string[]`

## Phase 2: Channel Visibility + User Members

### Channel system
- `visibility` column: `'public'` (all network users) or `'private'` (invited only)
- `channel_user_members` table for private channel user membership
- `listForUser(userId)` SQL: public channels + LEFT JOIN for private channel membership

### Socket events
- `members:list` — returns `{ humans[], agents[] }` for current network
- `channel:add-member { channelId, userId }` — add user to private channel
- `channel:remove-member { channelId, userId }` — remove user
- `channel:create` — extended with `visibility`, `userIds[]`
- `message:send` — human `senderId` now populated from `socket.data.userId`

### Frontend
- New channel dialog: visibility selector + user member selection
- Channel list: Lock icon for private channels
- Members page: real data from `members:list` event (not just currentUser)

## Phase 3: Custom Agents + Standalone Agent Scanning (Planned)

- Custom agent creation UI with per-network publish config
- Extended scanner for standalone agents (manus, anygen.io)
- Enhanced agent detail view with runtime configuration

## Key Files

| File | Changes |
|------|---------|
| `apps/server/src/db.ts` | `agent_network_publish` table + migration |
| `apps/server/src/registry.ts` | `publishedNetworkIds` field |
| `apps/server/src/namespaces/agent.ts` | Load publish records on register |
| `apps/server/src/channels.ts` | Visibility, user members, listForUser |
| `apps/server/src/storage.ts` | NETWORK_SCHEMA updates + migration |
| `apps/server/src/index.ts` | All new socket events |
| `apps/web/lib/schema.ts` | `publishedNetworkIds`, `ChannelSummary.visibility` |
| `apps/web/lib/socket.ts` | `publish/unpublish`, `memberEvents`, `channelEvents` |
| `apps/web/app/[networkPath]/agents/[agentId]/page.tsx` | Network publish toggles |
| `apps/web/app/[networkPath]/members/page.tsx` | Real member data |
| `apps/web/components/new-channel-dialog.tsx` | Visibility + user selection |
| `apps/web/app/[networkPath]/chat/page.tsx` | Private channel lock icon |

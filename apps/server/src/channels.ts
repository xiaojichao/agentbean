import type { ChannelRow } from './db.js';
import { AgentRegistry, type AgentRuntime } from './registry.js';
import { StorageManager } from './storage.js';
import { newId } from './ids.js';

interface PersistedAgentLookup {
  id: string;
  name: string;
  adapterKind: string;
  category: string;
  source: string;
}

export interface ChannelServiceDeps {
  storageManager: StorageManager;
  registry: AgentRegistry;
  getPersistedAgent?: (agentId: string) => PersistedAgentLookup | null;
}

export interface CreateChannelInput { name: string; agentIds: string[]; userIds?: string[]; visibility?: 'public' | 'private'; createdBy?: string; isDefault?: boolean; description?: string; }
export interface DmChannel { id: string; name: string; dmTargetId: string; createdAt: number; }

export class ChannelService {
  constructor(private readonly deps: ChannelServiceDeps) {}

  create(networkId: string, input: CreateChannelInput): ChannelRow {
    const agentIds = [...new Set(input.agentIds)].filter(Boolean);
    const userIds = [...new Set(input.userIds ?? [])].filter(Boolean);
    if (agentIds.length === 0 && !input.isDefault) {
      throw new Error('NO_AGENT');
    }
    const now = Date.now();
    const db = this.deps.storageManager.getSpace(networkId).db;

    const name = this.normalizeChannelName(input.name) || this.nextDefaultName(networkId);
    this.assertNameAvailable(networkId, name);
    const id = newId();
    const visibility = input.visibility ?? 'public';
    const createdBy = input.createdBy ?? null;
    db.prepare('INSERT INTO channels (id, name, description, visibility, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, input.description?.trim() || null, visibility, createdBy, now);

    const memberStmt = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)');
    for (const agentId of agentIds) {
      memberStmt.run(id, agentId, now);
    }

    const userMemberStmt = db.prepare('INSERT OR IGNORE INTO channel_user_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)');
    for (const uid of userIds) {
      userMemberStmt.run(id, uid, now);
    }

    return { id, name, description: input.description?.trim() || null, visibility, createdBy, createdAt: now, archivedAt: null };
  }

  list(networkId: string): ChannelRow[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    return db.prepare('SELECT id, name, description, visibility, created_by AS createdBy, created_at AS createdAt, archived_at AS archivedAt FROM channels WHERE archived_at IS NULL ORDER BY created_at')
      .all() as ChannelRow[];
  }

  listForUser(networkId: string, userId: string): ChannelRow[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    return db.prepare(`
      SELECT c.id, c.name, c.description, c.visibility, c.created_by AS createdBy, c.created_at AS createdAt, c.archived_at AS archivedAt
      FROM channels c
      LEFT JOIN channel_user_members cum ON c.id = cum.channel_id AND cum.user_id = ?
      LEFT JOIN channel_user_leaves cul ON c.id = cul.channel_id AND cul.user_id = ?
      WHERE c.archived_at IS NULL
        AND (c.name = 'all' OR cul.user_id IS NULL)
        AND (c.visibility = 'public' OR c.name = 'all' OR cum.user_id IS NOT NULL)
        AND (c.is_dm IS NULL OR c.is_dm = 0)
      ORDER BY c.created_at
    `).all(userId, userId) as ChannelRow[];
  }

  get(networkId: string, id: string): ChannelRow | null {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const r = db.prepare('SELECT id, name, description, visibility, created_by AS createdBy, created_at AS createdAt, archived_at AS archivedAt FROM channels WHERE id = ?')
      .get(id) as ChannelRow | undefined;
    return r ?? null;
  }

  isDefaultChannel(networkId: string, channelId: string): boolean {
    const ch = this.get(networkId, channelId);
    return Boolean(ch && ch.name === 'all');
  }

  dmTargetId(networkId: string, channelId: string): string | null {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const r = db.prepare('SELECT dm_target_id AS dmTargetId FROM channels WHERE id = ? AND is_dm = 1')
      .get(channelId) as { dmTargetId: string | null } | undefined;
    return r?.dmTargetId ?? null;
  }

  memberIds(networkId: string, channelId: string): string[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const rows = db.prepare('SELECT agent_id AS agentId FROM channel_members WHERE channel_id = ? ORDER BY joined_at')
      .all(channelId) as Array<{ agentId: string }>;
    return rows.map((m) => m.agentId);
  }

  membersOf(networkId: string, channelId: string): AgentRuntime[] {
    const ids = this.memberIds(networkId, channelId);
    return ids
      .map((id) => {
        const rt = this.deps.registry.snapshot(id);
        if (rt) return rt;
        // Resolve stale scan-prefix IDs by device+name lookup
        return this.deps.registry.resolveScanId(id);
      })
      .filter((rt): rt is AgentRuntime => rt !== null);
  }

  channelsContaining(networkId: string, agentId: string): string[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const rows = db.prepare('SELECT channel_id AS channelId FROM channel_members WHERE agent_id = ?')
      .all(agentId) as Array<{ channelId: string }>;
    return rows.map((m) => m.channelId);
  }

  addAgentMember(networkId: string, channelId: string, agentId: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)')
      .run(channelId, agentId, Date.now());
  }

  addUserMember(networkId: string, channelId: string, userId: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    db.prepare('DELETE FROM channel_user_leaves WHERE channel_id = ? AND user_id = ?')
      .run(channelId, userId);
    db.prepare('INSERT OR IGNORE INTO channel_user_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(channelId, userId, Date.now());
  }

  removeUserMember(networkId: string, channelId: string, userId: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    db.prepare('DELETE FROM channel_user_members WHERE channel_id = ? AND user_id = ?')
      .run(channelId, userId);
  }

  leaveUser(networkId: string, channelId: string, userId: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const ch = this.get(networkId, channelId);
    if (!ch || ch.name === 'all') throw new Error('CANNOT_LEAVE_DEFAULT_CHANNEL');
    this.removeUserMember(networkId, channelId, userId);
    db.prepare('INSERT OR REPLACE INTO channel_user_leaves (channel_id, user_id, left_at) VALUES (?, ?, ?)')
      .run(channelId, userId, Date.now());
  }

  userHasLeft(networkId: string, channelId: string, userId: string): boolean {
    const db = this.deps.storageManager.getSpace(networkId).db;
    return Boolean(db.prepare('SELECT 1 FROM channel_user_leaves WHERE channel_id = ? AND user_id = ?').get(channelId, userId));
  }

  update(networkId: string, channelId: string, input: { name?: string; description?: string | null; visibility?: 'public' | 'private' }): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    if (input.name !== undefined) {
      const name = this.normalizeChannelName(input.name);
      if (!name) throw new Error('EMPTY_NAME');
      this.assertNameAvailable(networkId, name, channelId);
      db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, channelId);
    }
    if (input.description !== undefined) {
      db.prepare('UPDATE channels SET description = ? WHERE id = ?').run(input.description?.trim() || null, channelId);
    }
    if (input.visibility !== undefined) {
      db.prepare('UPDATE channels SET visibility = ? WHERE id = ?').run(input.visibility, channelId);
    }
  }

  archive(networkId: string, channelId: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    db.prepare('UPDATE channels SET archived_at = ? WHERE id = ? AND name != ?').run(Date.now(), channelId, 'all');
  }

  delete(networkId: string, channelId: string): void {
    const ch = this.get(networkId, channelId);
    if (!ch || ch.name === 'all') throw new Error('CANNOT_DELETE_DEFAULT_CHANNEL');
    this.deleteChannel(networkId, channelId);
  }

  userMembers(networkId: string, channelId: string): string[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const rows = db.prepare('SELECT user_id AS userId FROM channel_user_members WHERE channel_id = ? ORDER BY joined_at')
      .all(channelId) as Array<{ userId: string }>;
    return rows.map((m) => m.userId);
  }

  ensureDefault(networkId: string): ChannelRow {
    const existing = this.list(networkId).find((c) => c.name === 'all');
    if (existing) {
      const db = this.deps.storageManager.getSpace(networkId).db;
      db.prepare('UPDATE channels SET visibility = ? WHERE id = ?').run('public', existing.id);
      db.prepare('DELETE FROM channel_user_leaves WHERE channel_id = ?').run(existing.id);
      return { ...existing, visibility: 'public' };
    }
    return this.create(networkId, { name: 'all', agentIds: [], isDefault: true });
  }

  findOrCreateDm(networkId: string, userId: string, agentId: string): DmChannel {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const agentName = this.resolveDmAgentName(agentId);
    if (!agentName) throw new Error('INVALID_DM_TARGET');
    // Check for existing DM channel between this user and agent
    const existing = db.prepare(`
      SELECT c.id, c.name, c.dm_target_id AS dmTargetId, c.created_at AS createdAt
      FROM channels c
      JOIN channel_user_members cum ON c.id = cum.channel_id
      JOIN channel_members cm ON c.id = cm.channel_id
      WHERE c.is_dm = 1 AND cum.user_id = ? AND cm.agent_id = ?
    `).get(userId, agentId) as DmChannel | undefined;
    if (existing) {
      if (existing.name !== agentName) {
        db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(agentName, existing.id);
      }
      return { ...existing, name: agentName };
    }

    const now = Date.now();
    const id = newId();
    db.prepare('INSERT INTO channels (id, name, visibility, created_by, created_at, is_dm, dm_target_id) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(id, agentName, 'private', userId, now, agentId);
    db.prepare('INSERT INTO channel_user_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(id, userId, now);
    db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)')
      .run(id, agentId, now);

    return { id, name: agentName, dmTargetId: agentId, createdAt: now };
  }

  listDms(networkId: string, userId: string): DmChannel[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const rows = db.prepare(`
      SELECT c.id, c.name, c.dm_target_id AS dmTargetId, c.created_at AS createdAt
      FROM channels c
      JOIN channel_user_members cum ON c.id = cum.channel_id
      WHERE c.is_dm = 1 AND cum.user_id = ?
      ORDER BY c.created_at DESC
    `).all(userId) as DmChannel[];
    const valid: DmChannel[] = [];
    for (const row of rows) {
      const agentName = this.resolveDmAgentName(row.dmTargetId);
      if (!agentName) {
        this.deleteChannel(networkId, row.id);
        continue;
      }
      if (row.name !== agentName) {
        db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(agentName, row.id);
      }
      valid.push({ ...row, name: agentName });
    }
    return valid;
  }

  private resolveDmAgentName(agentId: string): string | null {
    const runtime = this.deps.registry.snapshot(agentId);
    if (runtime && (runtime.category === 'agentos-hosted' || runtime.source === 'custom')) return runtime.name;
    const persisted = this.deps.getPersistedAgent?.(agentId);
    if (!persisted) return null;
    if (persisted.category === 'agentos-hosted' || persisted.source === 'custom') return persisted.name;
    return null;
  }

  private deleteChannel(networkId: string, channelId: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const artifactIds = db.prepare(`
      SELECT a.id
      FROM artifacts a
      JOIN messages m ON a.message_id = m.id
      WHERE m.channel_id = ?
    `).all(channelId) as Array<{ id: string }>;
    const tx = db.transaction(() => {
      if (artifactIds.length > 0) {
        const deleteArtifact = db.prepare('DELETE FROM artifacts WHERE id = ?');
        for (const artifact of artifactIds) deleteArtifact.run(artifact.id);
      }
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
      db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channelId);
      db.prepare('DELETE FROM channel_user_members WHERE channel_id = ?').run(channelId);
      db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    });
    tx();
  }

  private nextDefaultName(networkId: string): string {
    const db = this.deps.storageManager.getSpace(networkId).db;
    let index = this.list(networkId).length + 1;
    while (true) {
      const candidate = `频道 ${index}`;
      const existing = db.prepare(`
        SELECT id FROM channels
        WHERE COALESCE(is_dm, 0) = 0 AND lower(name) = lower(?)
        LIMIT 1
      `).get(candidate);
      if (!existing) return candidate;
      index += 1;
    }
  }

  private normalizeChannelName(name: string): string {
    return name.trim().replace(/\s+/g, ' ');
  }

  private assertNameAvailable(networkId: string, name: string, exceptId?: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const existing = db.prepare(`
      SELECT id FROM channels
      WHERE COALESCE(is_dm, 0) = 0
        AND archived_at IS NULL
        AND lower(name) = lower(?)
        AND (? IS NULL OR id != ?)
      LIMIT 1
    `).get(name, exceptId ?? null, exceptId ?? null) as { id: string } | undefined;
    if (existing) throw new Error('CHANNEL_NAME_EXISTS');
  }
}

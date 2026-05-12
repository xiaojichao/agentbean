import type { ChannelRow } from './db.js';
import { AgentRegistry, type AgentRuntime } from './registry.js';
import { StorageManager } from './storage.js';
import { newId } from './ids.js';

export interface ChannelServiceDeps { storageManager: StorageManager; registry: AgentRegistry; }

export interface CreateChannelInput { name: string; agentIds: string[]; userIds?: string[]; visibility?: 'public' | 'private'; createdBy?: string; isDefault?: boolean; }
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

    const name = input.name.trim() || this.nextDefaultName(networkId);
    const id = newId();
    const visibility = input.visibility ?? 'public';
    const createdBy = input.createdBy ?? null;
    db.prepare('INSERT INTO channels (id, name, visibility, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, visibility, createdBy, now);

    const memberStmt = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)');
    for (const agentId of agentIds) {
      memberStmt.run(id, agentId, now);
    }

    const userMemberStmt = db.prepare('INSERT OR IGNORE INTO channel_user_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)');
    for (const uid of userIds) {
      userMemberStmt.run(id, uid, now);
    }

    return { id, name, visibility, createdBy, createdAt: now };
  }

  list(networkId: string): ChannelRow[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    return db.prepare('SELECT id, name, visibility, created_by AS createdBy, created_at AS createdAt FROM channels ORDER BY created_at')
      .all() as ChannelRow[];
  }

  listForUser(networkId: string, userId: string): ChannelRow[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    return db.prepare(`
      SELECT c.id, c.name, c.visibility, c.created_by AS createdBy, c.created_at AS createdAt
      FROM channels c
      LEFT JOIN channel_user_members cum ON c.id = cum.channel_id AND cum.user_id = ?
      WHERE (c.visibility = 'public' OR cum.user_id IS NOT NULL) AND (c.is_dm IS NULL OR c.is_dm = 0)
      ORDER BY c.created_at
    `).all(userId) as ChannelRow[];
  }

  get(networkId: string, id: string): ChannelRow | null {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const r = db.prepare('SELECT id, name, visibility, created_by AS createdBy, created_at AS createdAt FROM channels WHERE id = ?')
      .get(id) as ChannelRow | undefined;
    return r ?? null;
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

  addUserMember(networkId: string, channelId: string, userId: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    db.prepare('INSERT OR IGNORE INTO channel_user_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(channelId, userId, Date.now());
  }

  removeUserMember(networkId: string, channelId: string, userId: string): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    db.prepare('DELETE FROM channel_user_members WHERE channel_id = ? AND user_id = ?')
      .run(channelId, userId);
  }

  update(networkId: string, channelId: string, input: { name?: string; visibility?: 'public' | 'private' }): void {
    const db = this.deps.storageManager.getSpace(networkId).db;
    if (input.name !== undefined) {
      db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(input.name.trim(), channelId);
    }
    if (input.visibility !== undefined) {
      db.prepare('UPDATE channels SET visibility = ? WHERE id = ?').run(input.visibility, channelId);
    }
  }

  userMembers(networkId: string, channelId: string): string[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const rows = db.prepare('SELECT user_id AS userId FROM channel_user_members WHERE channel_id = ? ORDER BY joined_at')
      .all(channelId) as Array<{ userId: string }>;
    return rows.map((m) => m.userId);
  }

  ensureDefault(networkId: string): ChannelRow {
    const existing = this.list(networkId).find((c) => c.name === 'all');
    if (existing) return existing;
    return this.create(networkId, { name: 'all', agentIds: [], isDefault: true });
  }

  findOrCreateDm(networkId: string, userId: string, agentId: string): DmChannel {
    const db = this.deps.storageManager.getSpace(networkId).db;
    // Check for existing DM channel between this user and agent
    const existing = db.prepare(`
      SELECT c.id, c.name, c.dm_target_id AS dmTargetId, c.created_at AS createdAt
      FROM channels c
      JOIN channel_user_members cum ON c.id = cum.channel_id
      JOIN channel_members cm ON c.id = cm.channel_id
      WHERE c.is_dm = 1 AND cum.user_id = ? AND cm.agent_id = ?
    `).get(userId, agentId) as DmChannel | undefined;
    if (existing) return existing;

    const agent = this.deps.registry.snapshot(agentId);
    const agentName = agent?.name ?? agentId;
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
    return db.prepare(`
      SELECT c.id, c.name, c.dm_target_id AS dmTargetId, c.created_at AS createdAt
      FROM channels c
      JOIN channel_user_members cum ON c.id = cum.channel_id
      WHERE c.is_dm = 1 AND cum.user_id = ?
      ORDER BY c.created_at DESC
    `).all(userId) as DmChannel[];
  }

  private nextDefaultName(networkId: string): string {
    const count = this.list(networkId).length;
    return `频道 ${count + 1}`;
  }
}

import type { ChannelRow } from './db.js';
import { AgentRegistry, type AgentRuntime } from './registry.js';
import { StorageManager } from './storage.js';
import { newId } from './ids.js';

export interface ChannelServiceDeps { storageManager: StorageManager; registry: AgentRegistry; }

export interface CreateChannelInput { name: string; agentIds: string[]; isDefault?: boolean; }

export class ChannelService {
  constructor(private readonly deps: ChannelServiceDeps) {}

  create(networkId: string, input: CreateChannelInput): ChannelRow {
    const agentIds = [...new Set(input.agentIds)].filter(Boolean);
    if (agentIds.length === 0 && !input.isDefault) {
      throw new Error('NO_AGENT');
    }
    const now = Date.now();
    const db = this.deps.storageManager.getSpace(networkId).db;

    const name = input.name.trim() || this.nextDefaultName(networkId);
    const id = newId();
    db.prepare('INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)')
      .run(id, name, now);

    const memberStmt = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)');
    for (const agentId of agentIds) {
      memberStmt.run(id, agentId, now);
    }

    return { id, name, createdAt: now };
  }

  list(networkId: string): ChannelRow[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    return db.prepare('SELECT id, name, created_at AS createdAt FROM channels ORDER BY created_at')
      .all() as ChannelRow[];
  }

  get(networkId: string, id: string): ChannelRow | null {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const r = db.prepare('SELECT id, name, created_at AS createdAt FROM channels WHERE id = ?')
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
      .map((id) => this.deps.registry.snapshot(id))
      .filter((rt): rt is AgentRuntime => rt !== null);
  }

  channelsContaining(networkId: string, agentId: string): string[] {
    const db = this.deps.storageManager.getSpace(networkId).db;
    const rows = db.prepare('SELECT channel_id AS channelId FROM channel_members WHERE agent_id = ?')
      .all(agentId) as Array<{ channelId: string }>;
    return rows.map((m) => m.channelId);
  }

  ensureDefault(networkId: string): ChannelRow {
    const existing = this.list(networkId).find((c) => c.name === 'all');
    if (existing) return existing;
    return this.create(networkId, { name: 'all', agentIds: [], isDefault: true });
  }

  private nextDefaultName(networkId: string): string {
    const count = this.list(networkId).length;
    return `频道 ${count + 1}`;
  }
}

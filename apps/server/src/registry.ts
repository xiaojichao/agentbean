import type { AdapterKind, AgentCategory } from './db.js';

export type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';

export interface AgentRegisterInfo {
  id: string;
  name: string;
  role: string;
  adapterKind: AdapterKind;
  category?: AgentCategory;
  networkId?: string;
  visibility?: 'public' | 'private';
  ownerId?: string | null;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  description?: string | null;
  deviceId?: string;
  publishedNetworkIds?: string[];
  source?: 'self-register' | 'scanned' | 'custom';
}

export interface AgentRuntime extends AgentRegisterInfo {
  status: AgentStatus;
  socketId: string | null;
  lastHeartbeatAt: number;
  firstSeenAt: number;
  lastError?: { at: number; message: string };
  publishedNetworkIds: string[];
}

type KickListener = (oldSocketId: string) => void;

export class AgentRegistry {
  private byId = new Map<string, AgentRuntime>();
  private kickListeners: KickListener[] = [];

  onKick(fn: KickListener) { this.kickListeners.push(fn); }

  register(socketId: string, info: AgentRegisterInfo): AgentRuntime {
    const now = Date.now();
    const existing = this.byId.get(info.id);
    if (existing && existing.socketId && existing.socketId !== socketId) {
      const oldSocket = existing.socketId;
      for (const fn of this.kickListeners) fn(oldSocket);
    }
    const next: AgentRuntime = {
      ...info,
      category: info.category ?? existing?.category ?? 'executor-hosted',
      networkId: info.networkId ?? existing?.networkId ?? 'default',
      status: 'online',
      socketId,
      lastHeartbeatAt: now,
      firstSeenAt: existing?.firstSeenAt ?? now,
      publishedNetworkIds: info.publishedNetworkIds ?? existing?.publishedNetworkIds ?? [],
    };
    this.byId.set(info.id, next);
    return next;
  }

  heartbeat(agentId: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.lastHeartbeatAt = Date.now();
    if (a.status === 'offline' || a.status === 'error') a.status = 'online';
    a.lastError = undefined;
    return a;
  }

  markBusy(agentId: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    if (a.status === 'online') a.status = 'busy';
    return a;
  }

  markOnline(agentId: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    if (a.status === 'busy' || a.status === 'error') a.status = 'online';
    return a;
  }

  markOffline(agentId: string, _reason: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.status = 'offline';
    a.socketId = null;
    return a;
  }

  markError(agentId: string, message: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.status = 'error';
    a.lastError = { at: Date.now(), message };
    return a;
  }

  updateVisibility(agentId: string, visibility: 'public' | 'private'): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.visibility = visibility;
    return a;
  }

  updateCategory(agentId: string, category: AgentCategory): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.category = category;
    return a;
  }

  updateNetworkId(agentId: string, networkId: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.networkId = networkId;
    return a;
  }

  updatePublishedNetworks(agentId: string, networkIds: string[]): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.publishedNetworkIds = networkIds;
    return a;
  }

  snapshot(agentId: string): AgentRuntime | null {
    return this.byId.get(agentId) ?? null;
  }

  registerVirtual(info: AgentRegisterInfo): AgentRuntime {
    const now = Date.now();
    const existing = this.byId.get(info.id);
    const next: AgentRuntime = {
      ...info,
      category: info.category ?? existing?.category ?? 'executor-hosted',
      networkId: info.networkId ?? existing?.networkId ?? 'default',
      status: 'offline',
      socketId: null,
      lastHeartbeatAt: now,
      firstSeenAt: existing?.firstSeenAt ?? now,
      publishedNetworkIds: info.publishedNetworkIds ?? existing?.publishedNetworkIds ?? [],
    };
    this.byId.set(info.id, next);
    return next;
  }

  all(): AgentRuntime[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  bySocket(socketId: string): AgentRuntime | null {
    for (const v of this.byId.values()) if (v.socketId === socketId) return v;
    return null;
  }

  findByDeviceAndName(deviceId: string, name: string): AgentRuntime | null {
    const norm = name.trim().toLowerCase().replace(/\s+/g, '-');
    for (const v of this.byId.values()) {
      if (v.deviceId === deviceId && v.name.trim().toLowerCase().replace(/\s+/g, '-') === norm) {
        return v;
      }
    }
    return null;
  }

  /** Resolve a stale scan-prefix ID (scan-{uuid}-{name}) to the current registry entry */
  resolveScanId(scanId: string): AgentRuntime | null {
    const match = scanId.match(/^scan-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i);
    if (!match) return null;
    return this.findByDeviceAndName(match[1]!, match[2]!);
  }
}

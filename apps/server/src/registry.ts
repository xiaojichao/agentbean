import type { AdapterKind, AgentCategory } from './db.js';

export type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';

export interface AgentRegisterInfo {
  id: string;
  name: string;
  role: string;
  adapterKind: AdapterKind;
  category: AgentCategory;
  networkId: string;
  visibility?: 'public' | 'private';
  ownerId?: string | null;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  deviceId?: string;
  publishedNetworkIds?: string[];
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

  all(): AgentRuntime[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  bySocket(socketId: string): AgentRuntime | null {
    for (const v of this.byId.values()) if (v.socketId === socketId) return v;
    return null;
  }
}

import type { Socket } from 'socket.io';

export type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';

export interface PublicAgentMeta {
  id: string;
  name: string;
  role: string;
  adapterKind: string;
  category?: string;
  visibility?: 'public' | 'private';
}

export interface RuntimeMeta {
  name: string;
  adapterKind: string;
  command: string;
  installed: boolean;
}

export interface DeviceRuntime {
  id: string;
  userId: string;
  networkId: string;
  socket: Socket;
  agents: Map<string, PublicAgentMeta>;
  runtimes?: RuntimeMeta[];
  lastSeenAt: number;
  status: AgentStatus;
}

type KickListener = (oldSocketId: string) => void;

export class DeviceRegistry {
  private devices = new Map<string, DeviceRuntime>();
  private kickListeners: KickListener[] = [];

  onKick(fn: KickListener): void { this.kickListeners.push(fn); }

  register(device: DeviceRuntime): DeviceRuntime {
    const existing = this.devices.get(device.id);
    if (existing && existing.socket.id !== device.socket.id) {
      for (const fn of this.kickListeners) fn(existing.socket.id);
    }
    this.devices.set(device.id, device);
    return device;
  }

  get(deviceId: string): DeviceRuntime | undefined {
    return this.devices.get(deviceId);
  }

  getBySocket(socketId: string): DeviceRuntime | undefined {
    for (const d of this.devices.values()) {
      if (d.socket.id === socketId) return d;
    }
    return undefined;
  }

  remove(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  listByNetwork(networkId: string): DeviceRuntime[] {
    return Array.from(this.devices.values()).filter(d => d.networkId === networkId);
  }

  getAgentDevice(agentId: string): DeviceRuntime | undefined {
    for (const d of this.devices.values()) {
      if (d.agents.has(agentId)) return d;
    }
    return undefined;
  }

  allAgents(networkId: string): PublicAgentMeta[] {
    const result: PublicAgentMeta[] = [];
    for (const d of this.devices.values()) {
      if (d.networkId === networkId) {
        result.push(...d.agents.values());
      }
    }
    return result;
  }

  heartbeat(deviceId: string): DeviceRuntime | null {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    d.lastSeenAt = Date.now();
    if (d.status === 'offline' || d.status === 'error') d.status = 'online';
    return d;
  }

  markBusy(deviceId: string): DeviceRuntime | null {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    if (d.status === 'online') d.status = 'busy';
    return d;
  }

  markOnline(deviceId: string): DeviceRuntime | null {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    if (d.status === 'busy' || d.status === 'error') d.status = 'online';
    return d;
  }

  markOffline(deviceId: string): DeviceRuntime | null {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    d.status = 'offline';
    return d;
  }

  markError(deviceId: string): DeviceRuntime | null {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    d.status = 'error';
    return d;
  }

  snapshot(deviceId: string): DeviceRuntime | null {
    return this.devices.get(deviceId) ?? null;
  }

  all(): DeviceRuntime[] {
    return [...this.devices.values()];
  }
}

import type { Namespace, Server as IOServer } from 'socket.io';
import type { Db, AdapterKind, AgentCategory } from '../db.js';
import { AgentRegistry, type AgentRuntime } from '../registry.js';
import { DeviceRegistry, type PublicAgentMeta } from '../device-registry.js';
import { parseToken, verifyUserToken } from '../auth.js';
import { renderConnectCommand } from '../connect-command.js';
import { logger } from '../log.js';
import { AgentMetricsCollector } from '../agent-metrics.js';

export interface AgentNamespaceDeps {
  io: IOServer;
  db: Db;
  registry: AgentRegistry;
  deviceRegistry: DeviceRegistry;
  token: string;
  globalDb?: {
    users: { get(id: string): { id: string } | null };
    networkMembers: { isMember(networkId: string, userId: string): boolean };
    networks: { get(id: string): { id: string; visibility: 'public' | 'private' } | null };
    agentPublishes: { listByAgent(agentId: string): { networkId: string }[] };
    agents?: {
      upsert(row: any): void;
      get(id: string): any;
    };
    devices?: {
      upsert(row: { id: string; userId: string; networkId: string; hostname?: string; tailscaleIp?: string; lastSeenAt: number }): void;
    };
  };
  dispatchTimeoutMs?: number;
  metricsCollector?: AgentMetricsCollector;
}

export interface DispatchRequest {
  agentId: string;
  channelId: string;
  prompt: string;
  requestId: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; speaker: string; body: string; at: number }>;
}

export interface DispatchResolution { ok: boolean; body?: string; error?: string; artifactIds?: string[]; }

export type DispatchFn = (req: DispatchRequest) => Promise<DispatchResolution>;

export interface AgentSnapshotDto {
  id: string;
  name: string;
  role: string;
  adapterKind: AdapterKind;
  status: AgentRuntime['status'];
  lastSeenAt: number;
  lastError?: string;
  connectCommand: string;
  visibility?: 'public' | 'private';
  category?: AgentCategory;
  networkId?: string;
  ownerId?: string | null;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  deviceId?: string;
  publishedNetworkIds?: string[];
  source?: 'self-register' | 'scanned' | 'custom';
}

export function snapshotToDto(rt: AgentRuntime): AgentSnapshotDto {
  return {
    id: rt.id,
    name: rt.name,
    role: rt.role,
    adapterKind: rt.adapterKind,
    status: rt.status,
    lastSeenAt: rt.lastHeartbeatAt,
    lastError: rt.lastError?.message,
    connectCommand: renderConnectCommand({ adapterKind: rt.adapterKind }),
    visibility: rt.visibility,
    category: rt.category,
    networkId: rt.networkId,
    ownerId: rt.ownerId ?? null,
    command: rt.command ?? null,
    args: rt.args ?? null,
    cwd: rt.cwd ?? null,
    deviceId: rt.deviceId,
    publishedNetworkIds: rt.publishedNetworkIds,
    source: rt.source,
  };
}

interface PendingDispatch {
  resolve: (result: DispatchResolution) => void;
  timer: NodeJS.Timeout;
}

export interface AgentNamespaceHandle {
  ns: Namespace;
  dispatch: DispatchFn;
}

export function attachAgentNamespace(deps: AgentNamespaceDeps): AgentNamespaceHandle {
  const ns = deps.io.of('/agent');
  const pending = new Map<string, PendingDispatch>();
  const timeoutMs = deps.dispatchTimeoutMs ?? 300_000;

  ns.use((socket, next) => {
    const auth = socket.handshake.auth ?? {};
    if (typeof auth.token !== 'string' || typeof deps.token !== 'string') {
      return next(new Error('auth: bad token'));
    }
    if (typeof auth.deviceId !== 'string') return next(new Error('auth: deviceId required'));
    if (typeof auth.networkId !== 'string') return next(new Error('auth: networkId required'));

    const tokenBuf = Buffer.from(auth.token);
    const expectedBuf = Buffer.from(deps.token);
    let legacyMatch = tokenBuf.length === expectedBuf.length;
    if (legacyMatch) {
      let mismatch = 0;
      for (let i = 0; i < tokenBuf.length; i++) mismatch |= tokenBuf[i]! ^ expectedBuf[i]!;
      legacyMatch = mismatch === 0;
    }

    const parsed = legacyMatch ? null : (deps.globalDb ? verifyUserToken(auth.token, deps.globalDb) : null);
    if (!legacyMatch && (!parsed || parsed.networkId !== auth.networkId)) {
      return next(new Error('auth: token network mismatch'));
    }
    if (!legacyMatch && parsed && deps.globalDb) {
      const network = deps.globalDb.networks.get(auth.networkId);
      if (!network) return next(new Error('auth: network not found'));
      if (network.visibility !== 'public' && !deps.globalDb.networkMembers.isMember(auth.networkId, parsed.userId)) {
        return next(new Error('auth: network forbidden'));
      }
    }
    next();
  });

  deps.registry.onKick((oldSocketId) => {
    ns.sockets.get(oldSocketId)?.disconnect(true);
  });

  deps.deviceRegistry.onKick((oldSocketId) => {
    ns.sockets.get(oldSocketId)?.disconnect(true);
  });

  ns.on('connection', (socket) => {
    const auth = socket.handshake.auth as {
      token: string;
      deviceId: string;
      networkId: string;
      tailscaleIp?: string;
      agents: PublicAgentMeta[];
    };
    const a = auth;
    logger.info({ deviceId: a.deviceId, sid: socket.id }, '/agent connected');

    socket.on('register', () => {
      // Register each public agent in AgentRegistry (for Web UI compatibility)
      const now = Date.now();
      for (const agentMeta of a.agents) {
        const publishes = deps.globalDb?.agentPublishes?.listByAgent(agentMeta.id) ?? [];
        const publishedNetworkIds = publishes.map((p: { networkId: string }) => p.networkId);
        const rt = deps.registry.register(socket.id, {
          id: agentMeta.id,
          name: agentMeta.name,
          role: agentMeta.role,
          adapterKind: agentMeta.adapterKind as AdapterKind,
          category: (agentMeta.category as AgentCategory) ?? 'executor-hosted',
          networkId: a.networkId,
          visibility: agentMeta.visibility,
          deviceId: a.deviceId,
          publishedNetworkIds,
        });
        deps.db.agents.upsert({
          id: rt.id, name: rt.name, role: rt.role, adapterKind: rt.adapterKind,
          deviceId: a.deviceId,
          networkId: a.networkId,
          visibility: rt.visibility ?? 'public',
          category: rt.category ?? 'executor-hosted',
          firstSeenAt: rt.firstSeenAt, lastSeenAt: now, lastError: null,
          ownerId: rt.ownerId ?? null,
          command: rt.command ?? null,
          args: rt.args ? JSON.stringify(rt.args) : null,
          cwd: rt.cwd ?? null,
        });
        deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
      }

      // Persist device to global DB
      const userId = parseToken(a.token!)?.userId;
      if (userId) {
        deps.globalDb?.devices?.upsert({
          id: a.deviceId,
          userId,
          networkId: a.networkId,
          lastSeenAt: now,
        });
      }

      // Register device in DeviceRegistry
      deps.deviceRegistry.register({
        id: a.deviceId,
        userId: parseToken(a.token!)!.userId,
        networkId: a.networkId,
        socket,
        tailscaleIp: a.tailscaleIp,
        agents: new Map(a.agents.map((ag) => [ag.id, ag])),
        lastSeenAt: now,
        status: 'online',
      });
    });

    socket.on('heartbeat', () => {
      const device = deps.deviceRegistry.heartbeat(a.deviceId);
      if (device) {
        for (const agentMeta of device.agents.values()) {
          const rt = deps.registry.heartbeat(agentMeta.id);
          if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
        }
      }
    });

    socket.on('reply', (payload: { agentId: string; channelId: string; body: string; requestId: string; artifactIds?: string[] }) => {
      const p = pending.get(payload.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(payload.requestId);
      p.resolve({ ok: true, body: payload.body, artifactIds: payload.artifactIds });
      deps.metricsCollector?.resolve(payload.requestId, true);
      const rt = deps.registry.markOnline(payload.agentId);
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('error_event', (payload: { agentId: string; at?: number; message?: string; scope?: string; requestId?: string }) => {
      if (payload?.requestId && pending.has(payload.requestId)) {
        const p = pending.get(payload.requestId)!;
        clearTimeout(p.timer);
        pending.delete(payload.requestId);
        p.resolve({ ok: false, error: payload.message ?? 'unknown' });
        deps.metricsCollector?.resolve(payload.requestId, false, payload.message ?? 'unknown');
      }
      const rt = deps.registry.markError(payload.agentId, payload?.message ?? 'unknown error');
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('agents:discovered', (payload: { agents: any[] }) => {
      deps.io.of('/web').emit('agents:discovered', payload);
    });

    // Daemon registers scanned agents (runtimes, agentOS, standalone)
    socket.on('device:register-agents', (payload: {
      agents: { name: string; category: string; adapterKind: string; command: string; args: string[]; source?: string }[]
    }, ack?: (r: any) => void) => {
      try {
        const now = Date.now();
        const registered: any[] = [];
        for (const ag of payload.agents) {
          // Generate stable ID from deviceId + agent name for dedup
          const agentId = `scan-${a.deviceId}-${ag.name.toLowerCase().replace(/\s+/g, '-')}`;
          const existing = deps.globalDb?.agents?.get(agentId);

          // Persist to global DB
          deps.globalDb?.agents?.upsert({
            id: agentId,
            name: ag.name,
            adapterKind: ag.adapterKind as AdapterKind,
            deviceId: a.deviceId,
            networkId: a.networkId,
            category: (ag.category as AgentCategory) ?? 'executor-hosted',
            source: (ag.source as any) ?? 'scanned',
            firstSeenAt: existing ? (existing as any).firstSeenAt ?? now : now,
            lastSeenAt: now,
            command: ag.command,
            args: ag.args ? JSON.stringify(ag.args) : undefined,
          });

          // Persist to per-network DB
          deps.db.agents.upsert({
            id: agentId,
            name: ag.name,
            role: null,
            adapterKind: ag.adapterKind as AdapterKind,
            deviceId: a.deviceId,
            networkId: a.networkId,
            visibility: 'public' as const,
            category: (ag.category as AgentCategory) ?? 'executor-hosted',
            source: (ag.source as any) ?? 'scanned',
            firstSeenAt: existing ? (existing as any).firstSeenAt ?? now : now,
            lastSeenAt: now,
            lastError: null,
            ownerId: null,
            command: ag.command,
            args: ag.args ? JSON.stringify(ag.args) : null,
            cwd: null,
          });

          // Register in AgentRegistry (in-memory)
          const publishes = deps.globalDb?.agentPublishes?.listByAgent(agentId) ?? [];
          const rt = deps.registry.register(socket.id, {
            id: agentId,
            name: ag.name,
            role: '',
            adapterKind: ag.adapterKind as AdapterKind,
            category: (ag.category as AgentCategory) ?? 'executor-hosted',
            networkId: a.networkId,
            deviceId: a.deviceId,
            publishedNetworkIds: publishes.map((p: { networkId: string }) => p.networkId),
          });
          deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
          registered.push({ id: agentId, name: ag.name, category: ag.category, status: 'online' });
        }
        ack?.({ ok: true, agents: registered });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('disconnect', () => {
      const device = deps.deviceRegistry.markOffline(a.deviceId);
      if (device) {
        for (const agentMeta of device.agents.values()) {
          const rt = deps.registry.markOffline(agentMeta.id, 'device-disconnect');
          if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
        }
      }
      for (const [reqId, p] of pending.entries()) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'agent disconnected' });
        deps.metricsCollector?.resolve(reqId, false, 'agent disconnected');
        pending.delete(reqId);
      }
    });
  });

  const dispatch: DispatchFn = (req) => new Promise<DispatchResolution>((resolve) => {
    // Find the device that hosts this agent
    const device = deps.deviceRegistry.getAgentDevice(req.agentId);
    if (!device || device.status === 'offline') {
      resolve({ ok: false, error: `${req.agentId} 不在线` });
      return;
    }
    const sock = ns.sockets.get(device.socket.id);
    if (!sock) {
      resolve({ ok: false, error: `${req.agentId} socket 不可达` });
      return;
    }
    const busyRt = deps.registry.markBusy(req.agentId);
    if (busyRt) {
      deps.io.of('/web').emit('agent:status', snapshotToDto(busyRt));
    }
    deps.metricsCollector?.start(req.agentId, req.requestId);

    const timer = setTimeout(() => {
      pending.delete(req.requestId);
      resolve({ ok: false, error: `超时 (${timeoutMs / 1000}s)` });
      deps.metricsCollector?.resolve(req.requestId, false, `超时 (${timeoutMs / 1000}s)`);
      deps.registry.markOnline(req.agentId);
      deps.io.of('/web').emit('agent:status', snapshotToDto(deps.registry.snapshot(req.agentId)!));
    }, timeoutMs);
    pending.set(req.requestId, { resolve, timer });

    const agentRuntime = deps.registry.snapshot(req.agentId);
    const sandboxed = agentRuntime?.visibility === 'public' && agentRuntime.category !== 'agentos-hosted';
    sock.emit('dispatch', { ...req, sandboxed });
  });

  return { ns, dispatch };
}

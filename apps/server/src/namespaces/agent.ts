import type { Namespace, Server as IOServer } from 'socket.io';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Db, AdapterKind, AgentCategory } from '../db.js';
import { AgentRegistry, normalizeAgentName, type AgentRuntime } from '../registry.js';
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
      upsert(row: { id: string; userId: string; networkId: string; hostname?: string; lastSeenAt: number; systemInfo?: Record<string, unknown> | null }): void;
      get(id: string): { id: string; hostname?: string | null; connectCommand?: string | null } | null;
      setConnectCommand(id: string, command: string): void;
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
  description?: string | null;
  deviceId?: string;
  publishedNetworkIds?: string[];
  source?: 'self-register' | 'scanned' | 'custom';
}

export function snapshotToDto(rt: AgentRuntime): AgentSnapshotDto {
  return {
    id: rt.id,
    name: normalizeAgentName(rt.name),
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
    description: rt.description ?? null,
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
      agents: PublicAgentMeta[];
      systemInfo?: Record<string, unknown>;
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
          name: normalizeAgentName(agentMeta.name),
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
          description: rt.description ?? null,
        });
        deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
      }

      // Persist device to global DB
      const parsed = parseToken(a.token!);
      const userId = parsed?.userId ?? 'system';
      const existingDevice = deps.globalDb?.devices?.get(a.deviceId);
      const sysHostname = a.systemInfo?.hostname ? String(a.systemInfo.hostname).replace(/\s+/g, '-') : undefined;
      deps.globalDb?.devices?.upsert({
        id: a.deviceId,
        userId,
        networkId: a.networkId,
        hostname: existingDevice?.hostname ?? sysHostname,
        lastSeenAt: now,
        systemInfo: a.systemInfo ?? null,
      });
      // Save connect command on first registration
      if (!existingDevice?.connectCommand) {
        const publicUrl = process.env.AGENT_BEAN_PUBLIC_SERVER_URL;
        const localEntrypoint = resolve(process.cwd(), '../daemon/src/bin.ts');
        let cmd: string;
        if (publicUrl) {
          // Production: always use npm package with public URL
          cmd = `npx @agentbean/daemon@latest --server-url ${publicUrl} --token ${a.token}`;
        } else if (existsSync(localEntrypoint)) {
          // Local dev: use tsx with local source
          cmd = `npx tsx ${localEntrypoint} --server-url http://localhost:4000 --token ${a.token}`;
        } else {
          // Fallback: npm package with localhost
          cmd = `npx @agentbean/daemon@latest --server-url http://localhost:4000 --token ${a.token}`;
        }
        deps.globalDb?.devices?.setConnectCommand(a.deviceId, cmd);
      }

      // Register device in DeviceRegistry
      deps.deviceRegistry.register({
        id: a.deviceId,
        userId: userId ?? 'system',
        networkId: a.networkId,
        socket,
        agents: new Map(a.agents.map((ag) => [ag.id, { ...ag, name: normalizeAgentName(ag.name) }])),
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
        const message = payload.message?.trim() || 'agent reported an error without details';
        p.resolve({ ok: false, error: message });
        deps.metricsCollector?.resolve(payload.requestId, false, message);
      }
      const rt = deps.registry.markError(payload.agentId, payload?.message?.trim() || 'agent reported an error without details');
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
        const agentPayload = payload.agents.filter((ag) =>
          ag.category === 'agentos-hosted' || ag.source === 'custom'
        );
        for (const ag of agentPayload) {
          const sanitizedName = normalizeAgentName(ag.name);

          // Check if already registered via daemon's 'register' event
          const existingRt = deps.registry.findByDeviceAndName(a.deviceId, sanitizedName);
          if (existingRt) {
            // Clean up old scan-prefix entry if it exists
            const staleScanId = `scan-${a.deviceId}-${sanitizedName.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
            try { deps.db.raw.prepare('DELETE FROM agents WHERE id = ?').run(staleScanId); } catch {}
            try { deps.db.raw.prepare('DELETE FROM channel_members WHERE agent_id = ?').run(staleScanId); } catch {}

            // Still update DB with latest scan info, but don't create a duplicate registry entry
            deps.globalDb?.agents?.upsert({
              id: existingRt.id, name: sanitizedName, adapterKind: ag.adapterKind as AdapterKind,
              deviceId: a.deviceId, networkId: a.networkId,
              category: (ag.category as AgentCategory) ?? 'executor-hosted',
              source: (ag.source as any) ?? 'scanned',
              firstSeenAt: existingRt.firstSeenAt, lastSeenAt: now,
              command: ag.command, args: ag.args ? JSON.stringify(ag.args) : undefined,
            });
            deps.db.agents.upsert({
              id: existingRt.id, name: sanitizedName, role: null,
              adapterKind: ag.adapterKind as AdapterKind,
              deviceId: a.deviceId, networkId: a.networkId,
              visibility: 'public' as const,
              category: (ag.category as AgentCategory) ?? 'executor-hosted',
              source: (ag.source as any) ?? 'scanned',
              firstSeenAt: existingRt.firstSeenAt, lastSeenAt: now,
              lastError: null, ownerId: null,
              command: ag.command, args: ag.args ? JSON.stringify(ag.args) : null,
              cwd: null, description: null,
            });
            registered.push({ id: existingRt.id, name: existingRt.name, category: existingRt.category, status: 'online' });

            // Also ensure agent is in DeviceRegistry for heartbeats + dispatch
            const dev = deps.deviceRegistry.get(a.deviceId);
            if (dev && !dev.agents.has(existingRt.id)) {
              dev.agents.set(existingRt.id, {
                id: existingRt.id,
                name: existingRt.name,
                role: existingRt.role,
                adapterKind: existingRt.adapterKind,
                category: existingRt.category,
                visibility: existingRt.visibility,
              });
            }
            continue;
          }

          // Generate stable ID from deviceId + agent name for dedup
          const agentId = `scan-${a.deviceId}-${sanitizedName.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
          const existing = deps.globalDb?.agents?.get(agentId);

          // Persist to global DB
          deps.globalDb?.agents?.upsert({
            id: agentId,
            name: sanitizedName,
            adapterKind: ag.adapterKind as AdapterKind,
            deviceId: a.deviceId,
            networkId: a.networkId,
            category: (ag.category as AgentCategory) ?? 'executor-hosted',
            source: (ag.source as any) ?? 'scanned',
            firstSeenAt: existing ? (existing as any).firstSeenAt ?? now : now,
            lastSeenAt: now,
            command: ag.command,
            args: ag.args ? JSON.stringify(ag.args) : undefined,
            description: null,
          });

          // Persist to per-network DB
          deps.db.agents.upsert({
            id: agentId,
            name: sanitizedName,
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
            description: null,
          });

          // Register in AgentRegistry (in-memory)
          const publishes = deps.globalDb?.agentPublishes?.listByAgent(agentId) ?? [];
          const rt = deps.registry.register(socket.id, {
            id: agentId,
            name: sanitizedName,
            role: '',
            adapterKind: ag.adapterKind as AdapterKind,
            category: (ag.category as AgentCategory) ?? 'executor-hosted',
            networkId: a.networkId,
            deviceId: a.deviceId,
            publishedNetworkIds: publishes.map((p: { networkId: string }) => p.networkId),
          });
          deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
          registered.push({ id: agentId, name: sanitizedName, category: ag.category, status: 'online' });

          // Also add to DeviceRegistry so heartbeats + dispatch can find this agent
          const dev = deps.deviceRegistry.get(a.deviceId);
          if (dev) {
            dev.agents.set(agentId, {
              id: agentId,
              name: sanitizedName,
              role: '',
              adapterKind: ag.adapterKind as AdapterKind,
              category: (ag.category as AgentCategory) ?? 'executor-hosted',
              visibility: 'public' as const,
            });
          }
        }

        // Mark agents missing from this scan as offline
        const scannedNames = new Set(agentPayload.map((ag) => normalizeAgentName(ag.name).toLowerCase()));
        for (const rt of deps.registry.all()) {
          if (rt.deviceId === a.deviceId && rt.status !== 'offline' && (rt.source === 'scanned' || rt.id.startsWith(`scan-${a.deviceId}-`))) {
            if (!scannedNames.has(rt.name.toLowerCase())) {
              const offRt = deps.registry.markOffline(rt.id, 'scan-missing');
              if (offRt) deps.io.of('/web').emit('agent:status', snapshotToDto(offRt));
              // Remove from DeviceRegistry agents map too
              const dev = deps.deviceRegistry.get(a.deviceId);
              if (dev) dev.agents.delete(rt.id);
            }
          }
        }

        ack?.({ ok: true, agents: registered });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:register-runtimes', (payload: {
      runtimes: { name: string; adapterKind: string; command: string; installed: boolean }[]
    }, ack?: (r: any) => void) => {
      try {
        const dev = deps.deviceRegistry.get(a.deviceId);
        if (dev) {
          dev.runtimes = payload.runtimes.map((rt) => ({
            ...rt,
            name: normalizeAgentName(rt.name),
          }));
          dev.lastSeenAt = Date.now();
          deps.io.of('/web').emit('device:status', {
            id: dev.id,
            userId: dev.userId,
            networkId: dev.networkId,
            agentIds: Array.from(dev.agents.keys()),
            runtimes: dev.runtimes,
            lastSeenAt: dev.lastSeenAt,
            status: dev.status,
          });
        }
        ack?.({ ok: true });
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

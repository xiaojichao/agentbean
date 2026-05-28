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
import { buildDaemonVersionInfo } from '../daemon-version.js';

export interface AgentNamespaceDeps {
  io: IOServer;
  db: Db;
  registry: AgentRegistry;
  deviceRegistry: DeviceRegistry;
  token: string;
  globalDb?: {
    users: { get(id: string): { id: string; username?: string | null } | null };
    networkMembers: { isMember(networkId: string, userId: string): boolean };
    networks: { get(id: string): { id: string; visibility: 'public' | 'private' } | null };
    agentPublishes: { listByAgent(agentId: string): { networkId: string }[] };
    agents?: {
      upsert(row: any): void;
      get(id: string): any;
      getFull(id: string): any;
      listAll(): any[];
    };
    devices?: {
      upsert(row: { id: string; userId: string; networkId: string; hostname?: string; lastSeenAt: number; systemInfo?: Record<string, unknown> | null }): void;
      get(id: string): { id: string; userId?: string | null; hostname?: string | null; connectCommand?: string | null; runtimes?: { name: string; adapterKind: string; command: string; installed: boolean }[] } | null;
      setConnectCommand(id: string, command: string): void;
      setRuntimes(id: string, runtimes: { name: string; adapterKind: string; command: string; installed: boolean }[]): void;
      touch(id: string, lastSeenAt: number): void;
      transferOwner(id: string, userId: string): void;
    };
  };
  dispatchTimeoutMs?: number;
  metricsCollector?: AgentMetricsCollector;
  onDeviceOnline?: (deviceId: string) => void;
  onDeviceOffline?: (deviceId: string, reason: string) => void;
}

export interface DispatchRequest {
  agentId: string;
  channelId: string;
  prompt: string;
  requestId: string;
  networkId?: string;
  teamId?: string;
  teamName?: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; speaker: string; body: string; at: number }>;
  attachments?: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    downloadUrl: string;
    previewUrl: string;
  }>;
}

interface DispatchCustomAgent {
  id: string;
  name: string;
  role?: string | null;
  adapterKind: AdapterKind;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  description?: string | null;
  category?: AgentCategory | string | null;
}

export interface DispatchResolution { ok: boolean; body?: string; error?: string; artifactIds?: string[]; }

export type DispatchFn = (req: DispatchRequest) => Promise<DispatchResolution>;
export type StopAgentsFn = (agentIds: string[], reason?: string) => { stopped: number };

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
  ownerName?: string | null;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  description?: string | null;
  deviceId?: string;
  deviceName?: string | null;
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
    env: rt.env ?? null,
    description: rt.description ?? null,
    deviceId: rt.deviceId,
    publishedNetworkIds: rt.publishedNetworkIds,
    source: rt.source,
  };
}

interface PendingDispatch {
  resolve: (result: DispatchResolution) => void;
  timer: NodeJS.Timeout;
  socketId: string;
  agentId: string;
}

export interface AgentNamespaceHandle {
  ns: Namespace;
  dispatch: DispatchFn;
  stopAgents: StopAgentsFn;
}

function isAgentOSHosted(meta: { category?: string | null }): boolean {
  return meta.category === 'agentos-hosted';
}

function extractTokenFromConnectCommand(command?: string | null): string | null {
  if (!command) return null;
  const match = command.match(/(?:^|\s)--token(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function parseArgs(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return null;
  if (typeof value !== 'string') return [String(value)];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [String(value)];
  } catch {
    return [String(value)];
  }
}

function customAgentRequiresSavedCommand(agent: DispatchCustomAgent): boolean {
  return agent.adapterKind !== 'claude-code';
}

function parseEnv(value: unknown): Record<string, string> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, string>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function customAgentToDto(agent: any, status: AgentSnapshotDto['status'], lastError?: string): AgentSnapshotDto {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role ?? 'executor-agent',
    adapterKind: agent.adapterKind,
    status,
    lastSeenAt: Date.now(),
    lastError,
    connectCommand: renderConnectCommand({ adapterKind: agent.adapterKind }),
    visibility: agent.visibility ?? 'public',
    category: agent.category ?? 'executor-hosted',
    networkId: agent.networkId,
    ownerId: agent.ownerId ?? null,
    command: agent.command ?? null,
    args: parseArgs(agent.args),
    cwd: agent.cwd ?? null,
    env: parseEnv(agent.env),
    description: agent.description ?? null,
    deviceId: agent.deviceId,
    source: 'custom',
  };
}

export function attachAgentNamespace(deps: AgentNamespaceDeps): AgentNamespaceHandle {
  const ns = deps.io.of('/agent');
  const pending = new Map<string, PendingDispatch>();
  const timeoutMs = deps.dispatchTimeoutMs ?? 960_000;

  const runtimeStatusDto = (rt: AgentRuntime): AgentSnapshotDto => {
    const dto = snapshotToDto(rt);
    const persisted = deps.globalDb?.agents?.getFull(rt.id);
    const publishedNetworkIds = new Set<string>(dto.publishedNetworkIds ?? []);
    for (const publish of deps.globalDb?.agentPublishes?.listByAgent(rt.id) ?? []) {
      publishedNetworkIds.add(publish.networkId);
    }
    const deviceId = persisted?.deviceId ?? dto.deviceId;
    const ownerId = persisted?.ownerId ?? dto.ownerId ?? (deviceId ? deps.globalDb?.devices?.get(deviceId)?.userId ?? null : null);
    const ownerName = ownerId ? deps.globalDb?.users?.get(ownerId)?.username ?? null : null;
    return {
      ...dto,
      networkId: persisted?.networkId ?? dto.networkId,
      visibility: persisted?.visibility ?? dto.visibility,
      category: persisted?.category ?? dto.category,
      source: persisted?.source ?? dto.source,
      ownerId,
      ownerName,
      command: persisted?.command ?? dto.command,
      args: parseArgs(persisted?.args ?? dto.args),
      cwd: persisted?.cwd ?? dto.cwd,
      description: persisted?.description ?? dto.description,
      deviceId,
      publishedNetworkIds: [...publishedNetworkIds],
    };
  };

  const emitCustomAgentStatus = (agentId: string, status: AgentSnapshotDto['status'], lastError?: string): boolean => {
    const persisted = deps.globalDb?.agents?.getFull(agentId);
    if (persisted?.source !== 'custom') return false;
    if (!deps.registry.snapshot(agentId)) {
      deps.registry.registerVirtual({
        id: persisted.id,
        name: persisted.name,
        role: persisted.role ?? 'executor-agent',
        adapterKind: persisted.adapterKind,
        category: persisted.category,
        networkId: persisted.networkId,
        visibility: persisted.visibility,
        ownerId: persisted.ownerId ?? null,
        command: persisted.command ?? null,
        args: parseArgs(persisted.args),
        cwd: persisted.cwd ?? null,
        description: persisted.description ?? null,
        deviceId: persisted.deviceId,
        publishedNetworkIds: deps.globalDb?.agentPublishes.listByAgent(agentId).map((p) => p.networkId) ?? [],
        source: 'custom',
      });
    }
    const rt = deps.registry.setStatus(agentId, status, lastError);
    deps.io.of('/web').emit('agent:status', rt ? runtimeStatusDto(rt) : customAgentToDto(persisted, status, lastError));
    return true;
  };

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
      capabilities?: { customAgentDispatch?: boolean; directoryPicker?: boolean };
      protocolVersion?: number;
      daemonVersion?: string;
    };
    const a = auth;
    logger.info({ deviceId: a.deviceId, sid: socket.id }, '/agent connected');

    const emitCurrentDeviceStatus = () => {
      const dev = deps.deviceRegistry.get(a.deviceId);
      if (!dev) return;
      const persisted = deps.globalDb?.devices?.get(a.deviceId);
      const ownerName = deps.globalDb?.users?.get(dev.userId)?.username ?? '未知用户';
      const daemonVersionInfo = buildDaemonVersionInfo(a.systemInfo ?? null);
      deps.io.of('/web').emit('device:status', {
        id: dev.id,
        userId: dev.userId,
        ownerName,
        userName: ownerName,
        networkId: dev.networkId,
        agentIds: Array.from(dev.agents.keys()),
        runtimes: dev.runtimes ?? persisted?.runtimes ?? [],
        lastSeenAt: dev.lastSeenAt,
        status: dev.status,
        hostname: persisted?.hostname,
        connectCommand: persisted?.connectCommand,
        systemInfo: a.systemInfo ?? null,
        daemonVersionInfo,
        latestDaemonVersion: daemonVersionInfo.latest,
        daemonUpdateAvailable: daemonVersionInfo.updateAvailable,
      });
    };

    socket.on('register', () => {
      // Only AgentOS-hosted agents are device-level members. Custom Agents are
      // persisted configs and are dispatched through their selected runtime.
      const now = Date.now();
      const parsed = parseToken(a.token!);
      const tokenUserId = parsed?.userId ?? 'system';
      const existingDevice = deps.globalDb?.devices?.get(a.deviceId);
      const connectCommandToken = extractTokenFromConnectCommand(existingDevice?.connectCommand);
      const connectCommandUserId = connectCommandToken ? parseToken(connectCommandToken)?.userId : null;
      const tokenOwnerId = parsed?.userId && deps.globalDb?.users?.get(parsed.userId) ? parsed.userId : null;
      const userId = connectCommandUserId && deps.globalDb?.users?.get(connectCommandUserId)
        ? connectCommandUserId
        : tokenOwnerId ?? existingDevice?.userId ?? tokenUserId;
      if (existingDevice?.userId && existingDevice.userId !== userId) {
        deps.globalDb?.devices?.transferOwner(a.deviceId, userId);
        logger.info({ deviceId: a.deviceId, fromUserId: existingDevice.userId, toUserId: userId }, 'device owner repaired during daemon registration');
      }
      const deviceAgents = (a.agents ?? []).filter(isAgentOSHosted);
      for (const agentMeta of deviceAgents) {
        const persistedAgent = deps.globalDb?.agents?.getFull(agentMeta.id);
        const displayName = normalizeAgentName(persistedAgent?.name ?? agentMeta.name);
        const publishes = deps.globalDb?.agentPublishes?.listByAgent(agentMeta.id) ?? [];
        const publishedNetworkIds = publishes.map((p: { networkId: string }) => p.networkId);
        const rt = deps.registry.register(socket.id, {
          id: agentMeta.id,
          name: displayName,
          role: agentMeta.role,
          adapterKind: agentMeta.adapterKind as AdapterKind,
          category: (agentMeta.category as AgentCategory) ?? 'executor-hosted',
          networkId: a.networkId,
          visibility: agentMeta.visibility,
          ownerId: agentMeta.ownerId ?? userId,
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
          ownerId: rt.ownerId ?? userId,
          command: rt.command ?? null,
          args: rt.args ? JSON.stringify(rt.args) : null,
          cwd: rt.cwd ?? null,
          description: rt.description ?? null,
        });
        deps.io.of('/web').emit('agent:status', runtimeStatusDto(rt));
      }

      // Persist device to global DB
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
        agents: new Map(deviceAgents.map((ag) => {
          const persisted = deps.globalDb?.agents?.getFull(ag.id);
          return [ag.id, { ...ag, name: normalizeAgentName(persisted?.name ?? ag.name) }];
        })),
        capabilities: a.capabilities,
        protocolVersion: typeof a.protocolVersion === 'number' ? a.protocolVersion : undefined,
        daemonVersion: typeof a.daemonVersion === 'string' ? a.daemonVersion : typeof a.systemInfo?.daemonVersion === 'string' ? a.systemInfo.daemonVersion : null,
        systemInfo: a.systemInfo ?? null,
        lastSeenAt: now,
        status: 'online',
      });
      emitCurrentDeviceStatus();
      deps.onDeviceOnline?.(a.deviceId);
    });

    socket.on('heartbeat', () => {
      const device = deps.deviceRegistry.heartbeat(a.deviceId);
      if (device) {
        deps.globalDb?.devices?.touch(a.deviceId, device.lastSeenAt);
        for (const agentMeta of device.agents.values()) {
          const rt = deps.registry.heartbeat(agentMeta.id);
          if (rt) deps.io.of('/web').emit('agent:status', runtimeStatusDto(rt));
        }
      }
    });

    socket.on('reply', (payload: { agentId?: string; channelId: string; body: string; requestId: string; artifactIds?: string[] }) => {
      const p = pending.get(payload.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(payload.requestId);
      p.resolve({ ok: true, body: payload.body, artifactIds: payload.artifactIds });
      deps.metricsCollector?.resolve(payload.requestId, true);
      const agentId = p.agentId;
      const rt = deps.registry.markOnline(agentId);
      if (rt) deps.io.of('/web').emit('agent:status', runtimeStatusDto(rt));
      else emitCustomAgentStatus(agentId, 'online');
    });

    socket.on('error_event', (payload: { agentId: string; at?: number; message?: string; scope?: string; requestId?: string }) => {
      const message = payload.message?.trim() || 'agent reported an error without details';
      let resolvedRequest = false;
      let agentId = payload.agentId;
      if (payload?.requestId && pending.has(payload.requestId)) {
        const p = pending.get(payload.requestId)!;
        clearTimeout(p.timer);
        pending.delete(payload.requestId);
        p.resolve({ ok: false, error: message });
        deps.metricsCollector?.resolve(payload.requestId, false, message);
        agentId = p.agentId;
        resolvedRequest = true;
      }
      const rt = resolvedRequest ? deps.registry.markOnline(agentId) : deps.registry.markError(agentId, message);
      if (rt) {
        const dto = runtimeStatusDto(rt);
        deps.io.of('/web').emit('agent:status', resolvedRequest ? { ...dto, lastError: message } : dto);
      } else {
        emitCustomAgentStatus(agentId, resolvedRequest ? 'online' : 'error', message);
      }
    });

    socket.on('agents:discovered', (payload: { agents: any[] }) => {
      deps.io.of('/web').emit('agents:discovered', payload);
    });

    // Daemon registers scanned agents (runtimes, agentOS, standalone)
    socket.on('device:register-agents', (payload: {
      agents: { name: string; category: string; adapterKind: string; command: string; args: string[]; cwd?: string | null; source?: string }[]
    }, ack?: (r: any) => void) => {
      try {
        const now = Date.now();
        const registered: any[] = [];
        const agentPayload = payload.agents.filter(isAgentOSHosted);
        const ownerId = deps.globalDb?.devices?.get(a.deviceId)?.userId ?? parseToken(a.token!)?.userId ?? null;
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
              ownerId: ownerId ?? undefined,
              command: ag.command, args: ag.args ? JSON.stringify(ag.args) : undefined,
              cwd: ag.cwd ?? null,
            });
            deps.db.agents.upsert({
              id: existingRt.id, name: sanitizedName, role: null,
              adapterKind: ag.adapterKind as AdapterKind,
              deviceId: a.deviceId, networkId: a.networkId,
              visibility: 'public' as const,
              category: (ag.category as AgentCategory) ?? 'executor-hosted',
              source: (ag.source as any) ?? 'scanned',
              firstSeenAt: existingRt.firstSeenAt, lastSeenAt: now,
              lastError: null, ownerId,
              command: ag.command, args: ag.args ? JSON.stringify(ag.args) : null,
              cwd: ag.cwd ?? null, description: null,
            });
            const publishes = deps.globalDb?.agentPublishes?.listByAgent(existingRt.id) ?? [];
            const rt = deps.registry.register(socket.id, {
              id: existingRt.id,
              name: sanitizedName,
              role: existingRt.role,
              adapterKind: ag.adapterKind as AdapterKind,
              category: (ag.category as AgentCategory) ?? existingRt.category ?? 'executor-hosted',
              networkId: a.networkId,
              visibility: existingRt.visibility,
              ownerId: ownerId ?? existingRt.ownerId ?? null,
              command: ag.command,
              args: ag.args ?? [],
              cwd: ag.cwd ?? null,
              description: existingRt.description ?? null,
              deviceId: a.deviceId,
              publishedNetworkIds: publishes.map((p: { networkId: string }) => p.networkId),
              source: (ag.source as any) ?? existingRt.source ?? 'scanned',
            });
            deps.io.of('/web').emit('agent:status', runtimeStatusDto(rt));
            registered.push({ id: rt.id, name: rt.name, category: rt.category, status: 'online' });

            // Also ensure agent is in DeviceRegistry for heartbeats + dispatch
            const dev = deps.deviceRegistry.get(a.deviceId);
            if (dev) {
              dev.agents.set(rt.id, {
                id: rt.id,
                name: rt.name,
                role: rt.role,
                adapterKind: rt.adapterKind,
                category: rt.category,
                visibility: rt.visibility,
              });
            }
            continue;
          }

          // Generate stable ID from deviceId + agent name for dedup
          const agentId = `scan-${a.deviceId}-${sanitizedName.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
          const existing = deps.globalDb?.agents?.getFull(agentId);
          const displayName = normalizeAgentName(existing?.name ?? sanitizedName);

          // Persist to global DB
          deps.globalDb?.agents?.upsert({
            id: agentId,
            name: displayName,
            adapterKind: ag.adapterKind as AdapterKind,
            deviceId: a.deviceId,
            networkId: a.networkId,
            category: (ag.category as AgentCategory) ?? 'executor-hosted',
            source: (ag.source as any) ?? 'scanned',
            firstSeenAt: existing ? (existing as any).firstSeenAt ?? now : now,
            lastSeenAt: now,
            ownerId: ownerId ?? undefined,
            command: ag.command,
            args: ag.args ? JSON.stringify(ag.args) : undefined,
            cwd: ag.cwd ?? null,
            description: null,
          });

          // Persist to per-network DB
          deps.db.agents.upsert({
            id: agentId,
            name: displayName,
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
            ownerId,
            command: ag.command,
            args: ag.args ? JSON.stringify(ag.args) : null,
            cwd: ag.cwd ?? null,
            description: null,
          });

          // Register in AgentRegistry (in-memory)
          const publishes = deps.globalDb?.agentPublishes?.listByAgent(agentId) ?? [];
          const rt = deps.registry.register(socket.id, {
            id: agentId,
            name: displayName,
            role: '',
            adapterKind: ag.adapterKind as AdapterKind,
            category: (ag.category as AgentCategory) ?? 'executor-hosted',
            networkId: a.networkId,
            deviceId: a.deviceId,
            ownerId,
            command: ag.command,
            args: ag.args ?? [],
            cwd: ag.cwd ?? null,
            publishedNetworkIds: publishes.map((p: { networkId: string }) => p.networkId),
            source: (ag.source as any) ?? 'scanned',
          });
          deps.io.of('/web').emit('agent:status', runtimeStatusDto(rt));
          registered.push({ id: agentId, name: displayName, category: ag.category, status: 'online' });

          // Also add to DeviceRegistry so heartbeats + dispatch can find this agent
          const dev = deps.deviceRegistry.get(a.deviceId);
          if (dev) {
            dev.agents.set(agentId, {
              id: agentId,
              name: displayName,
              role: '',
              adapterKind: ag.adapterKind as AdapterKind,
              category: (ag.category as AgentCategory) ?? 'executor-hosted',
              visibility: 'public' as const,
            });
          }
        }

        // Mark agents missing from this scan as offline
        const scannedAgentIds = new Set(registered.map((ag) => ag.id));
        for (const ag of agentPayload) {
          const name = normalizeAgentName(ag.name);
          scannedAgentIds.add(`scan-${a.deviceId}-${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`);
        }
        for (const rt of deps.registry.all()) {
          if (rt.deviceId === a.deviceId && rt.status !== 'offline' && (rt.source === 'scanned' || rt.id.startsWith(`scan-${a.deviceId}-`))) {
            if (!scannedAgentIds.has(rt.id)) {
              const offRt = deps.registry.markOffline(rt.id, 'scan-missing');
              if (offRt) deps.io.of('/web').emit('agent:status', runtimeStatusDto(offRt));
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
        const normalizedRuntimes = payload.runtimes.map((rt) => ({
          ...rt,
          name: rt.name.trim(),
        }));
        deps.globalDb?.devices?.setRuntimes(a.deviceId, normalizedRuntimes);
        if (dev) {
          dev.runtimes = normalizedRuntimes;
          dev.lastSeenAt = Date.now();
          dev.status = 'online';
          emitCurrentDeviceStatus();
          deps.onDeviceOnline?.(a.deviceId);
        }
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('disconnect', () => {
      for (const [reqId, p] of pending.entries()) {
        if (p.socketId !== socket.id) continue;
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'agent disconnected' });
        deps.metricsCollector?.resolve(reqId, false, 'agent disconnected');
        pending.delete(reqId);
      }

      const currentDevice = deps.deviceRegistry.get(a.deviceId);
      if (currentDevice && currentDevice.socket.id !== socket.id) return;
      deps.onDeviceOffline?.(a.deviceId, 'device-disconnect');
    });
  });

  const dispatch: DispatchFn = (req) => new Promise<DispatchResolution>((resolve) => {
    // Custom Agents are persisted configs that run through a device runtime.
    // Resolve them first so stale/legacy daemon registrations cannot make the
    // server dispatch them as normal device-level agents.
    const persisted = deps.globalDb?.agents?.getFull(req.agentId);
    let customAgent: DispatchCustomAgent | undefined;
    let device = undefined as ReturnType<DeviceRegistry['getAgentDevice']>;
    if (persisted?.source === 'custom' && persisted.deviceId) {
      device = deps.deviceRegistry.get(persisted.deviceId);
      customAgent = {
        id: persisted.id,
        name: persisted.name,
        role: persisted.role,
        adapterKind: persisted.adapterKind,
        command: persisted.command,
        args: parseArgs(persisted.args),
        cwd: persisted.cwd,
        env: parseEnv(persisted.env),
        description: persisted.description,
        category: persisted.category,
      };
    } else {
      device = deps.deviceRegistry.getAgentDevice(req.agentId);
    }
    if (!device || device.status === 'offline') {
      resolve({ ok: false, error: `${req.agentId} 不在线` });
      return;
    }
    if (customAgent && customAgentRequiresSavedCommand(customAgent) && !customAgent.command?.trim()) {
      resolve({ ok: false, error: `${customAgent.name} 未配置运行时命令` });
      return;
    }
    if (customAgent && !device.capabilities?.customAgentDispatch) {
      resolve({ ok: false, error: `${customAgent.name} 所在设备上的 AgentBean Daemon 版本过旧，请重启本地新版 daemon` });
      return;
    }
    const sock = ns.sockets.get(device.socket.id);
    if (!sock) {
      resolve({ ok: false, error: `${req.agentId} socket 不可达` });
      return;
    }
    const busyRt = deps.registry.markBusy(req.agentId);
    if (busyRt) {
      deps.io.of('/web').emit('agent:status', runtimeStatusDto(busyRt));
    } else if (customAgent) {
      emitCustomAgentStatus(req.agentId, 'busy');
    }
    deps.metricsCollector?.start(req.agentId, req.requestId);

    const timer = setTimeout(() => {
      pending.delete(req.requestId);
      resolve({ ok: false, error: `超时 (${timeoutMs / 1000}s)` });
      deps.metricsCollector?.resolve(req.requestId, false, `超时 (${timeoutMs / 1000}s)`);
      const onlineRt = deps.registry.markOnline(req.agentId);
      if (onlineRt) deps.io.of('/web').emit('agent:status', runtimeStatusDto(onlineRt));
      else emitCustomAgentStatus(req.agentId, 'online', `超时 (${timeoutMs / 1000}s)`);
    }, timeoutMs);
    pending.set(req.requestId, { resolve, timer, socketId: sock.id, agentId: req.agentId });

    const agentRuntime = deps.registry.snapshot(req.agentId);
    const sandboxed = agentRuntime?.visibility === 'public' && agentRuntime.category !== 'agentos-hosted' && !customAgent;
    const teamId = req.teamId ?? req.networkId ?? 'default';
    const teamName = req.teamName ?? teamId;
    sock.emit('dispatch', { ...req, networkId: req.networkId, teamId, teamName, sandboxed, customAgent });
  });

  const stopAgents: StopAgentsFn = (agentIds, reason = '已停止') => {
    const targets = new Set(agentIds.filter(Boolean));
    if (targets.size === 0) return { stopped: 0 };
    let stopped = 0;
    for (const [requestId, p] of [...pending.entries()]) {
      if (!targets.has(p.agentId)) continue;
      clearTimeout(p.timer);
      pending.delete(requestId);
      stopped += 1;
      p.resolve({ ok: false, error: reason });
      deps.metricsCollector?.resolve(requestId, false, reason);
      const rt = deps.registry.markOnline(p.agentId);
      if (rt) deps.io.of('/web').emit('agent:status', runtimeStatusDto(rt));
      else emitCustomAgentStatus(p.agentId, 'online');
      ns.sockets.get(p.socketId)?.emit('dispatch:cancel', { requestId, agentId: p.agentId, reason });
    }
    return { stopped };
  };

  return { ns, dispatch, stopAgents };
}

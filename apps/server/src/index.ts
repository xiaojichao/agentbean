import express from 'express';
import http from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import multer from 'multer';
import { Server as IOServer } from 'socket.io';
import { logger } from './log.js';
import { openDb, initGlobalDb, type Db, type GlobalDb, type InviteRow } from './db.js';
import { AgentRegistry, type AgentRuntime } from './registry.js';
import { DeviceRegistry } from './device-registry.js';
import { StorageManager } from './storage.js';
import { attachAgentNamespace, snapshotToDto, type DispatchFn } from './namespaces/agent.js';
import { AgentMetricsCollector } from './agent-metrics.js';
import { renderConnectCommand } from './connect-command.js';
import { startDeviceHeartbeatScanner, startHeartbeatScanner } from './heartbeat-scanner.js';
import { ChannelService } from './channels.js';
import { runIntros } from './intro.js';
import { routeHumanMessage } from './routing.js';
import { attachArtifactRoutes } from './artifact-routes.js';
import { newId } from './ids.js';
import { generateToken, parseToken, verifyUserToken } from './auth.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateInviteCode } from './invite.js';
import { buildDaemonVersionInfo } from './daemon-version.js';

export interface AppOptions { port?: number; dbPath?: string; globalDbPath?: string; agentToken?: string }
export interface AppHandle {
  http: http.Server;
  io: IOServer;
  db: Db;
  globalDb: GlobalDb;
  registry: AgentRegistry;
  channels: ChannelService;
  dispatch: DispatchFn;
  close: () => Promise<void>;
}

function buildInviteCommand(code: string, serverUrl: string): string {
  const template = process.env.AGENT_BEAN_INVITE_COMMAND_TEMPLATE;
  if (template) {
    return template
      .replaceAll('{code}', code)
      .replaceAll('{serverUrl}', serverUrl);
  }

  const localAgentEntrypoint = resolve(process.cwd(), '../daemon/src/bin.ts');
  if (existsSync(localAgentEntrypoint)) {
    return `npx --yes tsx ${localAgentEntrypoint} --invite ${code} --server-url ${serverUrl}`;
  }

  return `npx @agentbean/daemon@latest --invite ${code} --server-url ${serverUrl}`;
}

function normalizeEnv(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error('INVALID_ENV_KEY');
    }
    out[key] = String(rawValue ?? '');
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseEnvJson(input?: string | null): Record<string, string> | undefined {
  if (!input) return undefined;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validateUserJoinInvite(globalDb: GlobalDb, code: string): { ok: true; invite: InviteRow } | { ok: false; error: string } {
  const invite = globalDb.invites.getByCode(code);
  if (!invite || invite.purpose !== 'user') return { ok: false, error: 'INVALID_CODE' };
  if (invite.usedAt) return { ok: false, error: 'ALREADY_USED' };
  if (invite.expiresAt && invite.expiresAt < Date.now()) return { ok: false, error: 'EXPIRED' };
  if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) return { ok: false, error: 'MAX_USES_REACHED' };
  if (invite.networkId && !globalDb.networks.get(invite.networkId)) return { ok: false, error: 'NETWORK_NOT_FOUND' };
  return { ok: true, invite };
}

function consumeJoinInvite(globalDb: GlobalDb, invite: InviteRow): void {
  globalDb.invites.incrementUses(invite.code);
  const updated = globalDb.invites.getByCode(invite.code);
  if (updated && updated.maxUses !== null && updated.usesCount >= updated.maxUses) {
    globalDb.invites.markUsed(invite.code);
  }
}

function isTeamAgent(agent: { category?: string | null; source?: string | null }): boolean {
  return agent.category === 'agentos-hosted' || agent.source === 'custom';
}

function normalizeKind(kind?: string | null): string {
  const normalized = (kind ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'kimi-cli' || normalized === 'kimi') return 'kimi-cli';
  if (normalized === 'claude' || normalized === 'claude-code') return 'claude-code';
  if (normalized === 'codex' || normalized === 'codex-cli') return 'codex';
  return normalized;
}

function runtimeMatchesAgent(runtime: { adapterKind?: string | null; command?: string | null; installed?: boolean }, agent: { adapterKind?: string | null; command?: string | null }): boolean {
  if (!runtime.installed) return false;
  const runtimeCommand = runtime.command?.trim();
  const agentCommand = agent.command?.trim();
  if (runtimeCommand && agentCommand && runtimeCommand === agentCommand) return true;
  const runtimeKind = normalizeKind(runtime.adapterKind);
  const agentKind = normalizeKind(agent.adapterKind);
  if (!runtimeKind || !agentKind) return false;
  if (runtimeKind === agentKind) return true;
  return runtimeKind === 'kimi-cli' && agentKind === 'codex' && Boolean(agentCommand?.includes('kimi-cli'));
}

function isOnlineStatus(status?: string | null): boolean {
  return status === 'online' || status === 'busy';
}

function isVirtualDeviceId(id?: string | null): boolean {
  return Boolean(id?.startsWith('virtual-'));
}

function hasConfiguredProjectDirectory(cwd?: string | null): boolean {
  return Boolean(cwd?.trim());
}

type CorsOrigin = string | string[] | false;

function parseOriginList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function resolveCorsOrigin(): CorsOrigin {
  const configured = parseOriginList(process.env.CORS_ORIGIN);
  if (configured.length > 0) return configured.length === 1 ? configured[0]! : configured;

  const webOrigins = parseOriginList(process.env.WEB_URL);
  if (webOrigins.length > 0) return webOrigins.length === 1 ? webOrigins[0]! : webOrigins;

  return process.env.NODE_ENV === 'production' ? false : 'http://localhost:3100';
}

function resolveRequestCorsOrigin(origin: CorsOrigin, requestOrigin?: string): string | undefined {
  if (!origin) return undefined;
  if (origin === '*') return '*';
  if (Array.isArray(origin)) {
    if (origin.includes('*')) return '*';
    return requestOrigin && origin.includes(requestOrigin) ? requestOrigin : undefined;
  }
  return origin;
}

function attachRestCors(app: express.Express, origin: CorsOrigin): void {
  app.use((req, res, next) => {
    const allowedOrigin = resolveRequestCorsOrigin(origin, req.headers.origin);
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
}

function isRecentlySeen(lastSeenAt?: number | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt < 45_000;
}

// Fixed data directory relative to this source file (not cwd)
const DATA_DIR = resolve(import.meta.dirname, '../data');

export async function buildApp(opts: AppOptions = {}): Promise<AppHandle> {
  const dbPath = opts.dbPath ?? process.env.DATABASE_PATH ?? resolve(DATA_DIR, 'agentbean.db');
  const token = opts.agentToken ?? process.env.AGENT_BEAN_AGENT_TOKEN;
  if (!token) throw new Error('AGENT_BEAN_AGENT_TOKEN is required');
  const artifactDir = resolve(process.env.ARTIFACT_DIR ?? resolve(DATA_DIR, 'artifacts'));

  const db = openDb(dbPath);
  const globalDbPath = opts.globalDbPath ?? process.env.GLOBAL_DB_PATH ?? resolve(DATA_DIR, 'global.db');
  const globalDb = initGlobalDb(globalDbPath);
  const registry = new AgentRegistry();
  const deviceRegistry = new DeviceRegistry();
  const storageManager = new StorageManager(process.env.STORAGE_BASE_DIR ?? resolve(DATA_DIR, 'storage'));
  const defaultNetworkId = 'default';
  storageManager.createSpace(defaultNetworkId);
  const space = storageManager.getSpace(defaultNetworkId);

  const resolveCustomAgentStatus = (agent: { id: string; source?: string | null; adapterKind?: string | null; command?: string | null; cwd?: string | null; deviceId?: string | null; networkId?: string | null }) => {
    const rt = registry.snapshot(agent.id);
    if (agent.source !== 'custom') {
      return {
        status: rt?.status ?? 'offline',
        lastSeenAt: rt?.lastHeartbeatAt,
        lastError: rt?.lastError?.message,
      };
    }

    if (rt?.status === 'busy' || rt?.status === 'error' || rt?.status === 'connecting') {
      return {
        status: rt.status,
        lastSeenAt: rt.lastHeartbeatAt,
        lastError: rt.lastError?.message,
      };
    }

    if (!hasConfiguredProjectDirectory(agent.cwd)) {
      return { status: 'offline' as const, lastSeenAt: rt?.lastHeartbeatAt, lastError: undefined };
    }

    const liveDevice = agent.deviceId ? deviceRegistry.get(agent.deviceId) : undefined;
    const liveCandidates = liveDevice
      ? [liveDevice]
      : agent.deviceId?.startsWith('virtual-')
        ? deviceRegistry.all()
        : [];
    const candidateDevices = [
      ...liveCandidates.map((device) => ({
        lastSeenAt: device.lastSeenAt,
        status: device.status,
        runtimes: device.runtimes ?? [],
      })),
    ];
    for (const device of candidateDevices) {
      if (!device || !isOnlineStatus(device.status)) continue;
      const hasRuntime = (device.runtimes ?? []).some((runtime) => runtimeMatchesAgent(runtime, agent));
      if (hasRuntime) {
        return { status: 'online' as const, lastSeenAt: device.lastSeenAt, lastError: undefined };
      }
    }
    return {
      status: rt?.status ?? 'offline',
      lastSeenAt: rt?.lastHeartbeatAt,
      lastError: rt?.lastError?.message,
    };
  };

  const resolveAgentStatus = (agent: { id: string; source?: string | null; adapterKind?: string | null; command?: string | null; cwd?: string | null; deviceId?: string | null; networkId?: string | null }, fallbackLastSeenAt?: number | null, fallbackLastError?: string | null) => {
    if (agent.source === 'custom') {
      const resolved = resolveCustomAgentStatus(agent);
      return {
        status: resolved.status,
        lastSeenAt: resolved.lastSeenAt ?? fallbackLastSeenAt,
        lastError: resolved.lastError ?? fallbackLastError ?? undefined,
      };
    }
    const rt = registry.snapshot(agent.id);
    return {
      status: rt?.status ?? 'offline',
      lastSeenAt: rt?.lastHeartbeatAt ?? fallbackLastSeenAt,
      lastError: rt?.lastError?.message ?? fallbackLastError ?? undefined,
    };
  };

  const emitCustomAgentStatusesForDevice = (deviceId: string) => {
    for (const agent of globalDb.agents.listByDevice(deviceId)) {
      if (agent.source !== 'custom') continue;
      const resolved = resolveCustomAgentStatus(agent);
      io.of('/web').emit('agent:status', persistedAgentStatusDto(
        agent,
        resolved.status,
        resolved.lastSeenAt ?? agent.lastSeenAt,
        resolved.lastError,
      ));
    }
  };

  const resolveOwnerName = (ownerId?: string | null) => {
    if (!ownerId) return null;
    return globalDb.users.get(ownerId)?.username ?? null;
  };

  const resolveAgentOwnerId = (agent: { ownerId?: string | null; deviceId?: string | null }) => {
    if (agent.ownerId) return agent.ownerId;
    if (!agent.deviceId) return null;
    return globalDb.devices.get(agent.deviceId)?.userId ?? null;
  };

  const enrichAgentOwnership = <T extends { ownerId?: string | null; ownerName?: string | null; deviceId?: string | null; deviceName?: string | null }>(agent: T): T => {
    const ownerId = resolveAgentOwnerId(agent);
    return {
      ...agent,
      ownerId,
      ownerName: resolveOwnerName(ownerId),
      deviceName: agent.deviceName ?? resolveDeviceName(agent.deviceId),
    };
  };

  const runtimeAgentStatusDto = (rt: AgentRuntime) =>
    enrichAgentOwnership(snapshotToDto(rt));

  const canManageDeviceRow = (
    device: { userId?: string | null } | null | undefined,
    userId?: string | null,
  ) => Boolean(userId && device && (device.userId === userId || globalDb.users.get(userId)?.role === 'admin'));

  const resolveDeviceName = (deviceId?: string | null) => {
    if (!deviceId) return null;
    const live = deviceRegistry.get(deviceId);
    const persisted = globalDb.devices.get(deviceId);
    const systemName = persisted?.systemInfo && typeof persisted.systemInfo.hostname === 'string' ? persisted.systemInfo.hostname : null;
    return persisted?.hostname ?? systemName ?? live?.id ?? null;
  };

  const buildVisibleAgentDtos = (networkId: string) => {
    const registryAgents = registry.all().filter((a) =>
      isTeamAgent(a) &&
      (a.networkId === networkId || a.publishedNetworkIds.includes(networkId))
    ).map((agent) => {
      const dto = snapshotToDto(agent);
      if (agent.source !== 'custom') return enrichAgentOwnership(dto);
      const resolved = resolveCustomAgentStatus(agent);
      return enrichAgentOwnership({
        ...dto,
        status: resolved.status,
        lastSeenAt: resolved.lastSeenAt ?? dto.lastSeenAt,
        lastError: resolved.lastError,
      });
    });
    const seen = new Set(registryAgents.map((agent) => agent.id));
    const persistedAgents = globalDb.agents.listVisibleInNetwork(networkId)
      .filter(isTeamAgent)
      .filter((agent) => !seen.has(agent.id))
      .map((agent) => {
        let parsedArgs: string[] | null = null;
        if (agent.args) {
          try { parsedArgs = JSON.parse(agent.args); } catch { parsedArgs = [agent.args]; }
        }
        const resolved = resolveCustomAgentStatus(agent);
        return enrichAgentOwnership({
          id: agent.id,
          name: agent.name,
          role: agent.role ?? '',
          adapterKind: agent.adapterKind,
          category: agent.category,
          source: agent.source,
          command: agent.command,
          args: parsedArgs,
          cwd: agent.cwd,
          env: parseEnvJson(agent.env),
          deviceId: agent.deviceId ?? undefined,
          networkId: agent.networkId,
          visibility: agent.visibility,
          ownerId: agent.ownerId,
          description: agent.description,
          status: resolved.status,
          lastSeenAt: resolved.lastSeenAt ?? agent.lastSeenAt,
          lastError: resolved.lastError ?? agent.lastError ?? undefined,
          publishedNetworkIds: globalDb.agentPublishes.listByAgent(agent.id).map((p) => p.networkId),
          connectCommand: renderConnectCommand({ adapterKind: agent.adapterKind as any }),
        });
      });
    return [...registryAgents, ...persistedAgents];
  };

  function deviceDisplayName(device: ReturnType<GlobalDb['devices']['listByUser']>[number]): string {
    const systemName = typeof device.systemInfo?.hostname === 'string' ? device.systemInfo.hostname : '';
    return (device.hostname ?? systemName ?? '').trim() || device.id;
  }

  function compareDeviceRows(
    a: ReturnType<GlobalDb['devices']['listByUser']>[number],
    b: ReturnType<GlobalDb['devices']['listByUser']>[number],
  ): number {
    return deviceDisplayName(a).localeCompare(deviceDisplayName(b), 'zh-CN', { sensitivity: 'base', numeric: true }) ||
      a.networkId.localeCompare(b.networkId, 'zh-CN', { sensitivity: 'base', numeric: true }) ||
      a.id.localeCompare(b.id);
  }

  const visibleDeviceRows = (rows: ReturnType<GlobalDb['devices']['listByUser']>) =>
    rows.filter((device) => !isVirtualDeviceId(device.id)).sort(compareDeviceRows);

  const toDeviceDto = (dbd: ReturnType<GlobalDb['devices']['listByUser']>[number], viewerId?: string | null) => {
    const live = deviceRegistry.get(dbd.id);
    const systemInfo = dbd.systemInfo;
    const daemonVersionInfo = buildDaemonVersionInfo(systemInfo);
    const ownerName = resolveOwnerName(dbd.userId) ?? '未知用户';
    return {
      id: dbd.id,
      userId: dbd.userId,
      ownerName,
      userName: ownerName,
      networkId: dbd.networkId,
      hostname: dbd.hostname,
      agentIds: live ? Array.from(live.agents.keys()) : [],
      runtimes: live?.runtimes ?? dbd.runtimes,
      lastSeenAt: live ? live.lastSeenAt : dbd.lastSeenAt,
      status: live ? live.status : 'offline',
      connectCommand: dbd.connectCommand,
      systemInfo,
      daemonVersionInfo,
      latestDaemonVersion: daemonVersionInfo.latest,
      daemonUpdateAvailable: daemonVersionInfo.updateAvailable,
      canManage: canManageDeviceRow(dbd, viewerId),
    };
  };

  const devicesForNetwork = (networkId: string, viewerId?: string | null) => {
    const rowsById = new Map<string, ReturnType<GlobalDb['devices']['listByUser']>[number]>();
    for (const device of globalDb.devices.listByNetwork(networkId)) {
      rowsById.set(device.id, device);
    }
    for (const agent of buildVisibleAgentDtos(networkId)) {
      if (!agent.deviceId) continue;
      const device = globalDb.devices.get(agent.deviceId);
      if (device) rowsById.set(device.id, device);
    }
    return visibleDeviceRows([...rowsById.values()]).map((device) => toDeviceDto(device, viewerId));
  };

  const parsePersistedArgs = (args?: string[] | string | null) => {
    if (Array.isArray(args)) return args;
    if (!args) return null;
    try {
      const parsed = JSON.parse(args);
      return Array.isArray(parsed) ? parsed.map(String) : [args];
    } catch {
      return [args];
    }
  };

  const persistedAgentStatusDto = (
    agent: ReturnType<GlobalDb['agents']['listAll']>[number],
    status: 'connecting' | 'online' | 'busy' | 'offline' | 'error',
    lastSeenAt = Date.now(),
    lastError?: string,
  ) => enrichAgentOwnership({
    id: agent.id,
    name: agent.name,
    role: agent.role ?? '',
    adapterKind: agent.adapterKind,
    category: agent.category,
    source: agent.source,
    command: agent.command,
    args: parsePersistedArgs(agent.args),
    cwd: agent.cwd,
    env: parseEnvJson(agent.env),
    deviceId: agent.deviceId ?? undefined,
    networkId: agent.networkId,
    visibility: agent.visibility,
    ownerId: agent.ownerId,
    description: agent.description,
    status,
    lastSeenAt,
    lastError,
    publishedNetworkIds: globalDb.agentPublishes.listByAgent(agent.id).map((p) => p.networkId),
    connectCommand: renderConnectCommand({ adapterKind: agent.adapterKind as any }),
  });

  const markDeviceAndAgentsOffline = (deviceId: string, reason: string) => {
    const device = deviceRegistry.markOffline(deviceId);
    const persistedDevice = globalDb.devices.get(deviceId);
    const networkId = device?.networkId ?? persistedDevice?.networkId;

    if (persistedDevice) {
      io.of('/web').emit('device:status', toDeviceDto(persistedDevice));
    } else if (device) {
      io.of('/web').emit('device:status', {
        id: device.id,
        userId: device.userId,
        ownerName: resolveOwnerName(device.userId) ?? '未知用户',
        userName: resolveOwnerName(device.userId) ?? '未知用户',
        networkId: device.networkId,
        hostname: undefined,
        agentIds: Array.from(device.agents.keys()),
        runtimes: device.runtimes ?? [],
        lastSeenAt: device.lastSeenAt,
        status: 'offline',
        canManage: false,
      });
    }

    const offlineAgentIds = new Set<string>();
    for (const rt of registry.all()) {
      if (rt.deviceId !== deviceId || rt.status === 'offline') continue;
      const offRt = registry.markOffline(rt.id, reason);
      if (offRt) {
        offlineAgentIds.add(offRt.id);
        io.of('/web').emit('agent:status', runtimeAgentStatusDto(offRt));
      }
    }

    for (const agent of globalDb.agents.listAll()) {
      if (agent.deviceId !== deviceId || agent.source !== 'custom' || offlineAgentIds.has(agent.id)) continue;
      io.of('/web').emit('agent:status', persistedAgentStatusDto(agent, 'offline', Date.now()));
    }

    if (networkId) {
      emitDevicesSnapshotForNetwork(networkId);
    }
  };

  // Ensure system user exists for foreign key constraints
  try {
    globalDb.raw.prepare(`INSERT OR IGNORE INTO users (id, username, email, created_at, updated_at) VALUES (?, ?, null, ?, ?)`)
      .run('system', 'system', Date.now(), Date.now());
  } catch {}

  // Ensure 'default' user exists for legacy token compatibility
  try {
    globalDb.raw.prepare(`INSERT OR IGNORE INTO users (id, username, email, created_at, updated_at) VALUES (?, ?, null, ?, ?)`)
      .run('default', 'default', Date.now(), Date.now());
  } catch {}

  // Ensure default network exists in global DB
  const defaultNetwork = globalDb.networks.get(defaultNetworkId);
  if (!defaultNetwork) {
    globalDb.networks.create({
      id: defaultNetworkId,
      ownerId: 'system',
      name: 'Default Team',
      path: 'default',
      description: null,
      visibility: 'public',
      createdAt: Date.now(),
    });
  } else if (defaultNetwork.name === 'Default Network') {
    globalDb.networks.updateName(defaultNetworkId, 'Default Team');
  }

  // Ensure admin account exists after the default network so membership FK checks pass.
  {
    const existing = globalDb.users.getByName('admin');
    if (!existing) {
      const hash = await hashPassword('admin101');
      globalDb.users.create({ id: 'admin', username: 'admin', passwordHash: hash, role: 'admin', createdAt: Date.now() });
      logger.info('admin account created');
    }
    globalDb.networkMembers.add(defaultNetworkId, 'admin', 'owner');
  }

  const extractTokenFromConnectCommand = (command?: string | null): string | null => {
    if (!command) return null;
    const match = command.match(/(?:^|\s)--token(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  };

  for (const device of globalDb.devices.listAll()) {
    const tokenFromCommand = extractTokenFromConnectCommand(device.connectCommand);
    const parsed = tokenFromCommand ? parseToken(tokenFromCommand) : null;
    if (!parsed || !globalDb.users.get(parsed.userId) || device.userId === parsed.userId) continue;
    globalDb.devices.transferOwner(device.id, parsed.userId);
    logger.info({ deviceId: device.id, fromUserId: device.userId, toUserId: parsed.userId }, 'device owner repaired from connect command');
  }

  const repairAgentOwner = globalDb.raw.prepare(`UPDATE agents SET owner_id = ? WHERE id = ? AND owner_id IS NULL`);
  for (const agent of globalDb.agents.listAll()) {
    if (agent.ownerId || !agent.deviceId) continue;
    const device = globalDb.devices.get(agent.deviceId);
    if (!device?.userId || !globalDb.users.get(device.userId)) continue;
    repairAgentOwner.run(device.userId, agent.id);
    logger.info({ agentId: agent.id, deviceId: agent.deviceId, ownerId: device.userId }, 'agent owner repaired from device owner');
  }

  const channels = new ChannelService({
    storageManager,
    registry,
    getPersistedAgent: (agentId) => {
      const agent = globalDb.agents.getFull(agentId);
      return agent
        ? {
            id: agent.id,
            name: agent.name,
            adapterKind: agent.adapterKind,
            category: agent.category,
            source: agent.source,
          }
        : null;
    },
  });
  channels.ensureDefault(defaultNetworkId);
  const metricsCollector = new AgentMetricsCollector();
  const inviteSessions = new Map<string, import('socket.io').Socket>();

  mkdirSync(artifactDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  const corsOrigin = resolveCorsOrigin();
  attachRestCors(app, corsOrigin);
  app.use(express.json());
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  const upload = multer({ dest: '/tmp/agentbean-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
  attachArtifactRoutes({ app, storageManager, upload, token, globalDb });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err?.message, stack: err?.stack }, 'express error');
    res.status(500).json({ error: 'internal error' });
  });

  const server = http.createServer(app);
  const io = new IOServer(server, { cors: { origin: corsOrigin } });

  const dispatchTimeoutMs = Number.parseInt(process.env.AGENTBEAN_DISPATCH_TIMEOUT_MS ?? '', 10);
  const { dispatch, stopAgents } = attachAgentNamespace({
    io,
    db,
    registry,
    deviceRegistry,
    token,
    globalDb,
    metricsCollector,
    dispatchTimeoutMs: Number.isFinite(dispatchTimeoutMs) && dispatchTimeoutMs > 0 ? dispatchTimeoutMs : undefined,
    onDeviceOnline: emitCustomAgentStatusesForDevice,
    onDeviceOffline: markDeviceAndAgentsOffline,
  });

  const stopScanner = startHeartbeatScanner({
    registry, timeoutMs: 30_000, intervalMs: 5_000,
    onTimeout: (id) => {
      const rt = registry.snapshot(id);
      if (rt) io.of('/web').emit('agent:status', runtimeAgentStatusDto(rt));
    },
  });
  const stopDeviceScanner = startDeviceHeartbeatScanner({
    deviceRegistry, timeoutMs: 30_000, intervalMs: 5_000,
    onTimeout: (deviceId) => markDeviceAndAgentsOffline(deviceId, 'heartbeat-timeout'),
  });

  const makePersistMessage = (sp: typeof space, netId: string) => (m: {
    id: string; channelId: string; senderKind: 'human' | 'agent' | 'system';
    senderId: string | null; body: string; createdAt: number; metaJson: string | null;
    artifactIds?: string[];
  }) => {
    sp.messages.append(m);
    if (m.artifactIds?.length) {
      sp.artifacts.bindMessageId(m.artifactIds, m.id);
    }
    const artifacts = sp.artifacts.listByMessage(m.id).map(a => ({
      id: a.id, filename: a.filename, mimeType: a.mimeType,
      sizeBytes: a.sizeBytes, createdAt: a.createdAt,
      downloadUrl: `/api/networks/${netId}/artifacts/${a.id}/download`,
      previewUrl: `/api/networks/${netId}/artifacts/${a.id}/preview`,
    }));
    io.of('/web').to(`channel:${m.channelId}`).emit('channel:message', {
      ...m, artifacts: artifacts.length > 0 ? artifacts : undefined,
    });
  };

  const artifactDtos = (sp: typeof space, netId: string, artifactIds: string[] = []) =>
    artifactIds
      .map((id) => sp.artifacts.get(id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .map(a => ({
        id: a.id, filename: a.filename, mimeType: a.mimeType,
        sizeBytes: a.sizeBytes, createdAt: a.createdAt,
        downloadUrl: `/api/networks/${netId}/artifacts/${a.id}/download`,
        previewUrl: `/api/networks/${netId}/artifacts/${a.id}/preview`,
      }));

  const parseMessageMeta = (raw?: string | null): Record<string, any> => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const publishTaskStatusChange = (sp: typeof space, taskId: string, status: string) => {
    const before = sp.tasks.get(taskId);
    if (!before || before.status === status) return before ?? null;
    sp.tasks.update(taskId, { status: status as any });
    const task = sp.tasks.get(taskId);
    if (!task?.channelId) return task ?? null;
    io.of('/web').to(`channel:${task.channelId}`).emit('task:updated', task);
    return task;
  };

  const resolveDispatchSpeaker = (networkId: string, message: ReturnType<typeof space.messages.listByChannel>[number]) => {
    if (message.senderKind === 'human') {
      return message.senderId ? (globalDb.users.get(message.senderId)?.username ?? '用户') : '用户';
    }
    if (message.senderKind === 'agent') {
      const agentId = message.senderId ?? '';
      return buildVisibleAgentDtos(networkId).find((agent) => agent.id === agentId)?.name
        ?? globalDb.agents.getFull(agentId)?.name
        ?? 'Agent';
    }
    return 'system';
  };

  const buildDispatchHistory = (networkId: string, messages: ReturnType<typeof space.messages.listByChannel>, parentMessageId?: string) => {
    const selected = parentMessageId
      ? messages.filter((m) => {
          const meta = parseMessageMeta(m.metaJson);
          return m.id === parentMessageId || meta.parentMessageId === parentMessageId || meta.inReplyTo === parentMessageId;
        })
      : messages.slice(-20);
    return selected
      .filter((m) => m.senderKind === 'human' || m.senderKind === 'agent')
      .slice(-20)
      .map((m) => ({
        role: m.senderKind === 'agent' ? 'assistant' as const : 'user' as const,
        speaker: resolveDispatchSpeaker(networkId, m),
        body: m.body,
        at: m.createdAt,
      }));
  };

  const socketNetworkMap = new Map<string, string>();

  function emitDevicesSnapshotForNetwork(networkId: string): void {
    for (const s of io.of('/web').sockets.values()) {
      if ((socketNetworkMap.get(s.id) ?? defaultNetworkId) !== networkId) continue;
      s.emit('devices:snapshot', devicesForNetwork(networkId, s.data.userId as string | undefined));
    }
  }

  function emitChannelsSnapshotForNetwork(networkId: string): void {
    for (const s of io.of('/web').sockets.values()) {
      if ((socketNetworkMap.get(s.id) ?? defaultNetworkId) !== networkId) continue;
      const userId = s.data.userId as string | undefined;
      const list = userId ? channels.listForUser(networkId, userId) : channels.list(networkId);
      s.emit('channels:snapshot', list);
    }
  }

  const webToken = process.env.AGENT_BEAN_WEB_TOKEN ?? token;
  io.of('/web').use((socket, next) => {
    const clientToken = socket.handshake.auth.token ?? socket.handshake.query.token;
    if (socket.handshake.auth.invite === true) {
      socket.data.inviteAuth = true;
      return next();
    }
    if (!clientToken || typeof clientToken !== 'string') return next(new Error('unauthorized'));
    if (clientToken === webToken) {
      socket.data.legacyAuth = true;
      return next();
    }
    const parsed = verifyUserToken(clientToken, globalDb);
    if (!parsed) return next(new Error('unauthorized'));
    socket.data.userId = parsed.userId;
    socket.data.networkId = parsed.networkId;
    const user = globalDb.users.get(parsed.userId);
    if (user) socket.data.role = user.role;
    next();
  }).on('connection', (socket) => {
    logger.info({ sid: socket.id }, '/web client connected');
    socketNetworkMap.set(socket.id, socket.data.networkId ?? defaultNetworkId);

    const isSystemAdmin = (userId?: string | null) =>
      Boolean(userId && globalDb.users.get(userId)?.role === 'admin');

    const canManageDevice = (device: { userId?: string | null } | null | undefined, userId?: string | null) =>
      canManageDeviceRow(device, userId);

    const canViewDevice = (device: { userId?: string | null; networkId?: string | null } | null | undefined, userId?: string | null, networkId?: string | null) => {
      if (!userId || !device || !networkId || device.networkId !== networkId) return false;
      if (canManageDevice(device, userId)) return true;
      const network = globalDb.networks.get(networkId);
      return network?.visibility === 'public' || globalDb.networkMembers.isMember(networkId, userId);
    };

    const canManageAgent = (agent: { ownerId?: string | null; deviceId?: string | null } | null | undefined, userId?: string | null) => {
      if (!userId || !agent) return false;
      if (isSystemAdmin(userId)) return true;
      if (agent.ownerId) return agent.ownerId === userId;
      if (agent.deviceId) {
        const device = globalDb.devices.get(agent.deviceId);
        if (device?.userId === userId) return true;
      }
      return false;
    };

    socket.on('disconnect', () => {
      socketNetworkMap.delete(socket.id);
      for (const [sessionId, sessionSocket] of inviteSessions.entries()) {
        if (sessionSocket.id === socket.id) inviteSessions.delete(sessionId);
      }
    });

    socket.on('agents:subscribe', () => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      socket.emit('agents:snapshot', buildVisibleAgentDtos(networkId));
    });

    socket.on('agent:metrics', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const summaries = metricsCollector.all();
        ack?.({ ok: true, summaries });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agents:discover', (_payload: {}, ack?: (r: any) => void) => {
      const daemonCount = io.of('/agent').sockets.size;
      if (daemonCount === 0) return ack?.({ ok: false, error: 'NO_DAEMON_CONNECTED' });
      io.of('/agent').emit('agents:discover');
      ack?.({ ok: true, daemonCount });
    });

    socket.on('device:scan', (payload: { deviceId: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const device = deviceRegistry.get(payload.deviceId);
        if (!device || device.status === 'offline') return ack?.({ ok: false, error: 'DEVICE_OFFLINE' });
        const persistedDevice = globalDb.devices.get(payload.deviceId);
        if (!canManageDevice(persistedDevice, userId)) return ack?.({ ok: false, error: 'FORBIDDEN' });
        const agentSocket = io.of('/agent').sockets.get(device.socket.id);
        if (!agentSocket) return ack?.({ ok: false, error: 'SOCKET_NOT_FOUND' });
        agentSocket.emit('agents:discover');
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:select-directory', (payload: { deviceId: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const device = deviceRegistry.get(payload.deviceId);
        if (!device || device.status === 'offline') return ack?.({ ok: false, error: 'DEVICE_OFFLINE' });
        if (device.networkId !== networkId) return ack?.({ ok: false, error: 'DEVICE_NOT_IN_TEAM' });
        const persistedDevice = globalDb.devices.get(payload.deviceId);
        if (!canManageDevice(persistedDevice, userId)) return ack?.({ ok: false, error: 'FORBIDDEN' });
        if (!device.capabilities?.directoryPicker) return ack?.({ ok: false, error: 'DAEMON_UPGRADE_REQUIRED' });
        const agentSocket = io.of('/agent').sockets.get(device.socket.id);
        if (!agentSocket) return ack?.({ ok: false, error: 'SOCKET_NOT_FOUND' });

        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ack?.({ ok: false, error: 'DIRECTORY_PICKER_TIMEOUT' });
        }, 30_000);

        agentSocket.emit('device:select-directory', {}, (res: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (res?.ok && typeof res.path === 'string' && res.path.trim()) {
            ack?.({ ok: true, path: res.path.trim() });
          } else {
            ack?.({ ok: false, error: res?.error ?? 'DIRECTORY_PICKER_FAILED' });
          }
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('devices:subscribe', () => {
      const nid = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      socket.emit('devices:snapshot', devicesForNetwork(nid, socket.data.userId as string | undefined));
    });

    socket.on('devices:list', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const nid = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        ack?.({ ok: true, devices: devicesForNetwork(nid, socket.data.userId as string | undefined) });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('members:list', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const humans = globalDb.networkMembers.listByNetwork(networkId);
        const agents = buildVisibleAgentDtos(networkId);
        ack?.({ ok: true, humans, agents });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('member:update-human', (payload: { userId: string; description?: string | null }, ack?: (r: any) => void) => {
      try {
        const actorId = socket.data.userId as string | undefined;
        if (!actorId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const actor = globalDb.users.get(actorId);
        if (!actor) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        if (!globalDb.networkMembers.isMember(networkId, payload.userId)) return ack?.({ ok: false, error: 'MEMBER_NOT_FOUND' });
        if (actorId !== payload.userId && actor.role !== 'admin') return ack?.({ ok: false, error: 'FORBIDDEN' });

        const description = payload.description?.trim() || null;
        globalDb.users.updateDescription(payload.userId, description, Date.now());
        const human = globalDb.networkMembers.listByNetwork(networkId).find((item) => item.userId === payload.userId);
        ack?.({ ok: true, human });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:agents:list', (payload: { deviceId: string }, ack?: (r: any) => void) => {
      try {
        // Get agents from global DB (persisted scanned agents)
        const globalAgents = globalDb.agents.listByDevice(payload.deviceId);
        // Merge with live AgentRegistry data
        const result = globalAgents
          .filter((ga) => !(ga.source === 'scanned' && ga.category === 'executor-hosted'))
          .map((ga) => {
            const resolved = resolveAgentStatus(ga, ga.lastSeenAt, ga.lastError);
            return enrichAgentOwnership({
              id: ga.id,
              name: ga.name,
              adapterKind: ga.adapterKind,
              category: ga.category,
              source: ga.source,
              command: ga.command,
              args: ga.args,
              cwd: ga.cwd,
              deviceId: ga.deviceId,
              networkId: ga.networkId,
              visibility: ga.visibility,
              ownerId: ga.ownerId,
              description: ga.description,
              status: resolved.status,
              publishedNetworkIds: registry.snapshot(ga.id)?.publishedNetworkIds ?? globalDb.agentPublishes.listByAgent(ga.id).map((p) => p.networkId),
              lastSeenAt: resolved.lastSeenAt ?? ga.lastSeenAt,
              lastError: resolved.lastError,
            });
          });
        const live = deviceRegistry.get(payload.deviceId);
        const dbDevice = globalDb.devices.get(payload.deviceId);
        ack?.({ ok: true, agents: result, runtimes: live?.runtimes ?? dbDevice?.runtimes ?? [] });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:custom:list', (payload: { deviceId?: string } = {}, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHENTICATED' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const requestedDevice = payload.deviceId ? globalDb.devices.get(payload.deviceId) : null;
        if (payload.deviceId) {
          if (!requestedDevice || requestedDevice.networkId !== networkId) return ack?.({ ok: false, error: 'DEVICE_NOT_IN_TEAM' });
          if (!canViewDevice(requestedDevice, userId, networkId)) return ack?.({ ok: false, error: 'FORBIDDEN' });
        }
        const visibleAgentIds = payload.deviceId && requestedDevice && !canManageDevice(requestedDevice, userId)
          ? new Set(globalDb.agents.listVisibleInNetwork(networkId).filter(isTeamAgent).map((agent) => agent.id))
          : null;
        const sourceAgents = payload.deviceId
          ? globalDb.agents.listAll().filter((agent) =>
              agent.source === 'custom' &&
              agent.deviceId === payload.deviceId &&
              (!visibleAgentIds || visibleAgentIds.has(agent.id))
            )
          : globalDb.agents.listCustomByOwner(userId);
        const agents = sourceAgents
          .map((agent) => {
          const rt = registry.snapshot(agent.id);
          const resolved = resolveCustomAgentStatus(agent);
          let parsedArgs: string[] | null = null;
          if (Array.isArray((agent as any).args)) {
            parsedArgs = (agent as any).args;
          } else if (agent.args) {
            try { parsedArgs = JSON.parse(agent.args); } catch { parsedArgs = [agent.args]; }
          }
          return enrichAgentOwnership({
            id: agent.id,
            name: agent.name,
            role: agent.role ?? '',
            adapterKind: agent.adapterKind,
            category: agent.category,
            source: agent.source,
            command: agent.command,
            args: parsedArgs,
            cwd: agent.cwd,
            deviceId: agent.deviceId ?? undefined,
            networkId: agent.networkId,
            visibility: agent.visibility,
            ownerId: agent.ownerId,
            description: agent.description,
            status: resolved.status,
            lastSeenAt: resolved.lastSeenAt ?? rt?.lastHeartbeatAt ?? agent.lastSeenAt,
            lastError: resolved.lastError ?? rt?.lastError?.message ?? agent.lastError ?? undefined,
            publishedNetworkIds: rt?.publishedNetworkIds ?? globalDb.agentPublishes.listByAgent(agent.id).map((p) => p.networkId),
            connectCommand: renderConnectCommand({ adapterKind: agent.adapterKind as any }),
          });
        });
        ack?.({ ok: true, agents });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:get', (payload: { id: string }, ack?: (r: any) => void) => {
      try {
        const dbDevice = globalDb.devices.get(payload.id);
        if (!dbDevice) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const live = deviceRegistry.get(payload.id);
        const agents = live ? Array.from(live.agents.values()) : [];
        const daemonVersionInfo = buildDaemonVersionInfo(dbDevice.systemInfo);
        const ownerName = resolveOwnerName(dbDevice.userId) ?? '未知用户';
        ack?.({
          ok: true,
          device: {
            id: dbDevice.id,
            userId: dbDevice.userId,
            ownerName,
            userName: ownerName,
            networkId: dbDevice.networkId,
            hostname: dbDevice.hostname,
            agentIds: live ? Array.from(live.agents.keys()) : [],
            runtimes: live?.runtimes ?? [],
            lastSeenAt: live ? live.lastSeenAt : dbDevice.lastSeenAt,
            status: live ? live.status : 'offline',
            connectCommand: dbDevice.connectCommand,
            systemInfo: dbDevice.systemInfo,
            daemonVersionInfo,
            latestDaemonVersion: daemonVersionInfo.latest,
            daemonUpdateAvailable: daemonVersionInfo.updateAvailable,
            canManage: canManageDevice(dbDevice, socket.data.userId as string | undefined),
            agents,
          },
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:delete', (payload: { id: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const dbDevice = globalDb.devices.get(payload.id);
        if (!dbDevice) return ack?.({ ok: false, error: 'NOT_FOUND' });
        if (!canManageDevice(dbDevice, userId)) return ack?.({ ok: false, error: 'FORBIDDEN' });
        globalDb.devices.delete(payload.id);
        ack?.({ ok: true });
        emitDevicesSnapshotForNetwork(dbDevice.networkId);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:rename', (payload: { id: string; hostname: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const hostname = payload.hostname.trim().replace(/\s+/g, '-');
        const dbDevice = globalDb.devices.get(payload.id);
        if (!dbDevice) return ack?.({ ok: false, error: 'NOT_FOUND' });
        if (!canManageDevice(dbDevice, userId)) return ack?.({ ok: false, error: 'FORBIDDEN' });
        globalDb.devices.rename(payload.id, hostname);
        ack?.({ ok: true });
        emitDevicesSnapshotForNetwork(dbDevice.networkId);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    function getVisibleNetworks(userId?: string) {
      let networks = globalDb.networks.list().filter((n) => n.type !== 'private');
      if (userId) {
        const memberOf = new Set(globalDb.networkMembers.listByUser(userId).map((m) => m.networkId));
        networks = networks.filter((n) => n.visibility === 'public' || memberOf.has(n.id));
      }
      return networks;
    }

    socket.on('network:list', (_payload: {}, ack?: (r: any) => void) => {
      try {
        ack?.({ ok: true, networks: getVisibleNetworks(socket.data.userId as string | undefined) });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    // --- Task events ---
    socket.on('task:create', (payload: { title: string; description?: string; status?: string; assigneeId?: string; channelId?: string; tags?: string[] }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        if (!payload.title?.trim()) return ack?.({ ok: false, error: 'EMPTY_TITLE' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        const task = sp.tasks.create({
          title: payload.title.trim(),
          description: payload.description,
          status: payload.status as any,
          creatorId: userId,
          assigneeId: payload.assigneeId,
          channelId: payload.channelId,
          tags: payload.tags,
          createdAt: Date.now(),
        });
        ack?.({ ok: true, task });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('task:list', (payload: { channelId?: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        const tasks = sp.tasks.list(payload.channelId);
        ack?.({ ok: true, tasks });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('task:update', (payload: { id: string; title?: string; description?: string; status?: string; assigneeId?: string | null; channelId?: string | null; tags?: string[]; sortOrder?: number }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        const before = sp.tasks.get(payload.id);
        sp.tasks.update(payload.id, {
          title: payload.title,
          description: payload.description,
          status: payload.status as any,
          assigneeId: payload.assigneeId,
          channelId: payload.channelId,
          tags: payload.tags,
          sortOrder: payload.sortOrder,
        });
        const task = sp.tasks.get(payload.id);
        if (task?.channelId) {
          io.of('/web').to(`channel:${task.channelId}`).emit('task:updated', task);
        }
        ack?.({ ok: true, task });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('task:delete', (payload: { id: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        sp.tasks.delete(payload.id);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('task:reorder', (payload: { id: string; sortOrder: number }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        sp.tasks.updateSort(payload.id, payload.sortOrder);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    const RESERVED_PATHS = new Set(['login', 'signup', 'register', 'join', 'device-login', 'api', 'healthz']);

    function slugifyPath(name: string): string {
      return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    }

    function generateNetworkPath(name: string): string {
      let slug = slugifyPath(name);
      if (!slug || RESERVED_PATHS.has(slug)) slug = slug || 'network';
      let candidate = slug;
      let i = 1;
      while (globalDb.networks.getByPath(candidate)) {
        candidate = `${slug}-${i++}`;
      }
      return candidate;
    }

    socket.on('network:create', (payload: { name: string; path?: string; description?: string; visibility?: 'public' | 'private' }, ack?: (r: any) => void) => {
      try {
        logger.info({ payload, userId: socket.data.userId }, 'network:create');
        const name = payload.name.trim();
        if (!name) return ack?.({ ok: false, error: 'EMPTY_NAME' });
        const isPublic = payload.visibility === 'public' && socket.data.role === 'admin';
        const visibility = isPublic ? 'public' as const : 'private' as const;
        const type = isPublic ? 'public' as const : 'local' as const;
        const id = newId();
        const rawPath = payload.path?.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '';
        if (rawPath && RESERVED_PATHS.has(rawPath)) return ack?.({ ok: false, error: 'RESERVED_PATH' });
        const path = rawPath && !globalDb.networks.getByPath(rawPath) ? rawPath : generateNetworkPath(rawPath || name);
        const network = globalDb.networks.create({
          id, ownerId: socket.data.userId ?? 'system', name, path,
          description: payload.description ?? null,
          visibility,
          type,
          createdAt: Date.now(),
        });
        if (socket.data.userId) {
          globalDb.networkMembers.add(id, socket.data.userId, 'owner');
        }
        storageManager.createSpace(id);
        channels.ensureDefault(id);
        ack?.({ ok: true, network });
        for (const s of io.of('/web').sockets.values()) {
          s.emit('networks:snapshot', getVisibleNetworks(s.data.userId as string | undefined));
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('network:switch', (payload: { networkId: string }, ack?: (r: any) => void) => {
      try {
        const network = globalDb.networks.get(payload.networkId);
        if (!network) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const userId = socket.data.userId as string | undefined;
        if (userId && network.visibility !== 'public' && !globalDb.networkMembers.isMember(payload.networkId, userId)) {
          return ack?.({ ok: false, error: 'FORBIDDEN' });
        }
        socketNetworkMap.set(socket.id, payload.networkId);
        storageManager.getSpace(payload.networkId);
        if (userId) globalDb.users.setCurrentNetwork(userId, payload.networkId);
        ack?.({ ok: true, network });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('network:update', (payload: { name?: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        if (payload.name?.trim()) {
          globalDb.networks.updateName(networkId, payload.name.trim());
        }
        const updated = globalDb.networks.get(networkId);
        ack?.({ ok: true, network: updated });
        for (const s of io.of('/web').sockets.values()) {
          s.emit('networks:snapshot', getVisibleNetworks(s.data.userId as string | undefined));
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channels:subscribe', () => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const userId = socket.data.userId as string | undefined;
      const list = userId ? channels.listForUser(networkId, userId) : channels.list(networkId);
      socket.emit('channels:snapshot', list);
      if (userId) {
        const dms = channels.listDms(networkId, userId);
        socket.emit('dms:snapshot', dms);
      }
    });

    socket.on('channel:join', (payload: { channelId: string }) => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const ch = channels.get(networkId, payload.channelId);
      if (!ch) {
        socket.emit('error', { message: 'CHANNEL_NOT_FOUND' });
        return;
      }
      socket.join(`channel:${payload.channelId}`);
      const sp = storageManager.getSpace(networkId);
      const history = sp.messages.listByChannel(payload.channelId, 200);
      const messagesWithArtifacts = history.map(m => {
        const artifacts = sp.artifacts.listByMessage(m.id).map(a => ({
          id: a.id, filename: a.filename, mimeType: a.mimeType,
          sizeBytes: a.sizeBytes, createdAt: a.createdAt,
          downloadUrl: `/api/networks/${networkId}/artifacts/${a.id}/download`,
          previewUrl: `/api/networks/${networkId}/artifacts/${a.id}/preview`,
        }));
        return { ...m, artifacts: artifacts.length > 0 ? artifacts : undefined };
      });
      socket.emit('channel:history', { channelId: payload.channelId, messages: messagesWithArtifacts });
    });

    socket.on('channel:create', async (payload: { name?: string; agentIds?: string[]; userIds?: string[]; visibility?: 'public' | 'private' }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        const ch = channels.create(networkId, {
          name: payload.name ?? '',
          agentIds: payload.agentIds ?? [],
          userIds: payload.userIds,
          visibility: payload.visibility,
          createdBy: userId,
        });
        ack?.({ ok: true, channel: ch });
        emitChannelsSnapshotForNetwork(networkId);
        const members = channels.membersOf(networkId, ch.id);
        const sp = storageManager.getSpace(networkId);
        const persist = makePersistMessage(sp, networkId);
        await runIntros({
          channel: ch,
          members,
          dispatch: (req) => dispatch({ agentId: req.agentId, channelId: req.channelId, prompt: req.prompt, requestId: req.requestId, networkId }),
          onMessage: persist,
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    // DM events
    socket.on('dm:start', (payload: { agentId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const dm = channels.findOrCreateDm(networkId, userId, payload.agentId);
        ack?.({ ok: true, dm });
        // Refresh channel and DM lists for this user
        const userChannels = channels.listForUser(networkId, userId);
        socket.emit('channels:snapshot', userChannels);
        const dms = channels.listDms(networkId, userId);
        socket.emit('dms:snapshot', dms);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('dm:list', (ack?: (r: any) => void) => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const userId = socket.data.userId as string;
      if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
      const dms = channels.listDms(networkId, userId);
      ack?.({ ok: true, dms });
    });

    socket.on('message:send', async (
      payload: { channelId: string; body: string; clientMsgId?: string; asTask?: boolean; artifactIds?: string[]; parentMessageId?: string },
      ack?: (r: any) => void,
    ) => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const sp = storageManager.getSpace(networkId);
      const persist = makePersistMessage(sp, networkId);

      const body = (payload?.body ?? '').trim();
      if (!body) return ack?.({ ok: false, error: 'EMPTY' });
      const ch = channels.get(networkId, payload.channelId);
      if (!ch) return ack?.({ ok: false, error: 'NO_CHANNEL' });
      const userId = socket.data.userId as string | undefined;
      if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
      const visibleAgents = buildVisibleAgentDtos(networkId);
      const agentById = new Map(visibleAgents.map((agent) => [agent.id, agent]));
      const dmTargetId = channels.dmTargetId(networkId, ch.id);
      const isDefaultChannel = channels.isDefaultChannel(networkId, ch.id);
      if (!dmTargetId && !isDefaultChannel && channels.userHasLeft(networkId, ch.id, userId)) {
        return ack?.({ ok: false, error: 'CHANNEL_LEFT' });
      }

      const attachmentIds = [...new Set((payload.artifactIds ?? []).filter((id) => typeof id === 'string' && id.trim()))];
      const parentMessageId = typeof payload.parentMessageId === 'string' && payload.parentMessageId.trim()
        ? payload.parentMessageId.trim()
        : undefined;
      const explicitMention = /^\s*@(\S+)/.test(body);
      const memberIds = dmTargetId
        ? [dmTargetId]
        : isDefaultChannel
          ? visibleAgents.map((agent) => agent.id)
          : channels.memberIds(networkId, ch.id);
      const members = memberIds
        .map((id) => agentById.get(id))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
        .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
      const candidates = visibleAgents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
      const networkHumans = globalDb.networkMembers.listByNetwork(networkId);
      const humanMemberIds = dmTargetId
        ? new Set<string>()
        : ch.visibility === 'private' && !isDefaultChannel
          ? new Set(channels.userMembers(networkId, ch.id))
          : null;
      const humans = networkHumans
        .filter((human) => {
          if (!isDefaultChannel && channels.userHasLeft(networkId, ch.id, human.userId)) return false;
          return !humanMemberIds || humanMemberIds.has(human.userId);
        })
        .map((human) => ({ id: human.userId, name: human.username }));
      const currentHistory = sp.messages.listByChannel(ch.id, 200);
      const threadAgent = parentMessageId && !explicitMention
        ? [...currentHistory].reverse()
            .find((m) => {
              const meta = parseMessageMeta(m.metaJson);
              return m.senderKind === 'agent' && (meta.inReplyTo === parentMessageId || meta.parentMessageId === parentMessageId);
            })
        : null;
      const threadTarget = threadAgent?.senderId ? agentById.get(threadAgent.senderId) : undefined;

      const route = threadTarget && (threadTarget.status === 'online' || threadTarget.status === 'busy')
        ? { targets: [{ id: threadTarget.id, name: threadTarget.name, status: threadTarget.status }], reason: 'FALLBACK' as const }
        : routeHumanMessage({ body, members, candidates, humans });
      const recipient = route.targets[0];
      const shouldCreateTask = Boolean(
        payload.asTask ||
        (recipient && (dmTargetId || explicitMention || threadTarget)),
      );
      let taskId: string | undefined;
      let taskTitle: string | undefined;
      let taskAssigneeName: string | undefined;
      if (shouldCreateTask) {
        taskTitle = body.split(/\r?\n/)[0]?.trim().slice(0, 80) || '未命名任务';
        taskAssigneeName = recipient?.name;
        const task = sp.tasks.create({
          title: taskTitle,
          description: body,
          status: 'todo',
          creatorId: userId,
          assigneeId: dmTargetId ?? recipient?.id,
          channelId: ch.id,
          tags: ['聊天'],
          createdAt: Date.now(),
        });
        taskId = task.id;
      }
      const humanMsg = {
        id: newId(), channelId: ch.id, senderKind: 'human' as const, senderId: userId,
        body, createdAt: Date.now(),
        metaJson: JSON.stringify({
          clientMsgId: payload.clientMsgId,
          parentMessageId,
          taskId,
          taskTitle,
          taskAssigneeName,
        }),
      };
      persist({ ...humanMsg, artifactIds: attachmentIds.length ? attachmentIds : undefined });
      ack?.({ ok: true, id: humanMsg.id });

      if (route.reason === 'NO_ONLINE') {
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: '当前没有在线 Agent 可响应,消息已保存。',
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'no-online-agent' }),
        });
        return;
      }
      if (route.reason === 'HUMAN_MENTION') {
        return;
      }
      if (route.reason === 'UNKNOWN_MENTION' || route.targets.length === 0) {
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: '未找到被 @ 的在线 Agent，消息已保存。',
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'unknown-mention' }),
        });
        return;
      }

      const dispatchRecipient = recipient!;
      const reqId = newId();
      const attachments = artifactDtos(sp, networkId, attachmentIds);
      if (taskId) publishTaskStatusChange(sp, taskId, 'in_progress');
      const reply = await dispatch({
        agentId: dispatchRecipient.id,
        channelId: ch.id,
        prompt: body,
        requestId: reqId,
        networkId,
        history: buildDispatchHistory(networkId, currentHistory, parentMessageId),
        attachments,
      });
      if (reply.ok && reply.body?.trim()) {
        const artifactIds = reply.artifactIds;
        persist({
          id: newId(), channelId: ch.id, senderKind: 'agent', senderId: dispatchRecipient.id,
          body: reply.body.trim(), createdAt: Date.now(),
          metaJson: JSON.stringify({ inReplyTo: parentMessageId ?? humanMsg.id, requestId: reqId }),
          artifactIds: artifactIds?.length ? artifactIds : undefined,
        });
        if (taskId) publishTaskStatusChange(sp, taskId, 'done');
      } else {
        const error = reply.error ?? (reply.ok ? 'Agent 返回了空响应' : 'unknown');
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: `${dispatchRecipient.name} 处理失败: ${error}`,
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'reply-fail', agentId: dispatchRecipient.id }),
        });
        if (taskId) publishTaskStatusChange(sp, taskId, 'in_review');
      }
    });

    socket.on('message:search', (payload: { query: string; limit?: number }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        const query = (payload?.query ?? '').trim();
        const results = sp.messages.search(query, payload?.limit ?? 20);
        ack?.({ ok: true, messages: results });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:add-member', (payload: { channelId: string; userId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.addUserMember(networkId, payload.channelId, payload.userId);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:add-agent', (payload: { channelId: string; agentId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const agent = buildVisibleAgentDtos(networkId).find((item) => item.id === payload.agentId);
        if (!agent) return ack?.({ ok: false, error: 'AGENT_NOT_FOUND' });
        channels.addAgentMember(networkId, payload.channelId, payload.agentId);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:remove-member', (payload: { channelId: string; userId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.removeUserMember(networkId, payload.channelId, payload.userId);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:members', (payload: { channelId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const visibleAgents = buildVisibleAgentDtos(networkId);
        const isDefaultChannel = channels.isDefaultChannel(networkId, payload.channelId);
        const agentIds = isDefaultChannel ? null : new Set(channels.memberIds(networkId, payload.channelId));
        const agents = visibleAgents.filter((agent) => !agentIds || agentIds.has(agent.id));
        const networkHumans = globalDb.networkMembers.listByNetwork(networkId);
        const userIds = ch.visibility === 'private' && !isDefaultChannel
          ? new Set(channels.userMembers(networkId, payload.channelId))
          : null;
        const humans = networkHumans.filter((human) => {
          if (!isDefaultChannel && channels.userHasLeft(networkId, payload.channelId, human.userId)) return false;
          return !userIds || userIds.has(human.userId);
        });
        ack?.({ ok: true, humans, agents });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:update', (payload: { channelId: string; name?: string; description?: string | null; visibility?: 'public' | 'private' }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.update(networkId, payload.channelId, { name: payload.name, description: payload.description, visibility: payload.visibility });
        ack?.({ ok: true });
        emitChannelsSnapshotForNetwork(networkId);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:leave', (payload: { channelId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.leaveUser(networkId, payload.channelId, userId);
        ack?.({ ok: true });
        socket.emit('channels:snapshot', channels.listForUser(networkId, userId));
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:archive', (payload: { channelId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.archive(networkId, payload.channelId);
        ack?.({ ok: true });
        emitChannelsSnapshotForNetwork(networkId);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:delete', (payload: { channelId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.delete(networkId, payload.channelId);
        ack?.({ ok: true });
        emitChannelsSnapshotForNetwork(networkId);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:stop-agents', (payload: { channelId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const agentIds = channels.isDefaultChannel(networkId, payload.channelId)
          ? buildVisibleAgentDtos(networkId).map((agent) => agent.id)
          : channels.memberIds(networkId, payload.channelId);
        const result = stopAgents(agentIds, `频道 #${ch.name} 已停止运行中的 Agent`);
        ack?.({ ok: true, stopped: result.stopped });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:create', (payload: { name: string; role?: string; adapterKind: string; visibility?: 'public' | 'private'; networkId?: string; category?: string; ownerId?: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; description?: string; deviceId?: string; publishedNetworkIds?: string[] }, ack?: (r: any) => void) => {
      try {
        const name = payload.name.trim().replace(/\s+/g, '-');
        if (!name) return ack?.({ ok: false, error: 'EMPTY_NAME' });
        const command = payload.command?.trim() ?? '';
        const cwd = payload.cwd?.trim() ?? '';
        const env = normalizeEnv(payload.env);
        const targetNetworkId = payload.networkId ?? socket.data.networkId ?? socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        const network = globalDb.networks.get(targetNetworkId);
        if (userId && network?.visibility !== 'public' && !globalDb.networkMembers.isMember(targetNetworkId, userId)) {
          return ack?.({ ok: false, error: 'FORBIDDEN' });
        }
        const id = newId();
        const now = Date.now();
        const category = (payload.category as import('./db.js').AgentCategory) ?? 'executor-hosted';
        const requestedDevice = payload.deviceId ? globalDb.devices.get(payload.deviceId) as any : null;
        if (payload.deviceId && !requestedDevice) return ack?.({ ok: false, error: 'DEVICE_NOT_FOUND' });
        if (requestedDevice && requestedDevice.networkId !== targetNetworkId) return ack?.({ ok: false, error: 'DEVICE_NOT_IN_TEAM' });
        if (requestedDevice && !canManageDevice(requestedDevice, userId)) {
          return ack?.({ ok: false, error: 'FORBIDDEN_DEVICE' });
        }
        if (requestedDevice && !command) return ack?.({ ok: false, error: 'EMPTY_RUNTIME' });
        if (requestedDevice && !cwd) return ack?.({ ok: false, error: 'EMPTY_CWD' });
        const deviceId = requestedDevice ? payload.deviceId! : `virtual-${userId ?? 'system'}`;
        if (!requestedDevice) {
          globalDb.devices?.upsert({
            id: deviceId,
            userId: userId ?? 'system',
            networkId: targetNetworkId,
            lastSeenAt: now,
          });
        }

        const row = {
          id, name, role: payload.role ?? null,
          adapterKind: payload.adapterKind as import('./db.js').AdapterKind,
          deviceId,
          networkId: targetNetworkId,
          visibility: payload.visibility ?? 'public',
          category,
          source: 'custom' as const,
          firstSeenAt: now, lastSeenAt: now, lastError: null,
          ownerId: payload.ownerId ?? userId ?? null,
          command: command || null,
          args: payload.args ? JSON.stringify(payload.args) : null,
          cwd: cwd || null,
          env: env ? JSON.stringify(env) : null,
          description: payload.description ?? null,
        };
        db.agents.create(row);

        globalDb.agents.upsert({
          id, name, role: payload.role ?? null,
          adapterKind: payload.adapterKind as import('./db.js').AdapterKind,
          deviceId,
          networkId: targetNetworkId,
          visibility: payload.visibility ?? 'public',
          category,
          source: 'custom',
          firstSeenAt: now, lastSeenAt: now,
          lastError: undefined,
          ownerId: payload.ownerId ?? userId ?? undefined,
          command: command || undefined,
          args: payload.args ? JSON.stringify(payload.args) : undefined,
          cwd: cwd || undefined,
          env: env ? JSON.stringify(env) : undefined,
          description: payload.description ?? undefined,
        } as any);

        // Register in registry as virtual (offline, no socket)
        const rt = registry.registerVirtual({
          id, name,
          role: payload.role ?? '',
          adapterKind: payload.adapterKind as import('./db.js').AdapterKind,
          category,
          networkId: targetNetworkId,
          visibility: payload.visibility ?? 'public',
          ownerId: payload.ownerId ?? userId ?? null,
          command: command || null,
          args: payload.args ?? null,
          cwd: cwd || null,
          env,
          description: payload.description ?? null,
          deviceId,
          publishedNetworkIds: [],
          source: 'custom',
        });

        // Auto-publish to specified networks
        if (payload.publishedNetworkIds?.length && userId) {
          for (const netId of payload.publishedNetworkIds) {
            if (globalDb.networkMembers.isMember(netId, userId)) {
              globalDb.agentPublishes.publish(id, netId, userId);
            }
          }
          const publishes = globalDb.agentPublishes.listByAgent(id);
          rt.publishedNetworkIds = publishes.map((p: any) => p.networkId);
        }

        ack?.({ ok: true, agent: row });
        for (const s of io.of('/web').sockets.values()) {
          const sidNetworkId = socketNetworkMap.get(s.id) ?? defaultNetworkId;
          s.emit('agents:snapshot', buildVisibleAgentDtos(sidNetworkId));
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:update', (payload: { id: string; visibility?: 'public' | 'private'; networkId?: string }, ack?: (r: any) => void) => {
      try {
        const existing = db.agents.get(payload.id);
        if (!existing) return ack?.({ ok: false, error: 'NOT_FOUND' });

        let changed = false;
        let visibility = existing.visibility;
        let networkId = existing.networkId;

        if (payload.visibility !== undefined && payload.visibility !== existing.visibility) {
          db.agents.updateVisibility(payload.id, payload.visibility);
          registry.updateVisibility(payload.id, payload.visibility);
          visibility = payload.visibility;
          changed = true;
        }

        if (payload.networkId !== undefined && payload.networkId !== existing.networkId) {
          db.agents.updateNetworkId(payload.id, payload.networkId);
          registry.updateNetworkId(payload.id, payload.networkId);
          networkId = payload.networkId;
          changed = true;
        }

        if (changed) {
          const rt = registry.snapshot(payload.id);
          if (rt) {
            io.of('/web').emit('agent:status', runtimeAgentStatusDto(rt));
          } else {
            io.of('/web').emit('agent:status', {
              id: payload.id,
              name: existing.name,
              role: existing.role ?? '',
              adapterKind: existing.adapterKind,
              status: 'offline',
              lastSeenAt: existing.lastSeenAt,
              visibility,
              networkId,
              connectCommand: renderConnectCommand({ adapterKind: existing.adapterKind }),
            });
          }
        }

        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:config:update', (payload: { id: string; name: string; adapterKind?: string; command?: string; cwd?: string | null; description?: string | null }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const existing = globalDb.agents.getFull(payload.id);
        if (!existing) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const isCustom = existing.source === 'custom';
        const isAgentOS = existing.category === 'agentos-hosted';
        if (!isCustom && !isAgentOS) return ack?.({ ok: false, error: 'NOT_CONFIGURABLE_AGENT' });
        const canManageExistingAgent = isAgentOS && existing.deviceId
          ? canManageDevice(globalDb.devices.get(existing.deviceId), userId)
          : canManageAgent({ ownerId: existing.ownerId, deviceId: existing.deviceId }, userId);
        if (!canManageExistingAgent) return ack?.({ ok: false, error: 'FORBIDDEN' });
        const name = payload.name.trim();
        if (!name) return ack?.({ ok: false, error: 'EMPTY_NAME' });
        if (/\s/.test(name)) return ack?.({ ok: false, error: 'NAME_HAS_SPACE' });
        const adapterKind = isCustom ? payload.adapterKind?.trim() : undefined;
        const command = isCustom ? payload.command?.trim() : undefined;
        if (isCustom && !adapterKind) return ack?.({ ok: false, error: 'EMPTY_RUNTIME' });
        if (isCustom && !command) return ack?.({ ok: false, error: 'EMPTY_COMMAND' });
        const cwd = isAgentOS ? existing.cwd : payload.cwd?.trim() || null;
        const description = payload.description?.trim() || null;
        const updatedAt = Date.now();
        globalDb.agents.updateConfig(payload.id, {
          name,
          adapterKind: adapterKind ?? null,
          command: command ?? null,
          cwd,
          description,
          updatedAt,
        });
        const rt = registry.updateConfig(payload.id, {
          name,
          adapterKind: adapterKind as import('./db.js').AdapterKind | undefined,
          command,
          cwd,
          description,
        });
        if (rt) io.of('/web').emit('agent:status', runtimeAgentStatusDto(rt));
        ack?.({ ok: true, agent: globalDb.agents.getFull(payload.id) });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:publish', (payload: { agentId: string; networkId: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const rt = registry.snapshot(payload.agentId);
        const persisted = rt ? null : globalDb.agents.getFull(payload.agentId);
        if (!rt && !persisted) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const ownerId = rt?.ownerId ?? persisted?.ownerId;
        const deviceId = rt?.deviceId ?? persisted?.deviceId;
        if (!canManageAgent({ ownerId, deviceId }, userId)) return ack?.({ ok: false, error: 'FORBIDDEN' });
        const category = rt?.category ?? persisted?.category;
        const source = rt?.source ?? persisted?.source;
        if (!isTeamAgent({ category, source })) {
          return ack?.({ ok: false, error: 'RUNTIME_NOT_AGENT' });
        }

        // Runtime (executor-hosted) can only be published to private or owned networks
        const targetNetwork = globalDb.networks.get(payload.networkId);
        if (category === 'executor-hosted' && targetNetwork) {
          const isPrivate = targetNetwork.type === 'private';
          const isOwner = targetNetwork.ownerId === userId;
          if (!isPrivate && !isOwner) {
            return ack?.({ ok: false, error: 'RUNTIME_PUBLISH_FORBIDDEN' });
          }
        }

        if (!globalDb.networkMembers.isMember(payload.networkId, userId)) {
          return ack?.({ ok: false, error: 'NOT_NETWORK_MEMBER' });
        }
        globalDb.agentPublishes.publish(payload.agentId, payload.networkId, userId);
        const publishes = globalDb.agentPublishes.listByAgent(payload.agentId);
        registry.updatePublishedNetworks(payload.agentId, publishes.map((p: any) => p.networkId));
        const updated = registry.snapshot(payload.agentId);
        if (updated) io.of('/web').emit('agent:status', runtimeAgentStatusDto(updated));
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:unpublish', (payload: { agentId: string; networkId: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const rt = registry.snapshot(payload.agentId);
        const persisted = rt ? null : globalDb.agents.getFull(payload.agentId);
        if (!rt && !persisted) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const ownerId = rt?.ownerId ?? persisted?.ownerId;
        const deviceId = rt?.deviceId ?? persisted?.deviceId;
        if (!canManageAgent({ ownerId, deviceId }, userId)) return ack?.({ ok: false, error: 'FORBIDDEN' });
        const category = rt?.category ?? persisted?.category;
        const source = rt?.source ?? persisted?.source;
        if (!isTeamAgent({ category, source })) {
          return ack?.({ ok: false, error: 'RUNTIME_NOT_AGENT' });
        }
        globalDb.agentPublishes.unpublish(payload.agentId, payload.networkId);
        const publishes = globalDb.agentPublishes.listByAgent(payload.agentId);
        registry.updatePublishedNetworks(payload.agentId, publishes.map((p: any) => p.networkId));
        const updated = registry.snapshot(payload.agentId);
        if (updated) io.of('/web').emit('agent:status', runtimeAgentStatusDto(updated));
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:invite:validate', (payload: { code: string }, ack?: (r: any) => void) => {
      try {
        const invite = globalDb.invites.getByCode(payload.code);
        if (!invite) return ack?.({ ok: false, error: 'INVALID_CODE' });
        if (invite.usedAt) return ack?.({ ok: false, error: 'ALREADY_USED' });
        if (invite.expiresAt && invite.expiresAt < Date.now()) return ack?.({ ok: false, error: 'EXPIRED' });

        const webUrl = process.env.WEB_URL ?? 'http://localhost:3100';
        if (invite.purpose === 'device') {
          // Only store the first socket (the daemon's) — don't let browser validation overwrite it
          if (!inviteSessions.has(`device:${payload.code}`)) {
            inviteSessions.set(`device:${payload.code}`, socket);
          }
          ack?.({ ok: true, sessionId: null, registerUrl: `${webUrl}/device-login/${encodeURIComponent(payload.code)}` });
        } else {
          const sessionId = newId();
          inviteSessions.set(sessionId, socket);
          ack?.({ ok: true, sessionId, registerUrl: `${webUrl}/join/${sessionId}?code=${encodeURIComponent(payload.code)}` });
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:register', async (
      payload: { username: string; password: string; email?: string; inviteToken?: string; sessionId?: string },
      ack?: (r: any) => void,
    ) => {
      try {
        const username = payload.username.trim().replace(/\s+/g, '-');
        const email = payload.email?.trim() || null;
        if (!username || username.length < 2) return ack?.({ ok: false, error: 'USERNAME_TOO_SHORT' });
        if (!payload.password || payload.password.length < 6) return ack?.({ ok: false, error: 'PASSWORD_TOO_SHORT' });
        if (globalDb.users.getByName(username)) return ack?.({ ok: false, error: 'USERNAME_TAKEN' });
        if (email && globalDb.users.getByEmail(email)) return ack?.({ ok: false, error: 'EMAIL_TAKEN' });

        let invite: InviteRow | null = null;
        if (payload.inviteToken) {
          const checked = validateUserJoinInvite(globalDb, payload.inviteToken);
          if (!checked.ok) return ack?.({ ok: false, error: checked.error });
          invite = checked.invite;
        }

        const userId = newId();
        const now = Date.now();
        const passwordHash = await hashPassword(payload.password);
        const user = globalDb.users.create({ id: userId, username, email, passwordHash, createdAt: now });
        const privatePath = generateNetworkPath(username);
        const privateNetwork = globalDb.networks.create({
          id: newId(),
          ownerId: userId,
          name: `${username}-private`,
          path: privatePath,
          visibility: 'private',
          type: 'private',
          createdAt: now,
        });
        globalDb.networkMembers.add(privateNetwork.id, userId, 'owner');
        globalDb.users.setCurrentNetwork(userId, privateNetwork.id);
        storageManager.createSpace(privateNetwork.id);
        channels.ensureDefault(privateNetwork.id);

        // Auto-join all public networks so the user can see the public mesh
        const publicNetworks = globalDb.networks.list().filter(n => n.type === 'public');
        for (const net of publicNetworks) {
          if (!globalDb.networkMembers.isMember(net.id, userId)) {
            globalDb.networkMembers.add(net.id, userId, 'member');
          }
        }

        if (invite?.networkId) {
          globalDb.networkMembers.add(invite.networkId, userId, 'member');
        }
        if (invite) {
          consumeJoinInvite(globalDb, invite);
        }

        const joinedNetwork = invite?.networkId ? globalDb.networks.get(invite.networkId) : null;
        const primaryNetwork = joinedNetwork ?? privateNetwork;
        globalDb.users.setCurrentNetwork(userId, primaryNetwork.id);

        const userToken = generateToken(userId, primaryNetwork.id);
        socket.data.userId = userId;
        socket.data.networkId = primaryNetwork.id;
        socket.data.role = user.role;
        socketNetworkMap.set(socket.id, primaryNetwork.id);

        ack?.({ ok: true, userId, username: user.username, email: user.email, role: user.role, token: userToken, networkId: primaryNetwork.id, networkPath: primaryNetwork.path, network: primaryNetwork });

        const sessionSocket = payload.sessionId ? inviteSessions.get(payload.sessionId) : undefined;
        if (payload.sessionId && sessionSocket) {
          sessionSocket.emit('auth:token:deliver', { sessionId: payload.sessionId, token: userToken, userId, networkId: primaryNetwork.id });
          inviteSessions.delete(payload.sessionId);
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:login', async (
      payload: { username: string; password: string; joinCode?: string },
      ack?: (r: any) => void,
    ) => {
      try {
        const user = globalDb.users.getByName(payload.username);
        if (!user || !user.passwordHash) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });
        const ok = await verifyPassword(payload.password, user.passwordHash);
        if (!ok) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });

        // Handle join link — add user to the invite's network
        let joinedNetworkId: string | undefined;
        if (payload.joinCode) {
          const checked = validateUserJoinInvite(globalDb, payload.joinCode);
          if (!checked.ok) return ack?.({ ok: false, error: checked.error });
          const invite = checked.invite;
          if (invite.networkId) {
            if (!globalDb.networkMembers.isMember(invite.networkId, user.id)) {
              globalDb.networkMembers.add(invite.networkId, user.id, 'member');
            }
            joinedNetworkId = invite.networkId;
          }
          consumeJoinInvite(globalDb, invite);
        }

        // Ensure user is a member of all public networks
        const publicNetworks = globalDb.networks.list().filter(n => n.type === 'public');
        for (const net of publicNetworks) {
          if (!globalDb.networkMembers.isMember(net.id, user.id)) {
            globalDb.networkMembers.add(net.id, user.id, 'member');
          }
        }

        const members = globalDb.networkMembers.listByUser(user.id);
        const memberNetworkIds = members.map(m => m.networkId);

        // Prefer: joined network > saved current > first member > default
        let primaryNetwork = joinedNetworkId;
        if (!primaryNetwork && user.currentNetworkId && memberNetworkIds.includes(user.currentNetworkId)) {
          primaryNetwork = user.currentNetworkId;
        }
        if (!primaryNetwork) {
          primaryNetwork = members[0]?.networkId ?? defaultNetworkId;
        }

        const primaryNetRow = globalDb.networks.get(primaryNetwork);
        const userToken = generateToken(user.id, primaryNetwork);
        globalDb.users.setCurrentNetwork(user.id, primaryNetwork);
        socket.data.userId = user.id;
        socket.data.networkId = primaryNetwork;
        socket.data.role = user.role;
        socketNetworkMap.set(socket.id, primaryNetwork);
        ack?.({ ok: true, userId: user.id, username: user.username, email: user.email, role: user.role, token: userToken, networkId: primaryNetwork, networkPath: primaryNetRow?.path ?? 'default' });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:whoami', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId ?? parseToken(String(socket.handshake.auth.token ?? ''))?.userId;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const user = globalDb.users.get(userId);
        if (!user) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        ack?.({ ok: true, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:device-login', async (payload: { inviteCode: string; username: string; password: string }, ack?: (r: any) => void) => {
      try {
        const invite = globalDb.invites.getByCode(payload.inviteCode);
        if (!invite || invite.purpose !== 'device') return ack?.({ ok: false, error: 'INVALID_INVITE' });
        if (invite.usedAt) return ack?.({ ok: false, error: 'INVITE_ALREADY_USED' });
        if (invite.expiresAt && Date.now() > invite.expiresAt) return ack?.({ ok: false, error: 'INVITE_EXPIRED' });
        const user = globalDb.users.getByName(payload.username);
        if (!user || !user.passwordHash) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });
        const ok = await verifyPassword(payload.password, user.passwordHash);
        if (!ok) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });
        const networkId = invite.networkId ?? defaultNetworkId;
        const userToken = generateToken(user.id, networkId);
        globalDb.invites.markUsed(invite.code);
        globalDb.users.setCurrentNetwork(user.id, networkId);
        socket.data.userId = user.id;
        socket.data.networkId = networkId;
        socket.data.role = user.role;
        socketNetworkMap.set(socket.id, networkId);
        const devNetRow = globalDb.networks.get(networkId);
        ack?.({ ok: true, token: userToken, networkId, networkPath: devNetRow?.path ?? 'default', userId: user.id, username: user.username, role: user.role });

        // Deliver token to the daemon socket waiting on this invite code
        const daemonSocket = inviteSessions.get(`device:${payload.inviteCode}`);
        if (daemonSocket) {
          daemonSocket.emit('auth:token:deliver', { token: userToken, userId: user.id, networkId });
          inviteSessions.delete(`device:${payload.inviteCode}`);
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:change-password', async (payload: { currentPassword: string; newPassword: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const user = globalDb.users.get(userId);
        if (!user?.passwordHash) return ack?.({ ok: false, error: 'NO_PASSWORD' });
        const ok = await verifyPassword(payload.currentPassword, user.passwordHash);
        if (!ok) return ack?.({ ok: false, error: 'WRONG_PASSWORD' });
        const newHash = await hashPassword(payload.newPassword);
        globalDb.raw.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, Date.now(), user.id);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('invite:create', (payload: { networkId?: string; purpose?: 'user' | 'device' }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined ?? (socket.data.legacyAuth ? 'system' : undefined);
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const networkId = payload.networkId ?? socketNetworkMap.get(socket.id) ?? null;
        if (networkId) {
          const network = globalDb.networks.get(networkId);
          if (!network) return ack?.({ ok: false, error: 'NETWORK_NOT_FOUND' });
          if (network.visibility !== 'public' && !globalDb.networkMembers.isMember(networkId, userId)) {
            return ack?.({ ok: false, error: 'FORBIDDEN' });
          }
        }

        const purpose = payload.purpose ?? 'device';
        const code = generateInviteCode();
        const invite = globalDb.invites.create({
          id: newId(),
          code,
          createdBy: userId,
          networkId,
          purpose,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        const serverUrl = process.env.AGENT_BEAN_PUBLIC_SERVER_URL ?? 'http://localhost:4000';
        ack?.({
          ok: true,
          invite: {
            code,
            expiresAt: invite.expiresAt,
            command: buildInviteCommand(code, serverUrl),
            purpose,
          },
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    // ── Join Link Management ──────────────────────────────────────

    socket.on('join:create', (payload: { maxUses?: number; expiresAt?: number }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const network = globalDb.networks.get(networkId);
        if (!network) return ack?.({ ok: false, error: 'NETWORK_NOT_FOUND' });
        const isOwner = network.ownerId === userId;
        const isMember = globalDb.networkMembers.isMember(networkId, userId);
        if (!isOwner && !isMember && network.visibility !== 'public') return ack?.({ ok: false, error: 'FORBIDDEN' });

        const code = generateInviteCode(12);
        const invite = globalDb.invites.create({
          id: newId(),
          code,
          createdBy: userId,
          networkId,
          purpose: 'user',
          expiresAt: payload.expiresAt ?? null,
          maxUses: payload.maxUses ?? 1,
        });
        const webUrl = process.env.WEB_URL ?? 'http://localhost:3100';
        ack?.({
          ok: true,
          link: {
            id: invite.id,
            code,
            url: `${webUrl}/join/${code}`,
            maxUses: invite.maxUses,
            usesCount: 0,
            expiresAt: invite.expiresAt,
            createdAt: invite.createdAt,
          },
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('join:list', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const links = globalDb.invites.listByNetwork(networkId)
          .filter((inv) => inv.purpose === 'user' && !inv.usedAt && (!inv.expiresAt || inv.expiresAt > Date.now()))
          .map((inv) => ({
            id: inv.id,
            code: inv.code,
            url: `${process.env.WEB_URL ?? 'http://localhost:3100'}/join/${inv.code}`,
            maxUses: inv.maxUses,
            usesCount: inv.usesCount,
            expiresAt: inv.expiresAt,
            createdAt: inv.createdAt,
            usedAt: inv.usedAt,
          }));
        ack?.({ ok: true, links });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('join:revoke', (payload: { code: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const invite = globalDb.invites.getByCode(payload.code);
        if (!invite || invite.purpose !== 'user') return ack?.({ ok: false, error: 'NOT_FOUND' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        if (invite.networkId !== networkId) return ack?.({ ok: false, error: 'FORBIDDEN' });
        globalDb.invites.revoke(payload.code);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:join:validate', (payload: { code: string }, ack?: (r: any) => void) => {
      try {
        const checked = validateUserJoinInvite(globalDb, payload.code);
        if (!checked.ok) return ack?.({ ok: false, error: checked.error });
        const invite = checked.invite;
        const network = invite.networkId ? globalDb.networks.get(invite.networkId) : null;
        ack?.({
          ok: true,
          networkName: network?.name ?? '未知团队',
          expiresAt: invite.expiresAt,
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    // ── Admin Events ─────────────────────────────────────────────
    const requireAdmin = (ack?: (r: any) => void): string | null => {
      const userId = socket.data.userId as string | undefined;
      if (!userId) { ack?.({ ok: false, error: 'NOT_AUTHENTICATED' }); return null; }
      const user = globalDb.users.get(userId);
      if (!user || user.role !== 'admin') { ack?.({ ok: false, error: 'FORBIDDEN' }); return null; }
      return userId;
    };

    socket.on('admin:list-users', (_p: {}, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      ack?.({ ok: true, users: globalDb.users.listAll().map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.createdAt })) });
    });

    socket.on('admin:delete-user', (payload: { userId: string }, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      if (payload.userId === 'system' || payload.userId === 'admin') return ack?.({ ok: false, error: 'CANNOT_DELETE_SYSTEM_USER' });
      globalDb.users.delete(payload.userId);
      ack?.({ ok: true });
    });

    socket.on('admin:list-networks', (_p: {}, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      const nets = globalDb.networks.list().map((n) => ({
        ...n,
        members: globalDb.networkMembers.listByNetwork(n.id),
      }));
      ack?.({ ok: true, networks: nets });
    });

    socket.on('admin:delete-network', (payload: { networkId: string }, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      if (payload.networkId === 'default') return ack?.({ ok: false, error: 'CANNOT_DELETE_DEFAULT_NETWORK' });
      globalDb.raw.prepare('DELETE FROM networks WHERE id = ?').run(payload.networkId);
      ack?.({ ok: true });
    });

    socket.on('admin:list-devices', (_p: {}, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      const usersById = new Map(globalDb.users.listAll().map((user) => [user.id, user.username]));
      const networksById = new Map(globalDb.networks.list().map((network) => [network.id, network.name]));
      const parseArgs = (args?: string[] | string | null) => {
        if (Array.isArray(args)) return args;
        if (!args) return null;
        try {
          const parsed = JSON.parse(args);
          return Array.isArray(parsed) ? parsed : [String(args)];
        } catch {
          return [args];
        }
      };
      const devices = visibleDeviceRows(globalDb.devices.listAll()).map((device) => {
        const live = deviceRegistry.get(device.id);
        const deviceAgents = globalDb.agents.listByDevice(device.id).filter(isTeamAgent);
        const daemonVersionInfo = buildDaemonVersionInfo(device.systemInfo);
        const publicAgents = deviceAgents
          .filter((agent) => agent.visibility === 'public')
          .map((agent) => {
            const resolved = resolveAgentStatus(agent, agent.lastSeenAt, agent.lastError);
            const ownerId = resolveAgentOwnerId(agent);
            const ownerName = resolveOwnerName(ownerId) ?? usersById.get(device.userId) ?? '未知用户';
            return {
              id: agent.id,
              name: agent.name,
              role: agent.role ?? '',
              adapterKind: agent.adapterKind,
              category: agent.category,
              source: agent.source,
              command: agent.command,
              args: parseArgs(agent.args),
              cwd: agent.cwd,
              description: agent.description,
              status: resolved.status,
              lastSeenAt: resolved.lastSeenAt ?? agent.lastSeenAt,
              lastError: resolved.lastError,
              visibility: agent.visibility,
              networkId: agent.networkId,
              networkName: networksById.get(agent.networkId) ?? '未知团队',
              ownerId,
              ownerName,
              userName: ownerName,
              deviceId: agent.deviceId ?? undefined,
              deviceName: device.hostname ?? (typeof device.systemInfo?.hostname === 'string' ? device.systemInfo.hostname : null) ?? '未命名设备',
              deviceUserId: device.userId,
              deviceUserName: usersById.get(device.userId) ?? '未知用户',
              publishedNetworkIds: globalDb.agentPublishes.listByAgent(agent.id).map((p) => p.networkId),
              connectCommand: renderConnectCommand({ adapterKind: agent.adapterKind as any }),
            };
          });
        const systemName = typeof device.systemInfo?.hostname === 'string' ? device.systemInfo.hostname : null;
        return {
          id: device.id,
          name: device.hostname ?? systemName ?? '未命名设备',
          hostname: device.hostname,
          userId: device.userId,
          userName: usersById.get(device.userId) ?? '未知用户',
          networkId: device.networkId,
          networkName: networksById.get(device.networkId) ?? '未知团队',
          status: live ? live.status : (isRecentlySeen(device.lastSeenAt) ? 'online' : 'offline'),
          agentCount: live ? Math.max(live.agents.size, deviceAgents.length) : deviceAgents.length,
          lastSeenAt: live ? live.lastSeenAt : device.lastSeenAt,
          connectCommand: device.connectCommand,
          systemInfo: device.systemInfo,
          daemonVersionInfo,
          latestDaemonVersion: daemonVersionInfo.latest,
          daemonUpdateAvailable: daemonVersionInfo.updateAvailable,
          runtimes: live?.runtimes ?? device.runtimes ?? [],
          publicAgents,
        };
      });
      ack?.({ ok: true, devices });
    });

    socket.on('admin:transfer-device-owner', (payload: { deviceId?: string; userId?: string }, ack?: (r: any) => void) => {
      const adminId = requireAdmin(ack);
      if (!adminId) return;
      const deviceId = payload.deviceId?.trim();
      const userId = payload.userId?.trim();
      if (!deviceId || !userId) return ack?.({ ok: false, error: 'INVALID_PAYLOAD' });

      const device = globalDb.devices.get(deviceId);
      if (!device) return ack?.({ ok: false, error: 'DEVICE_NOT_FOUND' });
      const targetUser = globalDb.users.get(userId);
      if (!targetUser) return ack?.({ ok: false, error: 'USER_NOT_FOUND' });
      if (!globalDb.networkMembers.isMember(device.networkId, userId)) {
        return ack?.({ ok: false, error: 'USER_NOT_IN_NETWORK' });
      }

      globalDb.devices.transferOwner(deviceId, userId);
      globalDb.devices.setConnectCommand(deviceId, renderConnectCommand({
        adapterKind: 'codex',
        token: generateToken(userId, device.networkId),
      }));
      const liveDevice = deviceRegistry.get(deviceId);
      if (liveDevice) {
        liveDevice.userId = userId;
        for (const agent of liveDevice.agents.values()) {
          agent.ownerId = userId;
        }
      }
      const updated = globalDb.devices.get(deviceId);
      if (!updated) return ack?.({ ok: false, error: 'DEVICE_NOT_FOUND' });
      const dto = toDeviceDto(updated, adminId);
      io.of('/web').emit('device:status', dto);
      for (const agent of globalDb.agents.listByDevice(deviceId)) {
        const rt = registry.updateOwner(agent.id, userId);
        io.of('/web').emit('agent:status', rt ? runtimeAgentStatusDto(rt) : persistedAgentStatusDto(agent, 'offline', agent.lastSeenAt));
      }
      emitDevicesSnapshotForNetwork(updated.networkId);
      ack?.({ ok: true, device: dto });
    });

    socket.on('admin:list-agents', (_p: {}, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      const usersById = new Map(globalDb.users.listAll().map((user) => [user.id, user.username]));
      const networksById = new Map(globalDb.networks.list().map((network) => [network.id, network.name]));
      const devicesById = new Map(
        visibleDeviceRows(globalDb.devices.listAll()).map((device) => [device.id, {
          ...device,
          name: device.hostname ?? (typeof device.systemInfo?.hostname === 'string' ? device.systemInfo.hostname : null) ?? '未命名设备',
          userName: usersById.get(device.userId) ?? '未知用户',
        }]),
      );
      const parseArgs = (args?: string[] | string | null) => {
        if (Array.isArray(args)) return args;
        if (!args) return null;
        try {
          const parsed = JSON.parse(args);
          return Array.isArray(parsed) ? parsed : [String(args)];
        } catch {
          return [args];
        }
      };
      const agents: any[] = globalDb.agents.listAll()
        .filter(isTeamAgent)
        .map((agent) => {
          const resolved = resolveAgentStatus(agent, agent.lastSeenAt, agent.lastError);
          const device = agent.deviceId ? devicesById.get(agent.deviceId) : null;
          const ownerId = resolveAgentOwnerId(agent);
          const ownerName = resolveOwnerName(ownerId) ?? device?.userName ?? '未知用户';
          return {
            id: agent.id,
            name: agent.name,
            role: agent.role ?? '',
            adapterKind: agent.adapterKind,
            category: agent.category,
            source: agent.source,
            command: agent.command,
            args: parseArgs(agent.args),
            cwd: agent.cwd,
            description: agent.description,
            status: resolved.status,
            lastSeenAt: resolved.lastSeenAt ?? agent.lastSeenAt,
            lastError: resolved.lastError,
            visibility: agent.visibility,
            networkId: agent.networkId,
            networkName: networksById.get(agent.networkId) ?? '未知团队',
            ownerId,
            ownerName,
            userName: ownerName,
            deviceId: agent.deviceId ?? undefined,
            deviceName: device?.name ?? '未分配设备',
            deviceUserId: device?.userId ?? null,
            deviceUserName: device?.userName ?? null,
            publishedNetworkIds: globalDb.agentPublishes.listByAgent(agent.id).map((p) => p.networkId),
            connectCommand: renderConnectCommand({ adapterKind: agent.adapterKind as any }),
          };
        });

      const seen = new Set(agents.map((agent) => agent.id));
      for (const rt of registry.all().filter(isTeamAgent)) {
        if (seen.has(rt.id)) continue;
        const dto = snapshotToDto(rt);
        const device = dto.deviceId ? devicesById.get(dto.deviceId) : null;
        const ownerId = resolveAgentOwnerId(dto);
        const ownerName = resolveOwnerName(ownerId) ?? device?.userName ?? '未知用户';
        agents.push({
          ...dto,
          ownerId,
          ownerName,
          userName: ownerName,
          deviceName: device?.name ?? '未分配设备',
          deviceUserId: device?.userId ?? null,
          deviceUserName: device?.userName ?? null,
          networkName: dto.networkId ? networksById.get(dto.networkId) ?? '未知团队' : '未知团队',
        });
      }
      ack?.({ ok: true, agents });
    });

    socket.on('admin:delete-agent', (payload: { agentId: string }, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      registry.markOffline(payload.agentId, 'admin-delete');
      ack?.({ ok: true });
    });

  });

  if (opts.port !== undefined) {
    server.listen(opts.port, () => logger.info({ port: opts.port }, 'server listening'));
  }

  return {
    http: server, io, db, globalDb, registry, channels, dispatch,
    async close() {
      stopScanner();
      stopDeviceScanner();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      globalDb.close();
    },
  };
}

const isEntry = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts') || import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const port = Number(process.env.PORT ?? 4000);
  buildApp({ port });
}

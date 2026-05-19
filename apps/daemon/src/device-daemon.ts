import { io, type Socket } from 'socket.io-client';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './log.js';
import type { DeviceConfig } from './config.js';
import type { AgentConfigEntry } from './config.js';
import { AgentInstance } from './agent-instance.js';
import { pickAdapter } from './adapters/factory.js';
import { scanRuntimes, scanAgentOSAgents, scanLocalAgents, collectSystemInfo, type SystemInfo } from './scanner.js';
import { syncWorkspaceArtifacts } from './workspace-sync.js';

type ScannedAgent = { name: string; category: string; adapterKind: string; command: string; args: string[]; cwd?: string; source: string };
type RuntimeMeta = { name: string; adapterKind: string; command: string; installed: boolean };
type ScanPayload = { agents: ScannedAgent[]; runtimes: RuntimeMeta[] };
type CustomDispatchAgent = {
  id: string;
  name: string;
  role?: string | null;
  adapterKind: AgentConfigEntry['adapter']['kind'];
  command: string;
  args?: string[] | null;
  cwd?: string | null;
  description?: string | null;
  category?: string | null;
};

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== '{}') return serialized;
  } catch {}
  return 'unknown error';
}

function agentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function scannedAgentId(deviceId: string, name: string): string {
  return `scan-${deviceId}-${agentSlug(name)}`;
}

const CACHE_DIR = join(homedir(), '.agentbean');
const CACHE_FILE = join(CACHE_DIR, 'scanned-agents.json');

function isRuntimeEntry(entry: ScannedAgent): boolean {
  return entry.category === 'executor-hosted' &&
    ['codex', 'claude-code', 'kimi-cli', 'Kimi-cli'].includes(entry.adapterKind);
}

function splitLegacyCache(entries: ScannedAgent[]): ScanPayload {
  const agents: ScannedAgent[] = [];
  const runtimes: RuntimeMeta[] = [];
  for (const entry of entries) {
    if (isRuntimeEntry(entry)) {
      runtimes.push({
        name: entry.name,
        adapterKind: entry.adapterKind,
        command: entry.command,
        installed: Boolean(entry.command),
      });
    } else {
      agents.push(entry);
    }
  }
  return { agents, runtimes };
}

function loadCache(): ScanPayload | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as ScanPayload | ScannedAgent[];
    if (Array.isArray(parsed)) return splitLegacyCache(parsed);
    return {
      agents: parsed.agents ?? [],
      runtimes: parsed.runtimes ?? [],
    };
  } catch {
    return null;
  }
}

function saveCache(payload: ScanPayload): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'failed to save scan cache');
  }
}

export interface DeviceDaemonHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function scanAll(): Promise<ScanPayload> {
  const [runtimes, agentos, local] = await Promise.all([
    scanRuntimes(),
    scanAgentOSAgents(),
    scanLocalAgents(),
  ]);

  const agents: ScannedAgent[] = [];
  const runtimeResults = runtimes.filter((rt) => rt.installed);

  // AgentOS + standalone (from gateway and filesystem scans)
  const seen = new Set<string>();
  for (const ag of agentos) {
    if (!seen.has(ag.command)) {
      seen.add(ag.command);
      agents.push({ ...ag, source: 'scanned' });
    }
  }
  for (const ag of local) {
    if (!seen.has(ag.command)) {
      seen.add(ag.command);
      agents.push({ ...ag, source: 'scanned' });
    }
  }

  return { agents, runtimes: runtimeResults };
}

export function createDeviceDaemon(
  cfg: DeviceConfig,
  agents: Map<string, AgentInstance>,
): DeviceDaemonHandle {
  let socket: Socket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let rescanTimer: NodeJS.Timeout | null = null;
  let workspaceSyncTimer: NodeJS.Timeout | null = null;
  const RESCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const WORKSPACE_SYNC_INTERVAL_MS = 2 * 60 * 1000;
  const queues = new Map<string, Promise<unknown>>();
  const httpBase = cfg.server.url.replace(/\/agent$/, '');
  let firstConnect = true;
  const systemInfo = collectSystemInfo();

  const publicAgents = Array.from(agents.values())
    .filter((a) => a.visibility === 'public')
    .map((a) => a.publicMeta);

  function emitRegister(sock: Socket, payload: ScanPayload) {
    if (payload.runtimes.length > 0) {
      sock.emit('device:register-runtimes', { runtimes: payload.runtimes }, (ack: any) => {
        if (!ack?.ok) logger.warn({ error: ack?.error }, 'failed to register runtimes');
      });
    }
    if (payload.agents.length === 0) return;
    for (const ag of payload.agents) {
      const id = scannedAgentId(cfg.deviceId, ag.name);
      if (agents.has(id)) continue;
      const entry: AgentConfigEntry = {
        id,
        name: ag.name,
        role: ag.category === 'executor-hosted' ? 'executor-agent' : 'gateway-agent',
        category: ag.category as AgentConfigEntry['category'],
        adapter: {
          kind: ag.adapterKind as AgentConfigEntry['adapter']['kind'],
          command: ag.command,
          args: ag.args ?? [],
          cwd: ag.cwd,
        },
        visibility: 'public',
      };
      try {
        agents.set(id, new AgentInstance(entry, pickAdapter(entry.adapter)));
        logger.info({ id, kind: entry.adapter.kind }, 'scanned agent instance created');
      } catch (err: unknown) {
        logger.warn({ id, err: errorMessage(err) }, 'failed to create scanned agent instance');
      }
    }
    sock.emit('device:register-agents', { agents: payload.agents }, (ack: any) => {
      if (ack?.ok) {
        logger.info({ count: ack.agents?.length }, 'scanned agents registered');
      } else {
        logger.warn({ error: ack?.error }, 'failed to register scanned agents');
      }
    });
  }

  async function scanAndRegister(sock: Socket, useCache: boolean) {
    if (useCache) {
      const cached = loadCache();
      if (cached) {
        logger.info({ count: cached.agents.length + cached.runtimes.length }, 'using cached scan results');
        emitRegister(sock, cached);
        // Background refresh — only emit if results differ
        scanAll().then((fresh) => {
          saveCache(fresh);
          const cachedKey = JSON.stringify([
            ...cached.agents.map((a) => a.command),
            ...cached.runtimes.map((rt) => rt.command),
          ].sort());
          const freshKey = JSON.stringify([
            ...fresh.agents.map((a) => a.command),
            ...fresh.runtimes.map((rt) => rt.command),
          ].sort());
          if (cachedKey !== freshKey) {
            logger.info({ count: fresh.agents.length + fresh.runtimes.length }, 'scan results changed, updating');
            emitRegister(sock, fresh);
          }
        }).catch((err: any) => {
          logger.warn({ err: err?.message }, 'background scan failed');
        });
        return;
      }
    }
    // Full scan (no cache or cache miss)
    try {
      const scanned = await scanAll();
      saveCache(scanned);
      emitRegister(sock, scanned);
    } catch (err: any) {
      logger.error({ err: err?.message }, 'scan failed');
    }
  }

  return {
    async start() {
      const agentUrl = cfg.server.url.endsWith('/agent') ? cfg.server.url : cfg.server.url + '/agent';
      socket = io(agentUrl, {
        auth: {
          token: cfg.server.token,
          deviceId: cfg.deviceId,
          networkId: cfg.networkId,
          agents: publicAgents,
          systemInfo,
          capabilities: {
            customAgentDispatch: true,
          },
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1_000,
      });

      socket.on('connect', () => {
        const reconnecting = !firstConnect;
        firstConnect = false;
        logger.info({ deviceId: cfg.deviceId, sid: socket!.id, reconnecting }, 'device daemon connected');
        socket!.emit('register');

        // Reconnect: skip scan entirely (server already has our agents)
        // First connect: use cache if available, otherwise full scan
        if (!reconnecting) {
          scanAndRegister(socket!, true);
        }

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          socket?.emit('heartbeat');
        }, cfg.heartbeatIntervalMs);

        // Periodic re-scan to update agent availability
        if (rescanTimer) clearInterval(rescanTimer);
        rescanTimer = setInterval(() => {
          if (!socket?.connected) return;
          scanAndRegister(socket, false);
        }, RESCAN_INTERVAL_MS);

        syncWorkspaceArtifacts({ serverUrl: httpBase, token: cfg.server.token, networkId: cfg.networkId });
        if (workspaceSyncTimer) clearInterval(workspaceSyncTimer);
        workspaceSyncTimer = setInterval(() => {
          if (!socket?.connected) return;
          syncWorkspaceArtifacts({ serverUrl: httpBase, token: cfg.server.token, networkId: cfg.networkId });
        }, WORKSPACE_SYNC_INTERVAL_MS);
      });

      socket.on('connect_error', (err) => {
        logger.error({ err: err.message }, 'connect_error');
      });

      socket.on('dispatch', (req: {
        agentId: string;
        requestId: string;
        channelId: string;
        prompt: string;
        sandboxed?: boolean;
        networkId?: string;
        teamId?: string;
        teamName?: string;
        customAgent?: CustomDispatchAgent;
        history?: Parameters<AgentInstance['handleDispatch']>[0]['req']['history'];
      }) => {
        let agent = agents.get(req.agentId);
        if (!agent && req.customAgent) {
          const custom = req.customAgent;
          const entry: AgentConfigEntry = {
            id: custom.id,
            name: custom.name,
            role: custom.role ?? 'executor-agent',
            category: 'executor-hosted',
            adapter: {
              kind: custom.adapterKind,
              command: custom.command,
              args: custom.args ?? [],
              cwd: custom.cwd ?? undefined,
              workspace: custom.cwd ?? undefined,
              systemPrompt: custom.description ?? undefined,
            },
            visibility: 'public',
          };
          try {
            agent = new AgentInstance(entry, pickAdapter(entry.adapter));
            agents.set(req.agentId, agent);
            logger.info({ agentId: req.agentId, kind: entry.adapter.kind, cwd: entry.adapter.cwd }, 'custom agent instance created for dispatch');
          } catch (err: unknown) {
            logger.warn({ agentId: req.agentId, err: errorMessage(err) }, 'failed to create custom dispatch agent');
          }
        }
        if (!agent) {
          logger.warn({ agentId: req.agentId, requestId: req.requestId }, 'dispatch for unknown agent');
          socket?.emit('error_event', {
            agentId: req.agentId,
            at: Date.now(),
            message: `agent ${req.agentId} not found on this device`,
            scope: 'dispatch',
            requestId: req.requestId,
          });
          return;
        }

        // Serialize dispatches per agent to avoid concurrent adapter usage
        const currentSocket = socket;
        if (!currentSocket) {
          logger.warn({ agentId: req.agentId, requestId: req.requestId }, 'dispatch received but socket is null');
          return;
        }
        const prev = queues.get(req.agentId) ?? Promise.resolve();
        const next = prev.then(async () => {
          await agent.handleDispatch({
            socket: currentSocket,
            req,
            serverUrl: httpBase,
            token: cfg.server.token,
            networkId: req.teamId ?? req.networkId ?? cfg.networkId,
            deviceId: cfg.deviceId,
          });
        }).catch((err: unknown) => {
          const message = errorMessage(err);
          logger.error({ err: message, agentId: req.agentId }, 'dispatch queue error');
          currentSocket.emit('error_event', {
            agentId: req.agentId,
            at: Date.now(),
            message,
            scope: 'reply',
            requestId: req.requestId,
          });
        });
        queues.set(req.agentId, next);
      });

      socket.on('agents:discover', async () => {
        await scanAndRegister(socket!, false);
      });

      socket.on('disconnect', (reason) => {
        logger.warn({ reason }, 'device daemon disconnected');
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
        if (workspaceSyncTimer) { clearInterval(workspaceSyncTimer); workspaceSyncTimer = null; }
      });
    },

    async stop() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
      if (workspaceSyncTimer) { clearInterval(workspaceSyncTimer); workspaceSyncTimer = null; }
      socket?.close();
      socket = null;
    },
  };
}

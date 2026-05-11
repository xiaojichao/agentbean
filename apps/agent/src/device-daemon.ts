import { io, type Socket } from 'socket.io-client';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './log.js';
import type { DeviceConfig } from './config.js';
import { AgentInstance } from './agent-instance.js';
import { scanRuntimes, scanAgentOSAgents, scanLocalAgents, collectSystemInfo, type SystemInfo } from './scanner.js';

type ScannedAgent = { name: string; category: string; adapterKind: string; command: string; args: string[]; source: string };

const CACHE_DIR = join(homedir(), '.agentbean');
const CACHE_FILE = join(CACHE_DIR, 'scanned-agents.json');

function loadCache(): ScannedAgent[] | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as ScannedAgent[];
  } catch {
    return null;
  }
}

function saveCache(agents: ScannedAgent[]): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(agents, null, 2));
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'failed to save scan cache');
  }
}

export interface DeviceDaemonHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function scanAll(): Promise<ScannedAgent[]> {
  const [runtimes, agentos, local] = await Promise.all([
    scanRuntimes(),
    scanAgentOSAgents(),
    scanLocalAgents(),
  ]);

  const results: ScannedAgent[] = [];

  // Runtimes (executor-hosted) — only installed ones
  for (const rt of runtimes) {
    if (rt.installed) {
      results.push({
        name: rt.name,
        category: 'executor-hosted',
        adapterKind: rt.adapterKind,
        command: rt.command,
        args: [],
        source: 'scanned',
      });
    }
  }

  // AgentOS + standalone (from gateway and filesystem scans)
  const seen = new Set<string>();
  for (const ag of agentos) {
    if (!seen.has(ag.command)) {
      seen.add(ag.command);
      results.push({ ...ag, source: 'scanned' });
    }
  }
  for (const ag of local) {
    if (!seen.has(ag.command)) {
      seen.add(ag.command);
      results.push({ ...ag, source: 'scanned' });
    }
  }

  return results;
}

export function createDeviceDaemon(
  cfg: DeviceConfig,
  agents: Map<string, AgentInstance>,
): DeviceDaemonHandle {
  let socket: Socket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const queues = new Map<string, Promise<unknown>>();
  const httpBase = cfg.server.url.replace(/\/agent$/, '');
  let firstConnect = true;
  const systemInfo = collectSystemInfo();

  const publicAgents = Array.from(agents.values())
    .filter((a) => a.visibility === 'public')
    .map((a) => a.publicMeta);

  function emitRegister(sock: Socket, scanned: ScannedAgent[]) {
    if (scanned.length === 0) return;
    sock.emit('device:register-agents', { agents: scanned }, (ack: any) => {
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
        logger.info({ count: cached.length }, 'using cached scan results');
        emitRegister(sock, cached);
        // Background refresh — only emit if results differ
        scanAll().then((fresh) => {
          saveCache(fresh);
          const cachedKey = JSON.stringify(cached.map((a) => a.command).sort());
          const freshKey = JSON.stringify(fresh.map((a) => a.command).sort());
          if (cachedKey !== freshKey) {
            logger.info({ count: fresh.length }, 'scan results changed, updating');
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
        history?: Parameters<AgentInstance['handleDispatch']>[0]['req']['history'];
      }) => {
        const agent = agents.get(req.agentId);
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
            networkId: cfg.networkId,
          });
        }).catch((err: any) => {
          logger.error({ err: err?.message, agentId: req.agentId }, 'dispatch queue error');
          currentSocket.emit('error_event', {
            agentId: req.agentId,
            at: Date.now(),
            message: err?.message ?? 'unknown',
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
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      });
    },

    async stop() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}

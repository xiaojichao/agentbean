import { io, type Socket } from 'socket.io-client';
import { logger } from './log.js';
import type { DeviceConfig } from './config.js';
import { AgentInstance } from './agent-instance.js';
import { scanRuntimes, scanAgentOSAgents, scanLocalAgents } from './scanner.js';

export interface DeviceDaemonHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function scanAll(): Promise<{ name: string; category: string; adapterKind: string; command: string; args: string[]; source: string }[]> {
  const [runtimes, agentos, local] = await Promise.all([
    scanRuntimes(),
    scanAgentOSAgents(),
    scanLocalAgents(),
  ]);

  const results: { name: string; category: string; adapterKind: string; command: string; args: string[]; source: string }[] = [];

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

  const publicAgents = Array.from(agents.values())
    .filter((a) => a.visibility === 'public')
    .map((a) => a.publicMeta);

  async function scanAndRegister(sock: Socket) {
    try {
      const scanned = await scanAll();
      if (scanned.length === 0) return;
      sock.emit('device:register-agents', { agents: scanned }, (ack: any) => {
        if (ack?.ok) {
          logger.info({ count: ack.agents?.length }, 'scanned agents registered');
        } else {
          logger.warn({ error: ack?.error }, 'failed to register scanned agents');
        }
      });
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
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1_000,
      });

      socket.on('connect', () => {
        logger.info({ deviceId: cfg.deviceId, sid: socket!.id }, 'device daemon connected');
        socket!.emit('register');

        // Auto-scan and register all discovered agents/runtimes
        scanAndRegister(socket!);

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
        await scanAndRegister(socket!);
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

import { io, type Socket } from 'socket.io-client';
import { logger } from './log.js';
import type { AgentConfig } from './config.js';
import type { CliAdapter, ChatTurn } from './adapters/adapter.js';
import { uploadArtifact } from './uploader.js';
import { postProcess } from './post-process.js';

export interface ConnectionHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createConnection(cfg: AgentConfig, adapter: CliAdapter): ConnectionHandle {
  let socket: Socket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  return {
    async start() {
      socket = io(cfg.server.url, {
        auth: {
          token: cfg.server.token,
          agentId: cfg.id,
          name: cfg.name,
          role: cfg.role,
          adapterKind: cfg.adapter.kind,
        },
        reconnection: true,
        reconnectionDelay: 1_000,
      });

      socket.on('connect', () => {
        logger.info({ id: cfg.id }, 'connected to server');
        socket!.emit('register', {
          id: cfg.id, name: cfg.name, role: cfg.role,
          adapterKind: cfg.adapter.kind,
        });
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          socket?.emit('heartbeat', { at: Date.now() });
        }, cfg.heartbeatIntervalMs);
      });

      socket.on('connect_error', (err) => {
        logger.error({ err: err.message }, 'connect_error');
      });

      socket.on('dispatch', (req: {
        requestId: string;
        channelId: string;
        prompt: string;
        history?: ChatTurn[];
      }) => {
        const currentSocket = socket;
        if (!currentSocket) {
          logger.warn({ requestId: req.requestId }, 'dispatch received but socket is null');
          return;
        }
        queue = queue.then(async () => {
          const ctl = new AbortController();
          const dispatchStart = Date.now();
          try {
            const rawBody = await adapter.ask({
              prompt: req.prompt,
              history: req.history ?? [],
              systemPrompt: cfg.adapter.systemPrompt,
              workspace: cfg.adapter.workspace,
            }, ctl.signal);
            const processed = await postProcess(rawBody, cfg.adapter.workspace, cfg.adapter.kind, dispatchStart);

            const artifactIds: string[] = [];
            if (processed.outputFiles.length > 0) {
              const httpBase = cfg.server.url.replace(/\/agent$/, '');
              for (const filePath of processed.outputFiles) {
                try {
                  const result = await uploadArtifact({
                    serverUrl: httpBase,
                    token: cfg.server.token,
                    networkId: 'default',
                    filePath,
                    channelId: req.channelId,
                    uploaderId: cfg.id,
                  });
                  if (result) artifactIds.push(result.id);
                } catch (err: any) {
                  logger.warn({ err: err.message, filePath }, 'artifact upload failed');
                }
              }
            }

            currentSocket.emit('reply', {
              channelId: req.channelId,
              body: processed.replyText,
              requestId: req.requestId,
              artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
            });
          } catch (err: any) {
            logger.error({ err: err.message, requestId: req.requestId }, 'dispatch failed');
            currentSocket.emit('error_event', {
              at: Date.now(),
              message: err.message ?? 'unknown',
              scope: 'reply',
              requestId: req.requestId,
            });
          }
        }).catch((err: any) => {
          logger.error({ err: err?.message, requestId: req.requestId }, 'dispatch queue error');
        });
      });

      socket.on('disconnect', (reason) => {
        logger.warn({ reason }, 'disconnected');
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      });
    },
    async stop() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      socket?.close();
      socket = null;
    },
  };
}

import { io, type Socket } from 'socket.io-client';
import { logger } from './log.js';
import type { AgentConfig } from './config.js';
import type { CliAdapter, ChatTurn } from './adapters/adapter.js';
import { uploadArtifact } from './uploader.js';
import { postProcess } from './post-process.js';
import {
  archiveOutputFiles,
  beginAgentWorkspaceRun,
  finishAgentWorkspaceRun,
  workspaceEnv,
  type ArchivedWorkspaceFile,
} from './workspace-manager.js';

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== '{}') return serialized;
  } catch {}
  return 'unknown error';
}

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
      const agentUrl = cfg.server.url.endsWith('/agent') ? cfg.server.url : cfg.server.url + '/agent';
      socket = io(agentUrl, {
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
          const teamId = 'default';
          const run = beginAgentWorkspaceRun({
            teamId,
            agentId: cfg.id,
            agentName: cfg.name,
            runId: req.requestId,
            prompt: req.prompt,
            projectDir: cfg.adapter.workspace,
          });
          let archivedFiles: ArchivedWorkspaceFile[] = [];
          try {
            const rawBody = await adapter.ask({
              prompt: req.prompt,
              history: req.history ?? [],
              systemPrompt: cfg.adapter.systemPrompt,
              workspace: cfg.adapter.workspace,
              env: workspaceEnv(run),
            }, ctl.signal);
            const processed = await postProcess(rawBody, cfg.adapter.workspace, cfg.adapter.kind, dispatchStart, {
              outputDirs: [run.outputDir, run.intermediateDir],
            });
            archivedFiles = archiveOutputFiles(run, processed.outputFiles);
            finishAgentWorkspaceRun(run, { replyText: processed.replyText, files: archivedFiles, status: 'completed' });

            const artifactIds: string[] = [];
            if (archivedFiles.length > 0) {
              const httpBase = cfg.server.url.replace(/\/agent$/, '');
              for (const file of archivedFiles) {
                try {
                  const result = await uploadArtifact({
                    serverUrl: httpBase,
                    token: cfg.server.token,
                    networkId: teamId,
                    filePath: file.archivedPath,
                    channelId: req.channelId,
                    uploaderId: cfg.id,
                    metaJson: JSON.stringify({
                      kind: 'agent-workspace-file',
                      teamId,
                      agentId: cfg.id,
                      runId: req.requestId,
                      pathKind: file.pathKind,
                      relativePath: file.relativePath,
                      originalPath: file.originalPath,
                      sha256: file.sha256,
                    }),
                  });
                  if (result) artifactIds.push(result.id);
                } catch (err: any) {
                  logger.warn({ err: err.message, filePath: file.archivedPath }, 'artifact upload failed');
                }
              }
            }

            currentSocket.emit('reply', {
              channelId: req.channelId,
              body: processed.replyText,
              requestId: req.requestId,
              artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
            });
          } catch (err: unknown) {
            const message = errorMessage(err);
            finishAgentWorkspaceRun(run, { files: archivedFiles, status: 'failed', error: message });
            logger.error({ err: message, requestId: req.requestId }, 'dispatch failed');
            currentSocket.emit('error_event', {
              at: Date.now(),
              message,
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

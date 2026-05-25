import { io, type Socket } from 'socket.io-client';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { logger } from './log.js';
import type { AgentConfig } from './config.js';
import type { CliAdapter, ChatTurn } from './adapters/adapter.js';
import { uploadArtifact } from './uploader.js';
import { postProcess } from './post-process.js';
import {
  archiveOutputFiles,
  beginAgentWorkspaceRun,
  finishAgentWorkspaceRun,
  formatWorkspaceReply,
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

interface DispatchAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
  previewUrl: string;
}

function safeFilename(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'attachment';
}

async function downloadAttachments(input: {
  serverUrl: string;
  token: string;
  run: ReturnType<typeof beginAgentWorkspaceRun>;
  attachments?: DispatchAttachment[];
}): Promise<Array<DispatchAttachment & { localPath: string }>> {
  const downloaded: Array<DispatchAttachment & { localPath: string }> = [];
  for (const attachment of input.attachments ?? []) {
    const sep = attachment.downloadUrl.includes('?') ? '&' : '?';
    const url = `${input.serverUrl}${attachment.downloadUrl}${sep}token=${encodeURIComponent(input.token)}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        logger.warn({ id: attachment.id, status: resp.status }, 'attachment download rejected');
        continue;
      }
      const localPath = join(input.run.inputDir, `${attachment.id}-${safeFilename(attachment.filename)}`);
      writeFileSync(localPath, Buffer.from(await resp.arrayBuffer()));
      downloaded.push({ ...attachment, localPath });
    } catch (err: any) {
      logger.warn({ id: attachment.id, err: err?.message }, 'attachment download failed');
    }
  }
  return downloaded;
}

function promptWithAttachments(prompt: string, attachments: Array<DispatchAttachment & { localPath: string }>): string {
  if (attachments.length === 0) return prompt;
  const list = attachments
    .map((file) => `- ${file.filename} (${file.mimeType}, ${file.sizeBytes} bytes): ${file.localPath}`)
    .join('\n');
  return `${prompt}\n\n用户随消息附加了以下本地文件，请在需要时读取并使用：\n${list}`;
}

function promptWithWorkspaceOutput(prompt: string, outputDir: string): string {
  return `${prompt}\n\n如果本次任务会生成图片、文档、数据或其他文件，请把最终产物保存到这个 AgentBean 输出目录：\n${outputDir}\n保存后在回复中说明文件名即可，系统会自动同步并在聊天中展示预览。`;
}

export interface ConnectionHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createConnection(cfg: AgentConfig, adapter: CliAdapter): ConnectionHandle {
  let socket: Socket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const activeControllers = new Map<string, AbortController>();

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
        attachments?: DispatchAttachment[];
      }) => {
        const currentSocket = socket;
        if (!currentSocket) {
          logger.warn({ requestId: req.requestId }, 'dispatch received but socket is null');
          return;
        }
        queue = queue.then(async () => {
          const ctl = new AbortController();
          activeControllers.set(req.requestId, ctl);
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
            const httpBase = cfg.server.url.replace(/\/agent$/, '');
            const downloadedAttachments = await downloadAttachments({
              serverUrl: httpBase,
              token: cfg.server.token,
              run,
              attachments: req.attachments,
            });
            const prompt = promptWithWorkspaceOutput(promptWithAttachments(req.prompt, downloadedAttachments), run.outputDir);
            const rawBody = await adapter.ask({
              prompt,
              history: req.history ?? [],
              systemPrompt: cfg.adapter.systemPrompt,
              workspace: cfg.adapter.workspace,
              env: workspaceEnv(run),
            }, ctl.signal);
            const processed = await postProcess(rawBody, cfg.adapter.workspace, cfg.adapter.kind, dispatchStart, {
              outputDirs: [run.outputDir, run.intermediateDir],
            });
            archivedFiles = archiveOutputFiles(run, processed.outputFiles);
            const replyText = formatWorkspaceReply(rawBody, archivedFiles, { exposeLocalPaths: false });
            finishAgentWorkspaceRun(run, { replyText, files: archivedFiles, status: 'completed' });

            const artifactIds: string[] = [];
            if (archivedFiles.length > 0) {
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
              body: replyText,
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
          } finally {
            activeControllers.delete(req.requestId);
          }
        }).catch((err: any) => {
          logger.error({ err: err?.message, requestId: req.requestId }, 'dispatch queue error');
        });
      });

      socket.on('dispatch:cancel', (payload: { requestId?: string; reason?: string }) => {
        const entries = payload.requestId
          ? [...activeControllers.entries()].filter(([id]) => id === payload.requestId)
          : [...activeControllers.entries()];
        for (const [, ctl] of entries) ctl.abort();
        logger.info({ requestId: payload.requestId, cancelled: entries.length, reason: payload.reason }, 'dispatch cancel requested');
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

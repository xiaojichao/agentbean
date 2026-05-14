import type { Socket } from 'socket.io-client';
import { logger } from './log.js';
import type { AgentConfigEntry } from './config.js';
import type { CliAdapter, ChatTurn } from './adapters/adapter.js';
import { uploadArtifact } from './uploader.js';
import { postProcess } from './post-process.js';
import { generateSandboxProfile, getWorkspaceDir, isSandboxAvailable } from './sandbox.js';

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== '{}') return serialized;
  } catch {}
  return 'unknown error';
}

export class AgentInstance {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly visibility: 'public' | 'private';

  constructor(
    public readonly config: AgentConfigEntry,
    public readonly adapter: CliAdapter,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.role = config.role;
    this.visibility = config.visibility;
  }

  get publicMeta() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      category: this.config.category ?? 'executor-hosted',
      adapterKind: this.adapter.kind,
      visibility: this.visibility,
    };
  }

  async handleDispatch(opts: {
    socket: Socket;
    req: {
      requestId: string;
      channelId: string;
      prompt: string;
      history?: ChatTurn[];
      sandboxed?: boolean;
    };
    serverUrl: string;
    token: string;
    networkId: string;
  }): Promise<void> {
    const { socket, req, serverUrl, token, networkId } = opts;
    const ctl = new AbortController();
    const dispatchStart = Date.now();
    try {
      const rawBody = await this.adapter.ask({
        prompt: req.prompt,
        history: req.history ?? [],
        systemPrompt: this.config.adapter.systemPrompt,
        workspace: req.sandboxed ? getWorkspaceDir(this.id) : this.config.adapter.workspace,
        sandboxProfilePath: req.sandboxed && isSandboxAvailable()
          ? generateSandboxProfile(this.id, this.config.adapter.command)
          : undefined,
      }, ctl.signal);
      const processed = await postProcess(rawBody, req.sandboxed ? getWorkspaceDir(this.id) : this.config.adapter.workspace, this.adapter.kind, dispatchStart);

      const artifactIds: string[] = [];
      if (processed.outputFiles.length > 0) {
        for (const filePath of processed.outputFiles) {
          try {
            const result = await uploadArtifact({
              serverUrl,
              token,
              networkId,
              filePath,
              channelId: req.channelId,
              uploaderId: this.id,
            });
            if (result) artifactIds.push(result.id);
          } catch (err: any) {
            logger.warn({ err: err.message, filePath }, 'artifact upload failed');
          }
        }
      }

      socket.emit('reply', {
        agentId: this.id,
        channelId: req.channelId,
        body: processed.replyText,
        requestId: req.requestId,
        artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
      });
    } catch (err: unknown) {
      const message = errorMessage(err);
      logger.error({ err: message, requestId: req.requestId, agentId: this.id }, 'dispatch failed');
      socket.emit('error_event', {
        agentId: this.id,
        at: Date.now(),
        message,
        scope: 'reply',
        requestId: req.requestId,
      });
    }
  }
}

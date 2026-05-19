import type { Socket } from 'socket.io-client';
import { logger } from './log.js';
import type { AgentConfigEntry } from './config.js';
import type { CliAdapter, ChatTurn } from './adapters/adapter.js';
import { uploadArtifact } from './uploader.js';
import { postProcess } from './post-process.js';
import { generateSandboxProfile, getWorkspaceDir, isSandboxAvailable } from './sandbox.js';
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
      networkId?: string;
      teamId?: string;
      teamName?: string;
    };
    serverUrl: string;
    token: string;
    networkId: string;
    deviceId?: string;
  }): Promise<void> {
    const { socket, req, serverUrl, token, networkId, deviceId } = opts;
    const ctl = new AbortController();
    const dispatchStart = Date.now();
    const teamId = req.teamId ?? req.networkId ?? networkId;
    const projectWorkspace = req.sandboxed ? getWorkspaceDir(this.id) : this.config.adapter.workspace;
    const run = beginAgentWorkspaceRun({
      teamId,
      teamName: req.teamName,
      agentId: this.id,
      agentName: this.name,
      runId: req.requestId,
      prompt: req.prompt,
      projectDir: projectWorkspace,
    });
    let archivedFiles: ArchivedWorkspaceFile[] = [];
    try {
      const rawBody = await this.adapter.ask({
        prompt: req.prompt,
        history: req.history ?? [],
        systemPrompt: this.config.adapter.systemPrompt,
        workspace: projectWorkspace,
        sandboxProfilePath: req.sandboxed && isSandboxAvailable()
          ? generateSandboxProfile(this.id, this.config.adapter.command)
          : undefined,
        env: workspaceEnv(run),
      }, ctl.signal);
      const processed = await postProcess(rawBody, projectWorkspace, this.adapter.kind, dispatchStart, {
        outputDirs: [run.outputDir, run.intermediateDir],
      });
      archivedFiles = archiveOutputFiles(run, processed.outputFiles);
      finishAgentWorkspaceRun(run, { replyText: processed.replyText, files: archivedFiles, status: 'completed' });

      const artifactIds: string[] = [];
      if (archivedFiles.length > 0) {
        for (const file of archivedFiles) {
          try {
            const result = await uploadArtifact({
              serverUrl,
              token,
              networkId: teamId,
              filePath: file.archivedPath,
              channelId: req.channelId,
              uploaderId: this.id,
              metaJson: JSON.stringify({
                kind: 'agent-workspace-file',
                teamId,
                agentId: this.id,
                runId: req.requestId,
                deviceId: deviceId ?? null,
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

      socket.emit('reply', {
        agentId: this.id,
        channelId: req.channelId,
        body: processed.replyText,
        requestId: req.requestId,
        artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
      });
    } catch (err: unknown) {
      const message = errorMessage(err);
      finishAgentWorkspaceRun(run, { files: archivedFiles, status: 'failed', error: message });
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

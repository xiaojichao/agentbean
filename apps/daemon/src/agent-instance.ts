import type { Socket } from 'socket.io-client';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
      const bytes = Buffer.from(await resp.arrayBuffer());
      const localPath = join(input.run.inputDir, `${attachment.id}-${safeFilename(attachment.filename)}`);
      writeFileSync(localPath, bytes);
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

export class AgentInstance {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly visibility: 'public' | 'private';
  private readonly activeControllers = new Map<string, AbortController>();

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
      attachments?: DispatchAttachment[];
    };
    serverUrl: string;
    token: string;
    networkId: string;
    deviceId?: string;
  }): Promise<void> {
    const { socket, req, serverUrl, token, networkId, deviceId } = opts;
    const ctl = new AbortController();
    this.activeControllers.set(req.requestId, ctl);
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
      const downloadedAttachments = await downloadAttachments({ serverUrl, token, run, attachments: req.attachments });
      const prompt = promptWithWorkspaceOutput(promptWithAttachments(req.prompt, downloadedAttachments), run.outputDir);
      const rawBody = await this.adapter.ask({
        prompt,
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
      const replyText = formatWorkspaceReply(rawBody, archivedFiles, { exposeLocalPaths: false });
      finishAgentWorkspaceRun(run, { replyText, files: archivedFiles, status: 'completed' });

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
        body: replyText,
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
    } finally {
      this.activeControllers.delete(req.requestId);
    }
  }

  cancelDispatch(requestId?: string): number {
    const entries = requestId
      ? [...this.activeControllers.entries()].filter(([id]) => id === requestId)
      : [...this.activeControllers.entries()];
    for (const [, ctl] of entries) ctl.abort();
    return entries.length;
  }
}

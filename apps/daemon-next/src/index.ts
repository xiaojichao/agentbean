import { AGENT_EVENTS, type AgentCategory, type ArtifactPathKind, type DispatchCustomAgentDto, type DispatchHistoryMessageDto, type WorkspaceRunStatus } from '../../../packages/contracts/src/index.js';
import type { DispatchAttachment } from './attachments.js';
import { downloadAttachments } from './attachments.js';
import { prepareWorkspaceRun, workspaceRunEnv, persistWorkspaceRunManifest, persistWorkspaceRunResponse } from './workspace-run.js';
import { collectArtifacts } from './artifact-collector.js';
import { uploadArtifacts } from './artifact-uploader.js';

export { createBuiltinScanProvider, scanBuiltinRuntimeAgents } from './scanner.js';
export type { BuiltinScannerOptions } from './scanner.js';
export { createCommandExecutor } from './executor.js';
export type { CommandExecutorOptions } from './executor.js';
export { downloadAttachments } from './attachments.js';
export type { DispatchAttachment, DownloadedAttachment } from './attachments.js';
export { prepareWorkspaceRun, workspaceRunEnv, persistWorkspaceRunManifest, persistWorkspaceRunResponse } from './workspace-run.js';
export type { WorkspaceRunDir, WorkspaceRunManifest } from './workspace-run.js';
export { collectArtifacts } from './artifact-collector.js';
export type { CollectedArtifact } from './artifact-collector.js';
export { uploadArtifacts } from './artifact-uploader.js';
export type { UploadedArtifact } from './artifact-uploader.js';
export { createHttpEnvResolver } from './env-fetcher.js';
import { createRescanController, type RescanController } from './rescan.js';
import { saveScanCache } from './scan-cache.js';

export interface DaemonProtocolSocket {
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => Promise<void>): void;
  off?(event: string, handler: (payload: unknown) => Promise<void>): void;
  onReconnect?(handler: () => Promise<void>): void;
}

export interface DaemonWorkspaceRunResult {
  status?: WorkspaceRunStatus;
  cwd?: string;
  command?: string;
  logExcerpt?: string;
  exitCode?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface DaemonDispatchArtifactResult {
  id: string;
  filename: string;
  mimeType?: string;
  relativePath?: string;
  pathKind?: ArtifactPathKind;
  contentBase64?: string;
}

export interface DaemonDispatchResult {
  body: string;
  artifactIds?: string[];
  artifacts?: DaemonDispatchArtifactResult[];
  workspaceRun?: DaemonWorkspaceRunResult;
}

export type StubExecutor = (request: DispatchRequestPayload) => Promise<string | DaemonDispatchResult>;

export interface DaemonDeviceConfig {
  teamId: string;
  ownerId: string;
  token?: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  daemonVersion?: string;
  systemInfo?: import('../../../packages/contracts/src/index.js').DeviceDto['systemInfo'];
}

export interface DaemonRuntimeReport {
  adapterKind: string;
  name: string;
  command?: string;
  cwd?: string;
  version?: string;
  installed?: boolean;
}

export interface DaemonAgentReport {
  name: string;
  adapterKind: string;
  category: AgentCategory;
  gatewayInstanceKey?: string;
}

export interface DaemonScanSnapshot {
  runtimes: DaemonRuntimeReport[];
  agents: DaemonAgentReport[];
}

export type DaemonScanProvider = () => Promise<DaemonScanSnapshot>;

export type DaemonCustomAgent = DispatchCustomAgentDto & { env?: Record<string, string> };

export interface DispatchRequestPayload {
  id: string;
  teamId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  agentId: string;
  deviceId?: string;
  requestId: string;
  prompt: string;
  history?: DispatchHistoryMessageDto[];
  attachments?: DispatchAttachment[];
  customAgent?: DaemonCustomAgent | null;
}

export type AgentEnvResolver = (envRef: { agentId: string; teamId: string }) => Promise<Record<string, string>>;

export interface CreateDaemonProtocolClientInput {
  socket: DaemonProtocolSocket;
  executor: StubExecutor;
  device: DaemonDeviceConfig;
  runtimes: DaemonRuntimeReport[];
  agents: DaemonAgentReport[];
  scan?: DaemonScanProvider;
  serverUrl: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  envResolver?: AgentEnvResolver;
  rescanIntervalMs?: number;
}

export interface DaemonProtocolClient {
  start(): Promise<void>;
  rescanNow?(): Promise<void>;
  stop?(): void;
}

export function createDaemonProtocolClient(input: CreateDaemonProtocolClientInput): DaemonProtocolClient {
  const { socket, executor, device, runtimes, agents, scan, serverUrl, fetch: fetchFn, envResolver } = input;
  let currentDeviceId: string;
  let rescan: RescanController | undefined;

  return {
    async start() {
      const initialAnnouncement = await announceDeviceSnapshot(socket, device, runtimes, agents);
      currentDeviceId = initialAnnouncement.deviceId;
      if (initialAnnouncement.token) {
        device.token = initialAnnouncement.token;
      }
      const cancelledDispatchIds = new Set<string>();
      socket.onReconnect?.(async () => {
        const announcement = await announceDeviceSnapshot(socket, device, runtimes, agents);
        currentDeviceId = announcement.deviceId;
        if (announcement.token) {
          device.token = announcement.token;
        }
      });

      socket.on(AGENT_EVENTS.device.scanRequested, async (payload) => {
        const request = readScanRequest(payload);
        if (request.deviceId !== currentDeviceId) {
          return;
        }
        const snapshot = scan ? await scan() : { runtimes, agents };
        await reportDeviceSnapshot(socket, device.teamId, currentDeviceId, snapshot.runtimes, snapshot.agents);
      });

      socket.on(AGENT_EVENTS.dispatch.cancel, async (payload) => {
        cancelledDispatchIds.add(readDispatchCancel(payload).dispatchId);
      });

      socket.on(AGENT_EVENTS.dispatch.request, async (payload) => {
        const request = payload as DispatchRequestPayload;
        if (cancelledDispatchIds.delete(request.id)) {
          return;
        }
        try {
          if (request.customAgent?.envRef && !request.customAgent.env) {
            if (!envResolver) {
              throw new Error('Custom agent env resolver is not configured');
            }
            const env = await envResolver(request.customAgent.envRef);
            request.customAgent = { ...request.customAgent, env };
            if (cancelledDispatchIds.delete(request.id)) {
              return;
            }
          }

          // Per-run workspace + input attachments (only when customAgent.cwd is set).
          const workspace = request.customAgent?.cwd
            ? prepareWorkspaceRun(request.customAgent.cwd, request.id)
            : undefined;
          if (workspace && request.attachments?.length && device.token) {
            const downloaded = await downloadAttachments(
              { serverUrl, token: device.token, teamId: device.teamId, inputDir: workspace.inputDir, fetch: fetchFn },
              request.attachments,
            );
            if (downloaded.length > 0) {
              const list = downloaded
                .map((file) => `- ${file.name} (${file.mimeType ?? 'unknown'}, ${file.sizeBytes ?? 0} bytes): ${file.localPath}`)
                .join('\n');
              request.prompt = `${request.prompt}\n\n用户随消息附加了以下本地文件，请在需要时读取并使用：\n${list}`;
            }
          }
          if (workspace && request.customAgent) {
            request.customAgent = {
              ...request.customAgent,
              env: { ...(request.customAgent.env ?? {}), ...workspaceRunEnv(workspace) },
            };
          }
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
          const result = normalizeDispatchResult(await executor(request));
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }

          // Scan outputs + cwd fallback, upload, then merge with the executor's log artifact.
          let productArtifactIds: string[] = [];
          if (workspace && result.workspaceRun?.startedAt !== undefined) {
            const collected = await collectArtifacts({
              outputDir: workspace.outputDir,
              cwd: workspace.cwd,
              startedAt: result.workspaceRun.startedAt,
            });
            if (collected.length > 0 && device.token) {
              const uploaded = await uploadArtifacts(
                { serverUrl, token: device.token, teamId: device.teamId, channelId: request.channelId, fetch: fetchFn },
                collected,
              );
              productArtifactIds = uploaded.map((u) => u.id);
            }
            try {
              persistWorkspaceRunResponse(workspace, result.body);
              persistWorkspaceRunManifest(workspace, {
                runId: workspace.runId,
                status: result.workspaceRun.status,
                startedAt: result.workspaceRun.startedAt,
                completedAt: result.workspaceRun.completedAt,
                exitCode: result.workspaceRun.exitCode,
                files: collected.map((c) => ({
                  relativePath: c.relativePath,
                  sha256: c.sha256,
                  sizeBytes: c.sizeBytes,
                  filename: c.filename,
                })),
              });
            } catch {
              // manifest persistence is best-effort; never block the dispatch result
            }
          }

          const artifacts = result.artifacts ?? [];
          const artifactIds = [...(result.artifactIds ?? []), ...productArtifactIds];
          await socket.emitWithAck(AGENT_EVENTS.dispatch.result, {
            dispatchId: request.id,
            agentId: request.agentId,
            body: result.body,
            ...(artifactIds.length > 0 ? { artifactIds } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
            ...(result.workspaceRun ? { workspaceRun: result.workspaceRun } : {}),
          });
        } catch (error) {
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
          await socket.emitWithAck(AGENT_EVENTS.dispatch.error, {
            dispatchId: request.id,
            agentId: request.agentId,
            error: readErrorMessage(error),
          });
        }
      });

      if (scan) {
        rescan = createRescanController({
          scan,
          initial: { runtimes, agents },
          intervalMs: input.rescanIntervalMs,
          report: async (snap) => {
            await reportDeviceSnapshot(socket, device.teamId, currentDeviceId, snap.runtimes, snap.agents);
            saveScanCache(snap, device.profileId);
          },
        });
        rescan.start();
      }
    },
    rescanNow: () => rescan?.tickNow() ?? Promise.resolve(),
    stop: () => rescan?.stop(),
  };
}

function normalizeDispatchResult(result: string | DaemonDispatchResult): DaemonDispatchResult {
  if (typeof result === 'string') {
    return { body: result };
  }
  return result;
}

async function announceDeviceSnapshot(
  socket: DaemonProtocolSocket,
  device: DaemonDeviceConfig,
  runtimes: DaemonRuntimeReport[],
  agents: DaemonAgentReport[],
): Promise<{ deviceId: string; token?: string }> {
  const helloAck = await socket.emitWithAck(AGENT_EVENTS.device.hello, device);
  const deviceId = readAckDeviceId(helloAck);
  const token = readAckDeviceToken(helloAck);

  await reportDeviceSnapshot(socket, device.teamId, deviceId, runtimes, agents);
  return { deviceId, ...(token ? { token } : {}) };
}

async function reportDeviceSnapshot(
  socket: DaemonProtocolSocket,
  teamId: string,
  deviceId: string,
  runtimes: DaemonRuntimeReport[],
  agents: DaemonAgentReport[],
): Promise<void> {
  await socket.emitWithAck(AGENT_EVENTS.device.runtimes, {
    teamId,
    deviceId,
    runtimes,
  });
  await socket.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
    teamId,
    deviceId,
    agents,
  });
}

function readScanRequest(payload: unknown): { requestId: string; deviceId: string } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('device:scan-requested payload missing request');
  }
  const request = payload as { requestId?: unknown; deviceId?: unknown };
  if (typeof request.requestId !== 'string' || typeof request.deviceId !== 'string') {
    throw new Error('device:scan-requested payload missing request id or device id');
  }
  return { requestId: request.requestId, deviceId: request.deviceId };
}

function readAckDeviceId(ack: unknown): string {
  if (!ack || typeof ack !== 'object') {
    throw new Error('device:hello ack missing device');
  }
  const device = (ack as { device?: { id?: unknown } }).device;
  if (!device || typeof device.id !== 'string') {
    throw new Error('device:hello ack missing device id');
  }
  return device.id;
}

function readAckDeviceToken(ack: unknown): string | undefined {
  if (!ack || typeof ack !== 'object') {
    return undefined;
  }
  const credentials = (ack as { credentials?: unknown }).credentials;
  if (!credentials || typeof credentials !== 'object') {
    return undefined;
  }
  const token = (credentials as { token?: unknown }).token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return 'Dispatch executor failed';
}

function readDispatchCancel(payload: unknown): { dispatchId: string } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('dispatch:cancel payload missing dispatch id');
  }
  const dispatchId = (payload as { dispatchId?: unknown }).dispatchId;
  if (typeof dispatchId !== 'string') {
    throw new Error('dispatch:cancel payload missing dispatch id');
  }
  return { dispatchId };
}

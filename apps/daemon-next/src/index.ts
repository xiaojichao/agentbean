import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_EVENTS, type AgentCategory, type ArtifactPathKind, type DispatchCustomAgentDto, type DispatchHistoryMessageDto, type WorkspaceRunStatus } from '../../../packages/contracts/src/index.js';
import type { DispatchAttachment } from './attachments.js';
import { downloadAttachments } from './attachments.js';
import {
  discoverRecoverableWorkspaceRuns,
  markWorkspaceRunManifestReported,
  markWorkspaceRunReported,
  prepareWorkspaceRun,
  workspaceRunEnv,
  persistWorkspaceRunManifest,
  persistWorkspaceRunResponse,
} from './workspace-run.js';
import { collectArtifacts } from './artifact-collector.js';
import { uploadArtifacts } from './artifact-uploader.js';
import { selectNativeDirectory } from './directory-picker.js';
import { scanCustomAgentSkills } from './skill-scanner.js';

export { createBuiltinScanProvider, scanBuiltinRuntimeAgents } from './scanner.js';
export type { BuiltinScannerOptions } from './scanner.js';
export { createCommandExecutor } from './executor.js';
export type { CommandExecutorOptions } from './executor.js';
export { downloadAttachments } from './attachments.js';
export type { DispatchAttachment, DownloadedAttachment } from './attachments.js';
export {
  discoverRecoverableWorkspaceRuns,
  markWorkspaceRunManifestReported,
  markWorkspaceRunReported,
  prepareWorkspaceRun,
  workspaceRunEnv,
  persistWorkspaceRunManifest,
  persistWorkspaceRunResponse,
} from './workspace-run.js';
export type { RecoverableWorkspaceRun, WorkspaceRunDir, WorkspaceRunManifest } from './workspace-run.js';
export { collectArtifacts } from './artifact-collector.js';
export type { CollectedArtifact } from './artifact-collector.js';
export { uploadArtifacts } from './artifact-uploader.js';
export type { UploadedArtifact } from './artifact-uploader.js';
export { createHttpEnvResolver } from './env-fetcher.js';
import { createRescanController, type RescanController } from './rescan.js';
import { createDispatchOutbox, type DispatchOutbox } from './outbox.js';

export interface DaemonProtocolSocket {
  readonly connected: boolean;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void;
  off?(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void;
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
  command?: string;
  args?: string[];
  cwd?: string;
  discoverySource?: 'runtime' | 'gateway' | 'filesystem';
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
  claimRequired?: boolean;
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

export interface DaemonDeviceCredentialsUpdate {
  token: string;
  teamId?: string;
  ownerId?: string;
}

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
  sleep?(ms: number): Promise<void>;
  rescanIntervalMs?: number;
  /**
   * Home directory used for scanning custom-agent skills (e.g. ~/.claude/skills).
   * Defaults to os.homedir(); must match the value the runtime scanner uses.
   */
  homeDir?: string;
  onScanChanged?: (snapshot: DaemonScanSnapshot) => Promise<void> | void;
  onCredentialsChanged?: (credentials: DaemonDeviceCredentialsUpdate) => Promise<void> | void;
  /**
   * 服务端通知该设备已被删除时触发。cli 层据此关闭重连并退出进程，
   * 否则 daemon 会持续重连并通过 device.hello 把已删设备 upsert 复活。
   */
  onDeviceRemoved?: () => Promise<void> | void;
}

export interface DaemonProtocolClient {
  start(): Promise<void>;
  rescanNow?(): Promise<void>;
  stop?(): void;
}

export function createDaemonProtocolClient(input: CreateDaemonProtocolClientInput): DaemonProtocolClient {
  const { socket, executor, device, runtimes, agents, scan, serverUrl, fetch: fetchFn, envResolver } = input;
  const sleep = input.sleep ?? sleepFor;
  // 复用 scanner 同款 home 解析；默认 homedir()。custom-agent skills 扫描必须用同一个 home。
  const home = input.homeDir ?? homedir();
  const codexGeneratedImagesDir = join(home, '.codex', 'generated_images');
  let currentDeviceId: string;
  let rescan: RescanController | undefined;
  let latestSnapshot: DaemonScanSnapshot = { runtimes, agents };

  return {
    async start() {
      const initialAnnouncement = await announceDeviceSnapshot(socket, device, latestSnapshot.runtimes, latestSnapshot.agents, { onDeviceRemoved: input.onDeviceRemoved });
      currentDeviceId = initialAnnouncement.deviceId;
      await applyCredentialsUpdate(initialAnnouncement.credentials);
      const cancelledDispatchIds = new Set<string>();
      const outbox: DispatchOutbox = createDispatchOutbox(socket, {
        onWarn: (message) => console.warn(message),
      });
      const knownRecoveryCwds = new Set<string>();
      const rememberRecoveryCwds = (cwds: Array<string | undefined>) => {
        for (const cwd of cwds) {
          if (typeof cwd === 'string' && cwd.length > 0) {
            knownRecoveryCwds.add(cwd);
          }
        }
      };
      const scheduleRecoverPersistedWorkspaceRuns = (cwds: Array<string | undefined>) => {
        rememberRecoveryCwds(cwds);
        void recoverPersistedWorkspaceRuns(outbox, Array.from(knownRecoveryCwds));
      };
      rememberRecoveryCwds(latestSnapshot.agents.map((agent) => agent.cwd));
      socket.onReconnect?.(async () => {
        try {
          const announcement = await announceDeviceSnapshot(socket, device, latestSnapshot.runtimes, latestSnapshot.agents, { onDeviceRemoved: input.onDeviceRemoved });
          currentDeviceId = announcement.deviceId;
          await applyCredentialsUpdate(announcement.credentials);
        } catch (error) {
          console.warn(`daemon reconnect announce failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
        }
        scheduleRecoverPersistedWorkspaceRuns(latestSnapshot.agents.map((agent) => agent.cwd));
        await outbox.flush();
      });

      socket.on(AGENT_EVENTS.device.scanRequested, async (payload) => {
        const request = readScanRequest(payload);
        if (request.deviceId !== currentDeviceId) {
          return;
        }
        const snapshot = scan ? await scan() : latestSnapshot;
        latestSnapshot = snapshot;
        scheduleRecoverPersistedWorkspaceRuns(snapshot.agents.map((agent) => agent.cwd));
        await reportDeviceSnapshot(socket, device.teamId, currentDeviceId, snapshot.runtimes, snapshot.agents);
        // 收到 customAgents 列表后扫描 skills 并上报（best-effort，失败仅 warn）
        if (request.customAgents && request.customAgents.length > 0) {
          await reportCustomAgentSkills(socket, { teamId: device.teamId, deviceId: currentDeviceId, customAgents: request.customAgents }, home);
          scheduleRecoverPersistedWorkspaceRuns(request.customAgents.map((agent) => agent.cwd));
        }
        await input.onScanChanged?.(snapshot);
      });

      socket.on(AGENT_EVENTS.device.selectDirectoryRequested, async (_payload: unknown, ack?: (result: unknown) => void) => {
        try {
          const selected = await selectNativeDirectory();
          if (!selected) {
            ack?.({ ok: false, error: 'CANCELLED' });
            return;
          }
          ack?.({ ok: true, path: selected });
        } catch (err) {
          // 优先回传稳定错误码（如 DirectoryPickerError 的 DIRECTORY_PICKER_UNAVAILABLE），
          // 前端据此渲染友好提示；只有非结构化错误才退回 message。
          const code = (err as { code?: unknown })?.code;
          ack?.({ ok: false, error: typeof code === 'string' ? code : err instanceof Error ? err.message : 'directory picker failed' });
        }
      });

      // 服务端通知设备已被删除：上抛 onDeviceRemoved，由 cli 层关闭重连并退出进程。
      socket.on(AGENT_EVENTS.device.removed, async () => {
        await input.onDeviceRemoved?.();
      });

      socket.on(AGENT_EVENTS.dispatch.cancel, async (payload) => {
        cancelledDispatchIds.add(readDispatchCancel(payload).dispatchId);
      });

      socket.on(AGENT_EVENTS.dispatch.request, async (payload) => {
        let request = payload as DispatchRequestPayload;
        if (cancelledDispatchIds.delete(request.id)) {
          return;
        }
        try {
          if (request.claimRequired) {
            const wake = request;
            const accepted = await claimDispatchRequest(
              socket,
              wake,
              sleep,
              () => cancelledDispatchIds.has(wake.id),
            );
            if (!accepted) {
              cancelledDispatchIds.delete(wake.id);
              return;
            }
            request = accepted;
          }
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
          const collectedProductArtifacts: Awaited<ReturnType<typeof collectArtifacts>> = [];
          const startedAt = result.workspaceRun?.startedAt;
          const isCodexCustomAgent = isCodexAdapterKind(request.customAgent?.adapterKind);
          const generatedImageDirs = isCodexCustomAgent ? [codexGeneratedImagesDir] : [];
          const shouldCollectProductArtifacts = startedAt !== undefined && (workspace || generatedImageDirs.length > 0);
          if (shouldCollectProductArtifacts) {
            const collected = await collectArtifacts({
              ...(workspace ? { outputDir: workspace.outputDir, cwd: workspace.cwd } : {}),
              extraOutputDirs: generatedImageDirs,
              startedAt,
            });
            collectedProductArtifacts.push(...collected);
            if (collected.length > 0 && device.token) {
              const uploaded = await uploadArtifacts(
                { serverUrl, token: device.token, teamId: device.teamId, channelId: request.channelId, fetch: fetchFn },
                collected,
              );
              productArtifactIds = uploaded.map((u) => u.id);
            }
          }
          const artifacts = result.artifacts ?? [];
          const artifactIds = [...(result.artifactIds ?? []), ...productArtifactIds];
          let reportedManifestPath: string | undefined;
          if (workspace && result.workspaceRun?.startedAt !== undefined) {
            try {
              persistWorkspaceRunResponse(workspace, result.body);
              const manifest = {
                runId: workspace.runId,
                agentId: request.agentId,
                channelId: request.channelId,
                status: result.workspaceRun.status ?? 'succeeded',
                cwd: result.workspaceRun.cwd ?? workspace.cwd,
                command: result.workspaceRun.command,
                logExcerpt: result.workspaceRun.logExcerpt,
                startedAt: result.workspaceRun.startedAt,
                completedAt: result.workspaceRun.completedAt,
                exitCode: result.workspaceRun.exitCode,
                artifactIds,
                artifacts,
                files: collectedProductArtifacts.map((c) => ({
                  relativePath: c.relativePath,
                  sha256: c.sha256,
                  sizeBytes: c.sizeBytes,
                  filename: c.filename,
                })),
              };
              persistWorkspaceRunManifest(workspace, {
                ...manifest,
              });
              reportedManifestPath = workspace.manifestPath;
            } catch {
              // manifest persistence is best-effort; never block the dispatch result
            }
          }

          outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.result, {
            dispatchId: request.id,
            agentId: request.agentId,
            body: result.body,
            ...(artifactIds.length > 0 ? { artifactIds } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
            ...(result.workspaceRun ? { workspaceRun: result.workspaceRun } : {}),
          }, {
            isDeliveredAck: isDispatchResultDeliveredAck,
            ...(reportedManifestPath
              ? { onDelivered: () => markWorkspaceRunManifestReported(reportedManifestPath, Date.now()) }
              : {}),
          });
        } catch (error) {
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
          outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.error, {
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
            latestSnapshot = snap;
            await input.onScanChanged?.(snap);
          },
        });
        rescan.start();
      }
      scheduleRecoverPersistedWorkspaceRuns([]);
    },
    rescanNow: () => rescan?.tickNow() ?? Promise.resolve(),
    stop: () => rescan?.stop(),
  };

  async function recoverPersistedWorkspaceRuns(
    outbox: DispatchOutbox,
    cwds: string[],
  ): Promise<void> {
    const runs = discoverRecoverableWorkspaceRuns(cwds);
    for (const run of runs) {
      try {
        const payload = {
          dispatchId: run.runId,
          agentId: run.agentId,
          body: run.body,
          ...(run.artifactIds && run.artifactIds.length > 0 ? { artifactIds: run.artifactIds } : {}),
          ...(run.artifacts && run.artifacts.length > 0 ? { artifacts: run.artifacts } : {}),
          workspaceRun: run.workspaceRun,
        };
        outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.result, payload, {
          isDeliveredAck: isDispatchResultDeliveredAck,
          onDelivered: () => markWorkspaceRunReported(run, Date.now()),
        });
      } catch (error) {
        console.warn(`daemon recover workspace run ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function applyCredentialsUpdate(credentials: DaemonDeviceCredentialsUpdate | undefined): Promise<void> {
    if (!credentials?.token) {
      return;
    }
    device.token = credentials.token;
    await input.onCredentialsChanged?.(credentials);
  }
}

function isCodexAdapterKind(adapterKind: string | undefined): boolean {
  return adapterKind === 'codex' || adapterKind === 'codex-cli';
}

function normalizeDispatchResult(result: string | DaemonDispatchResult): DaemonDispatchResult {
  if (typeof result === 'string') {
    return { body: result };
  }
  return result;
}

async function claimDispatchRequest(
  socket: DaemonProtocolSocket,
  wake: DispatchRequestPayload,
  sleep: (ms: number) => Promise<void>,
  isCancelled: () => boolean,
): Promise<DispatchRequestPayload | null> {
  for (;;) {
    if (isCancelled()) {
      return null;
    }
    const ack = await socket.emitWithAck(AGENT_EVENTS.dispatch.accepted, {
      dispatchId: wake.id,
      agentId: wake.agentId,
    });
    if (!ack || typeof ack !== 'object' || (ack as { ok?: unknown }).ok !== true) {
      throw new Error('dispatch claim failed');
    }
    if ((ack as { ready?: unknown }).ready === true) {
      const request = (ack as { request?: unknown }).request;
      if (!request || typeof request !== 'object') {
        throw new Error('dispatch claim response missing request');
      }
      const accepted = request as DispatchRequestPayload;
      if (accepted.id !== wake.id || accepted.agentId !== wake.agentId) {
        throw new Error('dispatch claim response does not match wake');
      }
      return accepted;
    }
    if ((ack as { ready?: unknown }).ready !== false) {
      throw new Error('dispatch claim response missing readiness');
    }
    const retryAfterMs = (ack as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs)) {
      throw new Error('dispatch claim response missing retry delay');
    }
    await sleep(Math.max(1, Math.ceil(retryAfterMs)));
  }
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDispatchResultDeliveredAck(ack: unknown): boolean {
  if (!ack || typeof ack !== 'object') {
    return false;
  }
  const fields = ack as { ok?: unknown; error?: unknown };
  return fields.ok === true || (fields.ok === false && fields.error === 'CONFLICT');
}

async function announceDeviceSnapshot(
  socket: DaemonProtocolSocket,
  device: DaemonDeviceConfig,
  runtimes: DaemonRuntimeReport[],
  agents: DaemonAgentReport[],
  options: { onDeviceRemoved?: () => Promise<void> | void } = {},
): Promise<{ deviceId: string; credentials?: DaemonDeviceCredentialsUpdate }> {
  const helloAck = await socket.emitWithAck(AGENT_EVENTS.device.hello, {
    ...device,
    protocolCapabilities: { dispatchClaim: true },
  });
  // 层2：离线删除后重连被拒——复用 onDeviceRemoved 退出，不复活。
  // 检查必须在 readAckDeviceId 之前，避免对 error ack 调 readAckDeviceId。
  if (helloAck && typeof helloAck === 'object' && (helloAck as { ok?: unknown }).ok === false && (helloAck as { error?: unknown }).error === 'DEVICE_REVOKED') {
    await options.onDeviceRemoved?.();
    throw new Error('Device revoked by server; aborting announce');
  }
  const deviceId = readAckDeviceId(helloAck);
  const credentials = readAckDeviceCredentials(helloAck);

      await reportDeviceSnapshot(socket, device.teamId, deviceId, runtimes, agents, { required: true });
  return { deviceId, ...(credentials ? { credentials } : {}) };
}

async function reportDeviceSnapshot(
  socket: DaemonProtocolSocket,
  teamId: string,
  deviceId: string,
  runtimes: DaemonRuntimeReport[],
  agents: DaemonAgentReport[],
  options: { required?: boolean } = {},
): Promise<void> {
  const failureMode = options.required ? 'required' : 'non-blocking';
  try {
    await socket.emitWithAck(AGENT_EVENTS.device.runtimes, { teamId, deviceId, runtimes });
  } catch (error) {
    console.warn(`daemon emit ${AGENT_EVENTS.device.runtimes} failed (${failureMode}): ${error instanceof Error ? error.message : String(error)}`);
    if (options.required) {
      throw error;
    }
  }
  try {
    await socket.emitWithAck(AGENT_EVENTS.agent.registerBatch, { teamId, deviceId, agents });
  } catch (error) {
    console.warn(`daemon emit ${AGENT_EVENTS.agent.registerBatch} failed (${failureMode}): ${error instanceof Error ? error.message : String(error)}`);
    if (options.required) {
      throw error;
    }
  }
}

/** 扫描每个 custom agent 的 skills。单个 agent 抛错 → 该 agent skills=[]，不影响其它。 */
export function customAgentItems(
  input: { customAgents: { id: string; adapterKind: any; cwd?: string }[] },
  home: string,
): { agentId: string; skills: ReturnType<typeof scanCustomAgentSkills> }[] {
  const items: { agentId: string; skills: ReturnType<typeof scanCustomAgentSkills> }[] = [];
  for (const ca of input.customAgents) {
    try {
      items.push({ agentId: ca.id, skills: scanCustomAgentSkills(ca, home) });
    } catch (error) {
      console.warn(`scan skills for agent ${ca.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      items.push({ agentId: ca.id, skills: [] });
    }
  }
  return items;
}

/** 扫描 custom agent skills 并 emitWithAck 上报。上报失败仅 warn，不阻断（不抛错）。 */
export async function reportCustomAgentSkills(
  socket: DaemonProtocolSocket,
  input: { teamId: string; deviceId: string; customAgents: { id: string; adapterKind: any; cwd?: string }[] },
  home: string,
): Promise<void> {
  const items = customAgentItems(input, home);
  try {
    await socket.emitWithAck(AGENT_EVENTS.agent.reportCustomSkills, {
      teamId: input.teamId,
      deviceId: input.deviceId,
      items,
    });
  } catch (error) {
    console.warn(`daemon emit ${AGENT_EVENTS.agent.reportCustomSkills} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readScanRequest(payload: unknown): { requestId: string; deviceId: string; customAgents?: { id: string; adapterKind: any; cwd?: string }[] } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('device:scan-requested payload missing request');
  }
  const request = payload as { requestId?: unknown; deviceId?: unknown; customAgents?: unknown };
  if (typeof request.requestId !== 'string' || typeof request.deviceId !== 'string') {
    throw new Error('device:scan-requested payload missing request id or device id');
  }
  const customAgents = Array.isArray(request.customAgents)
    ? request.customAgents.filter((ca): ca is { id: string; adapterKind: any; cwd?: string } =>
        ca != null && typeof ca === 'object' && typeof (ca as any).id === 'string')
    : undefined;
  return { requestId: request.requestId, deviceId: request.deviceId, ...(customAgents ? { customAgents } : {}) };
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

function readAckDeviceCredentials(ack: unknown): DaemonDeviceCredentialsUpdate | undefined {
  if (!ack || typeof ack !== 'object') {
    return undefined;
  }
  const credentials = (ack as { credentials?: unknown }).credentials;
  if (!credentials || typeof credentials !== 'object') {
    return undefined;
  }
  const fields = credentials as { token?: unknown; teamId?: unknown; ownerId?: unknown };
  if (typeof fields.token !== 'string' || fields.token.length === 0) {
    return undefined;
  }
  return {
    token: fields.token,
    ...(typeof fields.teamId === 'string' ? { teamId: fields.teamId } : {}),
    ...(typeof fields.ownerId === 'string' ? { ownerId: fields.ownerId } : {}),
  };
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

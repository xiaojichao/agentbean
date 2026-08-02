import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AGENT_EVENTS, type AgentArtifactSourceRootConfigDto, type AgentCategory, type AgentDescriptorDto, type ArtifactPathKind, type ArtifactRole, type ArtifactSourceRootDto, type DispatchCustomAgentDto, type DispatchHistoryMessageDto, type DispatchManagementContextDto, type DispatchMemoryContextItemDto, type ProjectDocumentInputSetResultProposalV1, type ProjectDocumentInputSetV1, type ProjectReferenceSetDto, type SkippedArtifactDiagnostic, type WorkspaceRunStatus } from '../../../packages/contracts/src/index.js';
import type { DispatchAttachment } from './attachments.js';
import { downloadAttachments } from './attachments.js';
import {
  buildProjectDocumentInputSetResultProposal,
  collectProjectDocumentInputSetResults,
  materializeProjectDocumentInputSet,
  type MaterializedProjectDocumentInputSet,
} from './project-document-input-set.js';
import {
  discoverRecoverableWorkspaceRuns,
  markWorkspaceRunManifestReported,
  markWorkspaceRunReported,
  prepareWorkspaceRun,
  workspaceRunEnv,
  persistWorkspaceRunManifest,
  persistWorkspaceRunResponse,
} from './workspace-run.js';
import { collectArtifacts, type AdapterOutputRoot, type ArtifactCollectionDiagnostic } from './artifact-collector.js';
import { uploadArtifacts } from './artifact-uploader.js';
import { selectNativeDirectory } from './directory-picker.js';
import { listDirectory, productionListDirectoryDeps, createListDirectoryRateLimiter } from './directory-lister.js';
import { scanCustomAgentSkills } from './skill-scanner.js';
import { scanAgentDescriptor } from './descriptor-scanner.js';
import { createTaskClaimProtocol, type ManagementWorkerProtocolSocket } from './management-worker-protocol.js';
import {
  buildDispatchWorkspacePublishId,
  deliverWorkspaceOutputsViaStaging,
} from './workspace-publish-delivery.js';
import {
  createHttpWorkspaceStagingClient,
  fetchProjectChannelWorkspaceCurrent,
} from './workspace-publish-http-client.js';
import {
  createFilesystemWorkspacePublishRecoveryStore,
  resumeLocalWorkspacePublish,
} from './workspace-publish-recovery.js';

export { createBuiltinScanProvider, scanBuiltinRuntimeAgents } from './scanner.js';
export type { BuiltinScannerOptions } from './scanner.js';
export { createCommandExecutor } from './executor.js';
export type { CommandExecutorOptions } from './executor.js';
export { downloadAttachments } from './attachments.js';
export { materializeProjectDocumentInputSet } from './project-document-input-set.js';
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
export {
  buildDispatchWorkspacePublishId,
  deliverWorkspaceOutputsViaStaging,
} from './workspace-publish-delivery.js';
export type { DeliverWorkspaceOutputsResult } from './workspace-publish-delivery.js';
export {
  createHttpWorkspaceStagingClient,
  createHttpWorkspaceStagingPutClient,
  fetchProjectChannelWorkspaceCurrent,
} from './workspace-publish-http-client.js';
export {
  createFilesystemWorkspacePublishRecoveryStore,
  resumeLocalWorkspacePublish,
  buildLocalWorkspacePublishFile,
} from './workspace-publish-recovery.js';
export type {
  LocalWorkspacePublishRecord,
  StagingRemoteClient,
  WorkspacePublishRecoveryStore,
} from './workspace-publish-recovery.js';
export { createDeviceServiceCore } from './device-service-core.js';
export type { DeviceServiceComponent, DeviceServiceCore } from './device-service-core.js';
export { createDeviceServiceHost, bindDeviceServiceSignals } from './device-service-host.js';
export type {
  DeviceServiceHost,
  DeviceServiceProfileRunner,
  DeviceServiceDrainResult,
  ProfileDrainResult,
  ProfileRuntimePhase,
  ProfileRuntimeStatus,
} from './device-service-host.js';
export { createDeviceServiceProfileRunner } from './device-service-profile-runner.js';
export type { CreateDeviceServiceProfileRunnerInput } from './device-service-profile-runner.js';
export { createDeviceControlServer } from './device-control-server.js';
export type { DeviceControlHandler, DeviceControlServer } from './device-control-server.js';
export { parseDeviceControlRequest } from './device-control-protocol.js';
export type {
  DeviceControlCommand,
  DeviceControlRequest,
  DeviceControlResponse,
} from './device-control-protocol.js';
export { createDeviceControlClient } from './device-control-client.js';
export type { DeviceControlClient } from './device-control-client.js';
export { runDeviceCli, formatDeviceServiceState, DEVICE_CLI_EXIT } from './device-cli.js';
export type { DeviceCliCommand, DeviceCliDeps } from './device-cli.js';
export {
  runUpdateCli,
  readInstalledAgentBeanPackage,
  verifyInstalledPackage,
  fenceDeviceServiceForPackageSwap,
  readServiceErrorSummary,
  UPDATE_CLI_EXIT,
  SERVICE_INSTALL_DEADLINE_MS,
} from './update-cli.js';
export type { InstalledAgentBeanPackage, UpdateCliDeps, PackageInstallResult } from './update-cli.js';
export { runDeviceService } from './device-service-runtime.js';
export type { RunDeviceServiceInput } from './device-service-runtime.js';
export {
  createMacOSLaunchAgentAdapter,
  generateMacOSLaunchAgentPlist,
  writeMacOSLaunchAgentPlist,
  writeMacOSServicePayload,
  removeMacOSLaunchAgentInstallation,
  macOSLaunchAgentPaths,
  DEVICE_SERVICE_LAUNCH_AGENT_LABEL,
} from './macos-launch-agent.js';
export type { PlatformCommandResult, PlatformServiceAdapter } from './device-platform-service.js';
export type {
  MacOSLaunchAgentAdapter,
  MacOSLaunchAgentPaths,
  PlatformServiceStatus,
  LaunchctlResult,
  LaunchctlRunner,
} from './macos-launch-agent.js';
export { acquireDeviceServiceLock, DeviceServiceAlreadyRunningError } from './device-service-lock.js';
export type { DeviceServiceLock } from './device-service-lock.js';
export { deviceServicePaths } from './device-service-paths.js';
export type { DeviceServicePaths } from './device-service-paths.js';
export { assertDeviceRuntimeOwner, readDeviceRuntimeOwner } from './device-runtime-owner.js';
export type { DeviceRuntimeOwner } from './device-runtime-owner.js';
export {
  cancelDeviceMigration,
  inspectDeviceMigration,
  planDeviceMigration,
  readDeviceMigrationJournal,
  resumeDeviceMigration,
  startDeviceMigration,
} from './device-migration.js';
export type { DeviceMigrationJournal, DeviceMigrationPhase, DeviceMigrationStatus } from './device-migration.js';
export { bindLegacyRuntimeFence } from './device-service-runtime.js';
export { createDeviceServiceStateStore } from './device-service-state.js';
export type {
  DeviceServicePhase,
  DeviceServiceProfileCounts,
  DeviceServiceReasonCode,
  DeviceServiceState,
  DeviceServiceStateStore,
} from './device-service-state.js';
export { createManagementDurableOutbox } from './management-durable-outbox.js';
export type { ManagementDurableOutbox, ManagementDurableOutboxItem } from './management-durable-outbox.js';
export { createPiManagerWorkerHost } from './pi-manager-worker-host.js';
export type { PiManagerWorkerHost } from './pi-manager-worker-host.js';
export { createTaskClaimProtocol } from './management-worker-protocol.js';
export type { TaskClaimProtocol, TaskClaimProtocolHandlers } from './management-worker-protocol.js';
import { createRescanController, type RescanController } from './rescan.js';
import { createDispatchOutbox, type DispatchOutbox } from './outbox.js';
import { prepareDispatchRuntimeMemory } from './memory/runtime-memory-context.js';
import { listLocalMemoryGovernanceSummaries } from './memory/local-memory-governance.js';
import { createLocalMemoryStore, type LocalMemoryStore } from './memory/local-memory-store.js';
import { observeDispatchOutcome, type ObserveDispatchOutcomeInput } from './memory/outcome-observer.js';

export interface DaemonProtocolSocket {
  readonly connected: boolean;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void;
  off?(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void;
  onReconnect?(handler: () => Promise<void>): void;
  onDisconnect?(handler: () => Promise<void>): void;
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
  role?: ArtifactRole;
  sourceRoot?: ArtifactSourceRootDto;
  contentBase64?: string;
}

export interface DaemonDispatchResult {
  body: string;
  artifactIds?: string[];
  artifacts?: DaemonDispatchArtifactResult[];
  workspaceRun?: DaemonWorkspaceRunResult;
  collaborationProposals?: readonly import('../../../packages/contracts/src/index.js').AgentCollaborationProposalV1[];
  projectDocumentInputSetResult?: ProjectDocumentInputSetResultProposalV1;
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
  capabilities?: import('../../../packages/contracts/src/index.js').DeviceCapabilitiesDto;
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
  projectDocumentInputSetVersions?: number[];
  /** 扫描自 cwd/AGENTS.md（或 CLAUDE.md）的 descriptor（AgentOS 托管型 Agent 有值）。 */
  descriptor?: AgentDescriptorDto | null;
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
  managementInvocationId?: string;
  managementContext?: DispatchManagementContextDto;
  memoryContext?: readonly DispatchMemoryContextItemDto[];
  projectReferenceSets?: readonly ProjectReferenceSetDto[];
  projectDocumentInputSet?: ProjectDocumentInputSetV1;
  /**
   * #1003 / #966：执行时冻结的 Project Channel Workspace revisionId。
   * claim 路径可来自 execution snapshot；未提供时交付阶段会尝试读取频道当前 revision 作为 baseline。
   */
  workspaceRevisionId?: string;
  prompt: string;
  history?: DispatchHistoryMessageDto[];
  attachments?: DispatchAttachment[];
  customAgent?: DaemonCustomAgent | null;
}

export function appendProjectReferenceContext(
  prompt: string,
  referenceSets: readonly ProjectReferenceSetDto[] | undefined,
): string {
  if (!referenceSets?.length) return prompt;
  const lines = referenceSets.flatMap((set) => set.selections.flatMap((selection) =>
    selection.items.map((item) => item.kind === 'document_revision'
      ? `- 文档 ${JSON.stringify(item.filename)}：documentId=${item.documentId} revisionId=${item.revisionId} revision=${item.revisionNumber}`
      : `- 逻辑产物 ${JSON.stringify(item.filename)}：collectionId=${item.collectionId} versionId=${item.versionId} version=${item.versionNumber} artifactId=${item.artifactId}`)));
  if (lines.length === 0) return prompt;
  return [
    prompt,
    '## 项目引用（发送时冻结）',
    '以下身份与版本是本次执行的权威输入，不得替换为当前版或最终版。对应内容已作为输入附件提供时，请读取附件。',
    ...lines,
  ].join('\n\n');
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
  /** Per-file Artifact cap; defaults to the shared 250 MB contract. */
  artifactMaxBytes?: number;
  /** Per-Run archived Artifact cap; defaults to the shared 1 GB contract. */
  artifactRunMaxBytes?: number;
  envResolver?: AgentEnvResolver;
  sleep?(ms: number): Promise<void>;
  /**
   * 启动报到（device.hello + required snapshot）的有限重试参数：
   * 服务端 socket 在启动瞬间闪断时 required emit 会抛错，一次失败就判服务
   * 启动失败会让 update 误回滚；socket.io 会自动重连，稍等后重试即可恢复。
   */
  announceRetryMaxAttempts?: number;
  announceRetryDelayMs?: number;
  /** 单次报到尝试的超时；socket.io 在断线期间可能缓存发送导致 emitWithAck 一直等待。 */
  announceAttemptTimeoutMs?: number;
  rescanIntervalMs?: number;
  /**
   * Home directory used for scanning custom-agent skills (e.g. ~/.claude/skills).
   * Defaults to os.homedir(); must match the value the runtime scanner uses.
   */
  homeDir?: string;
  /** Device-local Memory base directory override for isolated embedding/tests. */
  localMemoryBaseDir?: string;
  /** Injectable local Memory observer for embedding/tests. */
  outcomeObserver?: typeof observeDispatchOutcome;
  onScanChanged?: (snapshot: DaemonScanSnapshot) => Promise<void> | void;
  onCredentialsChanged?: (credentials: DaemonDeviceCredentialsUpdate) => Promise<void> | void;
  /**
   * 服务端通知该设备已被删除时触发。cli 层据此关闭重连并退出进程，
   * 否则 daemon 会持续重连并通过 device.hello 把已删设备 upsert 复活。
   */
  onDeviceRemoved?: () => Promise<void> | void;
}

export interface DaemonProtocolClient {
  readonly deviceId?: string;
  start(): Promise<void>;
  beginDrain(deadlineMs: number): Promise<void>;
  activeWorkCount(): number;
  outboxPendingCount(): number;
  rescanNow?(): Promise<void>;
  stop?(): void;
}

export function createDaemonProtocolClient(input: CreateDaemonProtocolClientInput): DaemonProtocolClient {
  const { socket, executor, device, runtimes, agents, scan, serverUrl, fetch: fetchFn, envResolver } = input;
  const sleep = input.sleep ?? sleepFor;
  // 复用 scanner 同款 home 解析；默认 homedir()。custom-agent skills 扫描必须用同一个 home。
  const home = input.homeDir ?? homedir();
  const codexGeneratedImagesDir = join(home, '.codex', 'generated_images');
  // agentos-hosted（Hermes/OpenClaw）原生产物目录：它们不写 AGENTBEAN_OUTPUT_DIR，
  // 而是落到自己的数据目录，因此作为 adapter 默认 source root 参与 mtime 过滤收集。
  const hermesHomeDir = join(home, '.hermes');
  const openclawHomeDir = join(home, '.openclaw');
  const attachmentWorkspaceRoot = join(home, '.agentbean', 'attachment-workspaces');
  // #1003：可恢复 Workspace publish 本地 pending 根（profile/home 下，与 attachment 隔离）。
  const workspacePublishStore = createFilesystemWorkspacePublishRecoveryStore(
    join(home, '.agentbean'),
  );
  let currentDeviceId = '';
  let rescan: RescanController | undefined;
  let acceptingDispatches = false;
  let drainCancelled = false;
  let activeDispatchCount = 0;
  let dispatchOutbox: DispatchOutbox | undefined;
  let latestSnapshot: DaemonScanSnapshot = { runtimes, agents };
  const resumePendingWorkspacePublishes = async () => {
    // e2e/stub 场景可能无 serverUrl；无 token 也无法 resume。
    if (!device.token || !serverUrl) return;
    const client = createHttpWorkspaceStagingClient({
      serverUrl,
      token: device.token,
      fetch: fetchFn,
    });
    for (const pending of workspacePublishStore.listPending()) {
      try {
        const result = await resumeLocalWorkspacePublish({
          store: workspacePublishStore,
          client,
          publishId: pending.publishId,
          now: Date.now(),
        });
        if (result.kind === 'failed') {
          console.warn(
            `daemon workspace-publish resume ${pending.publishId} failed (non-blocking): ${result.error}`,
          );
        } else if (result.kind === 'conflict') {
          console.warn(
            `daemon workspace-publish resume ${pending.publishId} conflict (non-blocking)`
            + (result.conflictingPaths?.length ? `: ${result.conflictingPaths.join(',')}` : ''),
          );
        }
      } catch (error) {
        console.warn(
          `daemon workspace-publish resume ${pending.publishId} threw (non-blocking): ${readErrorMessage(error)}`,
        );
      }
    }
  };
  const localMemoryStores = new Map<string, Promise<LocalMemoryStore>>();
  const localMemoryObservationTails = new Map<string, Promise<void>>();
  const outcomeObserver = input.outcomeObserver ?? observeDispatchOutcome;
  const observeOutcomeBestEffort = async (
    request: Pick<DispatchRequestPayload, 'id' | 'agentId' | 'customAgent'>,
    result: ObserveDispatchOutcomeInput['result'],
  ) => {
    const cwd = result.workspaceRun?.cwd ?? request.customAgent?.cwd;
    if (!device.profileId || !result.workspaceRun || !cwd) return;
    try {
      let store = localMemoryStores.get(cwd);
      if (!store) {
        store = createLocalMemoryStore({ profileId: device.profileId, cwd, baseDir: input.localMemoryBaseDir });
        localMemoryStores.set(cwd, store);
      }
      await outcomeObserver({
        store: await store,
        request: {
          id: request.id,
          agentId: request.agentId,
          ...(request.customAgent ? { customAgent: {
            cwd: request.customAgent.cwd,
            adapterKind: request.customAgent.adapterKind,
          } } : {}),
        },
        result,
      });
    } catch (error) {
      // Store 初始化失败可能是瞬时文件系统问题；不要永久缓存 rejected Promise。
      localMemoryStores.delete(cwd);
      console.warn(`daemon observe dispatch ${request.id} failed (non-blocking): ${readErrorMessage(error)}`);
    }
  };
  const scheduleOutcomeObservation = (
    request: Pick<DispatchRequestPayload, 'id' | 'agentId' | 'customAgent'>,
    result: ObserveDispatchOutcomeInput['result'],
  ) => {
    const cwd = result.workspaceRun?.cwd ?? request.customAgent?.cwd;
    if (!device.profileId || !result.workspaceRun || !cwd) return;
    const previous = localMemoryObservationTails.get(cwd) ?? Promise.resolve();
    const current = previous.then(() => observeOutcomeBestEffort(request, result));
    localMemoryObservationTails.set(cwd, current);
    void current.finally(() => {
      if (localMemoryObservationTails.get(cwd) === current) localMemoryObservationTails.delete(cwd);
    });
  };

  return {
    get deviceId() { return currentDeviceId || undefined; },
    async start() {
      const initialAnnouncement = await announceWithStartRetry({
        socket,
        device,
        runtimes: latestSnapshot.runtimes,
        agents: latestSnapshot.agents,
        onDeviceRemoved: input.onDeviceRemoved,
        sleep,
        maxAttempts: input.announceRetryMaxAttempts ?? 6,
        delayMs: input.announceRetryDelayMs ?? 5_000,
        attemptTimeoutMs: input.announceAttemptTimeoutMs ?? 30_000,
      });
      currentDeviceId = initialAnnouncement.deviceId;
      await applyCredentialsUpdate(initialAnnouncement.credentials);
      const cancelledDispatchIds = new Set<string>();
      const dispatchExecutionTails = new Map<string, Promise<void>>();
      const outbox: DispatchOutbox = createDispatchOutbox(socket, {
        onWarn: (message) => console.warn(message),
      });
      dispatchOutbox = outbox;
      acceptingDispatches = true;
      drainCancelled = false;
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
      rememberRecoveryCwds([
        ...latestSnapshot.agents.map((agent) => agent.cwd),
        attachmentWorkspaceRoot,
      ]);
      // #1003：启动时恢复未完成的 Workspace publish（不以本地 pending 证明已发布）。
      void resumePendingWorkspacePublishes();
      socket.onReconnect?.(async () => {
        try {
          const announcement = await announceDeviceSnapshot(socket, device, latestSnapshot.runtimes, latestSnapshot.agents, { onDeviceRemoved: input.onDeviceRemoved });
          currentDeviceId = announcement.deviceId;
          await applyCredentialsUpdate(announcement.credentials);
        } catch (error) {
          console.warn(`daemon reconnect announce failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
        }
        scheduleRecoverPersistedWorkspaceRuns(latestSnapshot.agents.map((agent) => agent.cwd));
        void resumePendingWorkspacePublishes();
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

      socket.on(AGENT_EVENTS.device.scanDescriptorRequested, async (payload, ack?: (result: unknown) => void) => {
        // 指定目录的 AGENTS.md/CLAUDE.md + skills 扫描（web 表单 cwd 选定后触发）。
        // 用 ack 直接回传结果，不走上报链（无需 server 广播）。
        const request = readScanDescriptorRequest(payload);
        try {
          const descriptor = scanAgentDescriptor(request.cwd);
          const skills = scanCustomAgentSkills(
            { id: 'descriptor-scan', adapterKind: request.adapterKind, cwd: request.cwd },
            home,
          );
          ack?.({
            ok: true,
            requestId: request.requestId,
            descriptor,
            skills,
          });
        } catch (error) {
          ack?.({ ok: false, requestId: request.requestId, error: error instanceof Error ? error.message : 'descriptor scan failed' });
        }
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

      // fs:list 目录浏览：web→server 转发来的列表请求。
      // 安全闸在 directory-lister 内（resolve 规范化 + denylist→PATH_NOT_FOUND + 截断 1000），
      // 此处再加最后一道限速（单连接 10/s，防全盘枚举扫描；daemon↔server 仅一条 socket，
      // per-socket 一个 limiter 即 spec §6 的「单连接」语义）。
      // 远程/headless daemon 不需要桌面会话即可工作（对比 selectDirectory 的 osascript 弹窗）。
      const listDirectoryRateLimiter = createListDirectoryRateLimiter({
        max: 10,
        windowMs: 1000,
        now: () => Date.now(),
      });
      socket.on(AGENT_EVENTS.device.listDirectoryRequested, async (payload: unknown, ack?: (result: unknown) => void) => {
        try {
          if (!listDirectoryRateLimiter.allow()) {
            ack?.({ ok: false, error: 'RATE_LIMITED' });
            return;
          }
          const rawPath = typeof (payload as { path?: unknown } | null)?.path === 'string'
            ? (payload as { path: string }).path
            : '';
          const result = await listDirectory(rawPath, productionListDirectoryDeps());
          ack?.(result);
        } catch (err) {
          ack?.({ ok: false, error: err instanceof Error ? err.message : 'directory list failed' });
        }
      });

      socket.on(AGENT_EVENTS.memory.governanceSummaryRequested, async (payload: unknown, ack?: (result: unknown) => void) => {
        const teamId = (payload as { teamId?: unknown } | null)?.teamId;
        if (typeof teamId !== 'string' || teamId !== device.teamId || !device.profileId) {
          ack?.({ ok: false, error: 'PERMISSION_DENIED' });
          return;
        }
        try {
          const summaries = await listLocalMemoryGovernanceSummaries({
            profileId: device.profileId,
            teamId,
            cwds: Array.from(knownRecoveryCwds),
            baseDir: input.localMemoryBaseDir,
          });
          ack?.({ ok: true, summaries });
        } catch {
          ack?.({ ok: false, error: 'LOCAL_MEMORY_UNAVAILABLE' });
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
        if (!acceptingDispatches) return;
        activeDispatchCount += 1;
        const incomingRequest = payload as DispatchRequestPayload;
        // agentos-hosted（Hermes/OpenClaw）共享同一 adapter 数据目录（~/.hermes、~/.openclaw），
        // 产物收集只按 mtime > startedAt 过滤；若同一设备上多个这类 Agent 并发执行，后运行者写入的
        // 文件会落进先运行者的收集窗口，造成跨 run/跨频道产物串线。按 adapter 根串行整个执行窗口。
        const executionSerialKey = dispatchExecutionSerialKey(incomingRequest);
        const previousExecution = dispatchExecutionTails.get(executionSerialKey) ?? Promise.resolve();
        let releaseExecution: (() => void) | undefined;
        const executionTail = new Promise<void>((resolve) => {
          releaseExecution = resolve;
        });
        dispatchExecutionTails.set(executionSerialKey, executionTail);
        await previousExecution;
        let request = incomingRequest;
        try {
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
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

          request.prompt = appendProjectReferenceContext(
            request.prompt,
            request.projectReferenceSets,
          );

          // 未配置 agent cwd 时仍以 daemon home 作为受控 workspace 根目录，
          // 保证普通附件和冻结引用内容都能下载并通过绝对路径暴露给执行器。
          const explicitWorkspaceCwd = request.customAgent?.cwd;
          const workspaceRoot = explicitWorkspaceCwd
            ?? (request.attachments?.length || request.projectDocumentInputSet
              ? attachmentWorkspaceRoot
              : undefined);
          const workspace = workspaceRoot
            ? prepareWorkspaceRun(workspaceRoot, request.id)
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
          let materializedProjectDocumentInputSet: MaterializedProjectDocumentInputSet | undefined;
          if (request.projectDocumentInputSet) {
            if (!workspace || !device.token || !request.managementInvocationId) {
              throw new Error('PROJECT_DOCUMENT_INPUT_SET_RUNTIME_UNAVAILABLE');
            }
            const materialized = await materializeProjectDocumentInputSet({
              serverUrl,
              token: device.token,
              teamId: device.teamId,
              invocationId: request.managementInvocationId,
              inputDir: workspace.inputDir,
              inputSet: request.projectDocumentInputSet,
              fetch: fetchFn,
            });
            materializedProjectDocumentInputSet = materialized;
            const list = materialized.manifest.items
              .map((item) => `- ${item.displayName}: ${item.localPath}`)
              .join('\n');
            request.prompt = `${request.prompt}\n\n## 必需项目文档 InputSet\nManifest：${materialized.manifestPath}\n${list}`;
            if (request.customAgent) {
              request.customAgent = {
                ...request.customAgent,
                env: {
                  ...(request.customAgent.env ?? {}),
                  AGENTBEAN_PROJECT_DOCUMENT_INPUT_SET_MANIFEST: materialized.manifestPath,
                },
              };
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
          request = await prepareDispatchRuntimeMemory({
            request,
            profileId: device.profileId,
          });
          const result = normalizeDispatchResult(await executor(request));
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }

          // Scan outputs + cwd fallback, upload, then merge with the executor's log artifact.
          let productArtifactIds: string[] = [];
          const collectedProductArtifacts: Awaited<ReturnType<typeof collectArtifacts>> = [];
          const skippedProductArtifacts: SkippedArtifactDiagnostic[] = [];
          const startedAt = result.workspaceRun?.startedAt;
          const isCodexCustomAgent = isCodexAdapterKind(request.customAgent?.adapterKind);
          const codexExtraOutputDirs = isCodexCustomAgent ? [codexGeneratedImagesDir] : [];
          const adapterOutputRoots = resolveAdapterOutputRoots(request.customAgent?.adapterKind, {
            hermesHomeDir,
            openclawHomeDir,
          });
          const configuredRoots = resolveConfiguredArtifactRoots(
            request.customAgent?.artifactSourceRoots,
            request.customAgent?.env,
          );
          const artifactDiagnostics = [...configuredRoots.diagnostics];
          const shouldCollectProductArtifacts = startedAt !== undefined
            && (workspace || codexExtraOutputDirs.length > 0 || adapterOutputRoots.length > 0 || configuredRoots.roots.length > 0);
          if (shouldCollectProductArtifacts) {
            const collected = await collectArtifacts({
              ...(workspace ? {
                outputDir: workspace.outputDir,
                ...(explicitWorkspaceCwd ? { cwd: workspace.cwd } : {}),
              } : {}),
              extraOutputDirs: codexExtraOutputDirs,
              adapterOutputRoots,
              configuredOutputRoots: configuredRoots.roots,
              startedAt,
              maxBytes: input.artifactMaxBytes,
              onSkipped: (artifact, sourceRoot) => {
                if (sourceRoot.kind !== 'adapter_generated') {
                  skippedProductArtifacts.push(artifact);
                }
              },
              onDiagnostic: (diagnostic) => artifactDiagnostics.push(diagnostic),
            });
            collectedProductArtifacts.push(...collected);
            if (collected.length > 0 && device.token) {
              const optionalAdapterArtifacts = new Set(collected
                .filter((artifact) => artifact.sourceRoot.kind === 'adapter_generated')
                .map((artifact) => `${artifact.relativePath}:${artifact.sizeBytes}`));
              // #1003：频道存在 Project Channel Workspace 时走 staging 原子发布；否则回退 legacy upload。
              // 无 serverUrl 时（部分 e2e stub）不走 staging。
              let usedStaging = false;
              let baselineRevisionId = request.workspaceRevisionId;
              if (serverUrl && !baselineRevisionId) {
                const current = await fetchProjectChannelWorkspaceCurrent({
                  serverUrl,
                  token: device.token,
                  teamId: device.teamId,
                  channelId: request.channelId,
                  fetch: fetchFn,
                });
                if (current.ok) baselineRevisionId = current.currentRevisionId;
              }
              if (serverUrl && baselineRevisionId) {
                const client = createHttpWorkspaceStagingClient({
                  serverUrl,
                  token: device.token,
                  fetch: fetchFn,
                });
                const publishId = buildDispatchWorkspacePublishId({
                  dispatchId: request.id,
                  channelId: request.channelId,
                  baselineRevisionId,
                });
                const delivered = await deliverWorkspaceOutputsViaStaging({
                  store: workspacePublishStore,
                  client,
                  teamId: device.teamId,
                  channelId: request.channelId,
                  baselineRevisionId,
                  collected,
                  publishId,
                  now: Date.now(),
                  provenance: {
                    agentId: request.agentId,
                    taskId: request.managementInvocationId ?? request.id,
                    taskAttempt: 1,
                  },
                });
                if (delivered.kind === 'committed') {
                  usedStaging = true;
                  productArtifactIds = delivered.artifactIds;
                } else if (delivered.kind === 'conflict') {
                  const diagnostic = `[workspace-publish:CONFLICT] publishId=${delivered.publishId}`
                    + (delivered.conflictingPaths?.length
                      ? ` paths=${delivered.conflictingPaths.join(',')}`
                      : '');
                  result.body = appendDiagnostic(result.body, diagnostic);
                  if (result.workspaceRun) {
                    result.workspaceRun.logExcerpt = appendDiagnostic(
                      result.workspaceRun.logExcerpt,
                      diagnostic,
                    );
                  }
                  // 冲突不伪造 revision；仍回退 upload 保证 dispatch 可见产物（非 workspace 半成品）。
                } else if (delivered.kind === 'failed') {
                  console.warn(
                    `daemon workspace-publish ${delivered.publishId} failed, fallback upload: ${delivered.error}`,
                  );
                }
              }
              if (!usedStaging) {
                const uploaded = await uploadArtifacts(
                  {
                    serverUrl,
                    token: device.token,
                    teamId: device.teamId,
                    channelId: request.channelId,
                    fetch: fetchFn,
                    maxBytes: input.artifactMaxBytes,
                    maxTotalBytes: input.artifactRunMaxBytes,
                    onSkipped: (artifact) => {
                      if (!optionalAdapterArtifacts.has(`${artifact.relativePath}:${artifact.sizeBytes}`)) {
                        skippedProductArtifacts.push(artifact);
                      }
                    },
                  },
                  collected,
                );
                productArtifactIds = uploaded.map((u) => u.id);
              }
            } else if (collected.length > 0) {
              skippedProductArtifacts.push(...collected
                .filter((artifact) => artifact.sourceRoot.kind !== 'adapter_generated')
                .map((artifact) => ({
                filename: artifact.filename,
                relativePath: artifact.relativePath,
                sizeBytes: artifact.sizeBytes,
                reason: 'UPLOAD_FAILED' as const,
                })));
            }
          }
          if (skippedProductArtifacts.length > 0) {
            const diagnostic = formatArtifactSkipDiagnostics(skippedProductArtifacts);
            result.body = appendDiagnostic(result.body, diagnostic);
            if (result.workspaceRun) {
              result.workspaceRun.logExcerpt = appendDiagnostic(result.workspaceRun.logExcerpt, diagnostic);
            }
          }
          if (artifactDiagnostics.length > 0 && result.workspaceRun) {
            const diagnosticLines = uniqueArtifactDiagnostics(artifactDiagnostics)
              .map((diagnostic) => `[artifact-collection:${diagnostic.code}] ${diagnostic.sourceRootLabel}`);
            result.workspaceRun.logExcerpt = [
              result.workspaceRun.logExcerpt,
              ...diagnosticLines,
            ].filter(Boolean).join('\n');
          }
          let projectDocumentInputSetResult: ProjectDocumentInputSetResultProposalV1 | undefined;
          if (materializedProjectDocumentInputSet) {
            const collectedResults = collectProjectDocumentInputSetResults(
              materializedProjectDocumentInputSet,
            );
            const resultArtifacts = [
              ...collectedResults.changedArtifacts,
              ...collectedResults.newDocumentArtifacts,
            ];
            const uploadedResults = device.token && resultArtifacts.length > 0
              ? await uploadArtifacts({
                  serverUrl,
                  token: device.token,
                  teamId: device.teamId,
                  channelId: request.channelId,
                  fetch: fetchFn,
                  maxBytes: input.artifactMaxBytes,
                  maxTotalBytes: input.artifactRunMaxBytes,
                }, resultArtifacts)
              : [];
            productArtifactIds.push(...uploadedResults.map((artifact) => artifact.id));
            projectDocumentInputSetResult = buildProjectDocumentInputSetResultProposal(
              materializedProjectDocumentInputSet,
              collectedResults,
              uploadedResults,
            );
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
                ...(result.collaborationProposals?.length
                  ? { collaborationProposals: result.collaborationProposals }
                  : {}),
                ...(projectDocumentInputSetResult ? { projectDocumentInputSetResult } : {}),
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
            ...(result.collaborationProposals?.length
              ? { collaborationProposals: result.collaborationProposals }
              : {}),
            ...(projectDocumentInputSetResult ? { projectDocumentInputSetResult } : {}),
          }, {
            isDeliveredAck: isDispatchResultDeliveredAck,
            ...(reportedManifestPath
              ? { onDelivered: () => markWorkspaceRunManifestReported(reportedManifestPath, Date.now()) }
              : {}),
          });
          scheduleOutcomeObservation(request, result);
        } catch (error) {
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
          outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.error, {
            dispatchId: request.id,
            agentId: request.agentId,
            error: readErrorMessage(error),
          });
        } finally {
          activeDispatchCount -= 1;
          // cancel suppresses a late result, but only the executor actually returning makes
          // it safe to start another request for the same Agent.
          releaseExecution?.();
          if (dispatchExecutionTails.get(executionSerialKey) === executionTail) {
            dispatchExecutionTails.delete(executionSerialKey);
          }
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
    async beginDrain(deadlineMs) {
      acceptingDispatches = false;
      rescan?.stop();
      const deadlineAt = Date.now() + deadlineMs;
      while (!drainCancelled && (activeDispatchCount > 0
        || (dispatchOutbox?.pendingCount() ?? 0) > 0
        || localMemoryObservationTails.size > 0)) {
        await dispatchOutbox?.flush();
        if (Date.now() >= deadlineAt) throw new Error('PROFILE_DRAIN_FAILED');
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadlineAt - Date.now()))));
      }
    },
    activeWorkCount() {
      return activeDispatchCount + localMemoryObservationTails.size;
    },
    outboxPendingCount() {
      return dispatchOutbox?.pendingCount() ?? 0;
    },
    rescanNow: () => rescan?.tickNow() ?? Promise.resolve(),
    stop: () => {
      acceptingDispatches = false;
      drainCancelled = true;
      rescan?.stop();
    },
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
          ...(run.collaborationProposals && run.collaborationProposals.length > 0
            ? { collaborationProposals: run.collaborationProposals }
            : {}),
          ...(run.projectDocumentInputSetResult
            ? { projectDocumentInputSetResult: run.projectDocumentInputSetResult }
            : {}),
          workspaceRun: run.workspaceRun,
        };
        outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.result, payload, {
          isDeliveredAck: isDispatchResultDeliveredAck,
          onDelivered: () => markWorkspaceRunReported(run, Date.now()),
        });
        scheduleOutcomeObservation({
          id: run.runId,
          agentId: run.agentId,
        }, { workspaceRun: run.workspaceRun });
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

export function createTaskClaimProtocolClient(input: {
  readonly socket: ManagementWorkerProtocolSocket;
  readonly getDeviceId: () => string | undefined;
}): import('./device-service-core.js').DeviceServiceComponent {
  const protocol = createTaskClaimProtocol({ socket: input.socket });
  return {
    async start() {
      const deviceId = input.getDeviceId();
      // 兼容测试替身/旧嵌入方：没有 hello 产生的 canonical device identity 时禁用认领，
      // 不能因此拖垮既有 Dispatch 与 Manager WorkerHost。
      if (!deviceId) return;
      await protocol.start({ deviceId }, {
        // #712 切片 C-2b-ii：替代旧 canAcceptOffer:()=>true 无条件隐式 acquire（AC#7）。
        // 过渡默认 accepted——经 task-claim:respond 显式接受（新路径），legacy 无持久化
        // offer 时 offerHandler 自动回退旧 acquire（兼容）。真实 Agent 评估决策属后续产品切片。
        decideOfferResponse: () => ({ kind: 'accepted' }),
        async onClaimed() {
          // Task 6 only establishes claim authority. Invocation/Dispatch starts in Task 8.
        },
      });
    },
    beginDrain() { protocol.stop(); },
    stop() { protocol.stop(); },
  };
}

function isCodexAdapterKind(adapterKind: string | undefined): boolean {
  return adapterKind === 'codex' || adapterKind === 'codex-cli';
}

/**
 * 同一执行串行键内的 dispatch 逐个执行。普通 Agent 按 agentId 串行；
 * agentos-hosted 网关共享 adapter 产物根，按 adapter 类型在整台设备上串行，
 * 避免并发 run 互相收集对方的产物。
 */
function dispatchExecutionSerialKey(request: DispatchRequestPayload): string {
  const adapterKind = request.customAgent?.adapterKind;
  if (adapterKind === 'hermes' || adapterKind === 'openclaw') {
    return `agentos-adapter:${adapterKind}`;
  }
  return `agent:${request.agentId}`;
}

/**
 * AgentOS-hosted（Hermes/OpenClaw）默认产物根。
 *
 * 只扫描两类范围，避免把数据目录里的内部状态（pairing/sessions/checkpoints/
 * cache 等）当作产物上传：
 * 1. 数据根目录顶层文件（非递归，扩展名白名单 + 跳过隐藏项）；
 * 2. 数据根目录下的 output/ 子目录（递归）。
 * 收集仍按本次运行窗口（mtime > startedAt）过滤，默认归类为运行产物。
 */
function resolveAdapterOutputRoots(
  adapterKind: string | undefined,
  dirs: { hermesHomeDir: string; openclawHomeDir: string },
): AdapterOutputRoot[] {
  if (adapterKind === 'hermes') {
    return [
      { dir: dirs.hermesHomeDir, recursive: false },
      { dir: join(dirs.hermesHomeDir, 'output'), recursive: true },
    ];
  }
  if (adapterKind === 'openclaw') {
    return [
      { dir: dirs.openclawHomeDir, recursive: false },
      { dir: join(dirs.openclawHomeDir, 'output'), recursive: true },
    ];
  }
  return [];
}

function normalizeDispatchResult(result: string | DaemonDispatchResult): DaemonDispatchResult {
  if (typeof result === 'string') {
    return { body: result };
  }
  return result;
}

function formatArtifactSkipDiagnostics(skipped: readonly SkippedArtifactDiagnostic[]): string {
  const lines = skipped.map((artifact) =>
    `- [${artifact.reason}] ${artifact.relativePath} (${artifact.sizeBytes} bytes)`);
  return ['[AgentBean Artifact 归档诊断]', ...lines].join('\n');
}

function appendDiagnostic(current: string | undefined, diagnostic: string): string {
  return current ? `${current}\n\n${diagnostic}` : diagnostic;
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

interface AnnounceWithStartRetryInput {
  readonly socket: DaemonProtocolSocket;
  readonly device: DaemonDeviceConfig;
  readonly runtimes: DaemonRuntimeReport[];
  readonly agents: DaemonAgentReport[];
  readonly onDeviceRemoved?: () => Promise<void> | void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly attemptTimeoutMs: number;
}

/**
 * 启动报到带有限重试。服务端明确删除设备（DEVICE_REVOKED）时不重试；
 * 其余瞬时错误（socket 闪断、ack 超时等）等待 socket.io 自动重连后重试。
 */
async function announceWithStartRetry(
  input: AnnounceWithStartRetryInput,
): Promise<{ deviceId: string; credentials?: DaemonDeviceCredentialsUpdate }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      return await withTimeout(
        announceDeviceSnapshot(input.socket, input.device, input.runtimes, input.agents, {
          onDeviceRemoved: input.onDeviceRemoved,
        }),
        input.attemptTimeoutMs,
        `initial announce timed out after ${input.attemptTimeoutMs}ms`,
      );
    } catch (error) {
      if (error instanceof Error && /revoked/i.test(error.message)) throw error;
      lastError = error;
      if (attempt < input.maxAttempts) {
        console.warn(
          `daemon initial announce failed (retry ${attempt}/${input.maxAttempts - 1}, non-blocking): ${readErrorMessage(error)}`,
        );
        await input.sleep(input.delayMs);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

function resolveConfiguredArtifactRoots(
  configs: AgentArtifactSourceRootConfigDto[] | undefined,
  env: Record<string, string> | undefined,
): {
  roots: Array<{
    id: string;
    path: string;
    label: string;
    defaultRole: AgentArtifactSourceRootConfigDto['defaultRole'];
    recursive: boolean;
  }>;
  diagnostics: ArtifactCollectionDiagnostic[];
} {
  const roots: Array<{
    id: string;
    path: string;
    label: string;
    defaultRole: AgentArtifactSourceRootConfigDto['defaultRole'];
    recursive: boolean;
  }> = [];
  const diagnostics: ArtifactCollectionDiagnostic[] = [];
  for (const config of configs ?? []) {
    const path = env?.[config.envVarName]?.trim();
    if (!path) {
      diagnostics.push({
        code: 'SOURCE_ROOT_MISSING',
        sourceRootId: config.id,
        sourceRootLabel: config.label,
      });
      continue;
    }
    if (!isAbsolute(path) || path.includes('\0')) {
      diagnostics.push({
        code: 'SOURCE_ROOT_INVALID',
        sourceRootId: config.id,
        sourceRootLabel: config.label,
      });
      continue;
    }
    roots.push({
      id: config.id,
      path,
      label: config.label,
      defaultRole: config.defaultRole,
      recursive: config.recursive,
    });
  }
  return { roots, diagnostics };
}

function uniqueArtifactDiagnostics(
  diagnostics: ArtifactCollectionDiagnostic[],
): ArtifactCollectionDiagnostic[] {
  const unique = new Map<string, ArtifactCollectionDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.sourceRootId}:${diagnostic.relativePath ?? ''}`;
    unique.set(key, diagnostic);
  }
  return [...unique.values()];
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

function readScanDescriptorRequest(payload: unknown): { requestId: string; cwd: string; adapterKind: any } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('device:scan-descriptor-requested payload missing request');
  }
  const request = payload as { requestId?: unknown; cwd?: unknown; adapterKind?: unknown };
  if (typeof request.requestId !== 'string' || typeof request.cwd !== 'string' || typeof request.adapterKind !== 'string') {
    throw new Error('device:scan-descriptor-requested payload missing request id, cwd or adapterKind');
  }
  return { requestId: request.requestId, cwd: request.cwd, adapterKind: request.adapterKind };
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

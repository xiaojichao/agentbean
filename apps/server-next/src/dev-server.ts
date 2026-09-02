import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createServerNextUseCases, type ArtifactContentStore, type BeginWorkspacePublishStagingInput, type CreateServerNextUseCasesInput } from './application/usecases.js';
import { getEmergencyStopActive } from './application/pi-provider-service.js';
import { createFileWorkspaceStagingContentStore } from './application/workspace-staging-content-store.js';
import { createArtifactPreviewService, type ArtifactPreviewService } from './application/artifact-preview-service.js';
import { createChannelFileMetrics, parseChannelFileRolloutConfig, type ChannelFileRolloutConfig } from './application/channel-file-rollout.js';
import type { ArtifactRecord, ServerNextRepositories } from './application/repositories.js';
import { createCapsuleInjectionValidator } from './application/capsule-injection-validator.js';
import { createServerCapsuleRuntimeContextService } from './application/server-capsule-runtime-context-service.js';
import {
  createServerMemorySearchPermissions,
  createServerMemoryWritePermissions,
  createServerMemoryCandidatePermissions,
  CURRENT_MEMORY_POLICY_VERSION,
} from './application/server-memory-permissions.js';
import { createDeviceWorkerScheduler, type DeviceWorkerScheduler } from './application/management/device-worker-scheduler.js';
import { createServerWorkerPool, type ServerWorkerPool } from './application/management/server-worker-pool.js';
import { createServerWorkerScheduler, type ServerWorkerScheduler } from './application/management/server-worker-scheduler.js';
import { createAutoPlacementProbe } from './application/management/auto-placement-probe.js';
import { createManagementKernel } from './application/management/management-kernel.js';
import { createInvocationGateway } from './application/management/invocation-gateway.js';
import { createManagementToolExecutor, createPhase1ManagementToolHandlers, createPhase2CollaborationToolHandlers, createPhase2InvocationToolHandlers, createPhase2ManagementToolHandlers, createPhase3ManagementToolHandlers } from './application/management/management-tool-executor.js';
import { createSubtaskAcceptanceService } from './application/management/subtask-acceptance-service.js';
import { createTaskCoordinationKernel } from './application/management/task-coordination-kernel.js';
import { createTaskLifecycleKernel } from './application/management/task-lifecycle-kernel.js';
import {
  recordChannelCollaborationClaim,
  recordChannelCollaborationStatus,
} from './application/channel-collaboration-task-handler.js';
import { resolveTaskAllocation } from './application/management/task-allocation-service.js';
import { createManagementRouter } from './application/management/management-router.js';
import { createCollaborativeMemorySearchService } from './application/collaborative-memory-search-service.js';
import { createMemoryCapsuleService } from './application/memory-capsule-service.js';
import { createMemoryCandidateService } from './application/memory-candidate-service.js';
import { createCollaborativeMemoryService } from './application/collaborative-memory-service.js';
import {
  createTaskClaimBroker,
  type ProjectStageClaimGranted,
  type TaskClaimBroker,
} from './application/management/task-claim-broker.js';
import { createInMemoryRepositories } from './infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  cleanupOrphanedChannelMembers,
  createSqliteRepositories,
  type SqliteDatabase,
} from './infra/sqlite/repositories.js';
import { createSqliteArtifactPreviewRepository } from './infra/sqlite/artifact-preview-repository.js';
import { createChannelFileBackfillIfSupported } from './infra/sqlite/channel-file-backfill.js';
import { createProjectDocumentBundleBackfill } from './application/project-document-bundle-backfill.js';
import { createProjectStageAutoAdvance } from './application/project-stage-auto-advance.js';
import { parseProjectDocumentRolloutConfig, type ProjectDocumentRolloutConfig } from './application/project-document-rollout.js';
import {
  createProjectCollaborationMetrics,
  parseProjectCollaborationRolloutConfig,
  type ProjectCollaborationRolloutConfig,
  validateProjectCollaborationRolloutConfig,
} from './application/project-collaboration-rollout.js';
import { attachServerNextNamespaces, type ServerNextRealtime, type SocketServerLike } from './transport/socket-server.js';
import { startDaemonVersionRefresh } from './daemon-version.js';
import { CHANNEL_COLLABORATION_TASK_TAG, DEFAULT_ARTIFACT_MAX_BYTES, isSafeArtifactInlinePreviewMimeType, makeFailure, type ArtifactDto, type ArtifactRole, type ArtifactSourceRootDto, type WorkspaceRevisionCommittedPayload, type WorkspaceRunStatus } from '../../../packages/contracts/src/index.js';
import type { ServerNextUseCases } from './application/usecases.js';

type SocketIoServerConstructor = new (server: HttpServer, options?: Record<string, unknown>) => SocketServerLike & {
  close(callback?: () => void): void;
};

export interface ServerNextDevConfig {
  host: string;
  port: number;
  storage: 'memory' | 'sqlite';
  dataDir: string;
  sessionSecret: string;
  webEntry?: 'preview' | 'app';
  channelFileRollout?: ChannelFileRolloutConfig;
  channelFileMetrics?: ReturnType<typeof createChannelFileMetrics>;
  projectDocumentRollout?: ProjectDocumentRolloutConfig;
  projectCollaborationRollout?: ProjectCollaborationRolloutConfig;
  projectCollaborationMetrics?: ReturnType<typeof createProjectCollaborationMetrics>;
  maxArtifactBytes?: number;
  serverWorker?: {
    workerPoolId: string;
    providerCredentialRef: string;
    authToken: string;
    /** 测试注入口:缩短排队超时/lease TTL 以驱动 e2e;生产 env 路径不传,保持默认 */
    queueTimeoutMs?: number;
    leaseTtlMs?: number;
  };
  /** CI 每日更新日志兜底端点（/api/internal/changelog-summarize）的 Bearer token；未配置时端点 503。 */
  changelogInternalToken?: string;
}

export interface ParseServerNextDevConfigInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface StartServerNextDevServerInput {
  app?: ServerNextUseCases;
  managementWorkerScheduler?: DeviceWorkerScheduler;
  serverWorkerScheduler?: ServerWorkerScheduler;
  taskClaimBroker?: TaskClaimBroker;
  serverWorkerPool?: ServerWorkerPool;
  serverWorkerAuthToken?: string;
  config?: ServerNextDevConfig;
  Server?: SocketIoServerConstructor;
  Database?: BetterSqlite3Constructor;
  dispatchTimeout?: DispatchTimeoutSchedulerConfig;
  coordination?: CoordinationSchedulerConfig;
  taskClaimExpiry?: TaskClaimExpirySchedulerConfig;
  webApp?: WebAppHandler;
  /** Test/rollout injection; durable-job also starts the background coordination consumer. */
  messageIngestionMode?: 'legacy' | 'durable-job' | 'message-tracer';
  /** #921 Message tracer command 路径开关（env AGENTBEAN_NEXT_MESSAGE_TRACER_ENABLED，默认 false）。 */
  messageTracerEnabled?: boolean;
}

export interface ServerNextDevServerHandle {
  host: string;
  port: number;
  baseUrl: string;
  httpServer: HttpServer;
  ioServer: InstanceType<SocketIoServerConstructor>;
  close(): Promise<void>;
}

interface AppWithCleanup {
  app: ServerNextUseCases;
  artifactPreviewService?: ArtifactPreviewService;
  channelFileBackfill?: NonNullable<ReturnType<typeof createChannelFileBackfillIfSupported>>;
  projectDocumentBundleBackfill?: ReturnType<typeof createProjectDocumentBundleBackfill>;
  managementWorkerScheduler?: DeviceWorkerScheduler;
  serverWorkerScheduler?: ServerWorkerScheduler;
  taskClaimBroker?: TaskClaimBroker;
  serverWorkerPool?: ServerWorkerPool;
  serverWorkerAuthToken?: string;
  bindManagementDispatchEmitter?(emit: (dispatchId: string) => Promise<void>): void;
  bindTaskClaimEmitter?(emit: (taskId: string, options?: {
    readonly allowedAgentIds?: readonly string[];
    readonly projectStageAuto?: boolean;
  }) => Promise<{ readonly offered: number }>): void;
  recoverProjectStages?(teamId?: string): Promise<void>;
  reconcileDisconnectedDevicesOnStart: boolean;
  close(): Promise<void>;
}

interface WebAppHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

type NextAppFactory = (options: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => {
  prepare(): Promise<void>;
  getRequestHandler(): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close(): Promise<void>;
};

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };
type CorsOrigin = string | string[] | false;

const INTERNAL_HTTP_ERROR_MESSAGE = 'Internal server error';
// Legacy JSON uploads buffer both the base64 request body and decoded bytes in memory.
// Keep that compatibility path small; large artifacts must use the streaming multipart path.
const MAX_LEGACY_ARTIFACT_UPLOAD_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_WORKSPACE_LOG_TAIL_LINES = 200;
const MAX_WORKSPACE_LOG_RESPONSE_BYTES = 64 * 1024;
const WORKSPACE_RUN_STATUSES = new Set<WorkspaceRunStatus>([
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
const DEFAULT_PRODUCTION_WEB_ORIGINS = ['https://agentbean.dev', 'https://www.agentbean.dev'];
const DEFAULT_LOCAL_WEB_ORIGINS = ['http://localhost:3100', 'http://localhost:4101'];

export interface DispatchTimeoutSchedulerConfig {
  /** 心跳失联阈值：dispatch 超过该时长无 dispatch:progress 心跳即判定 daemon 失联（新 daemon）。 */
  heartbeatTimeoutMs: number;
  /** 旧 daemon 兼容回退：从不发心跳的 dispatch（last_heartbeat_at 恒 null）按此绝对时长判定。 */
  legacyTimeoutMs: number;
  intervalMs: number;
}

export interface TaskClaimExpirySchedulerConfig {
  intervalMs: number;
  /** 每个频道协作子 Task 首次 Claim 过期后最多自动重发几轮 Offer。 */
  maxAutomaticReoffersPerTask?: number;
}

interface TaskClaimExpiryMetricSnapshot {
  cycles: number;
  failedCycles: number;
  expiredClaims: number;
  reofferAttempts: number;
  reofferedOffers: number;
  reofferFailures: number;
}

export function parseServerNextDevConfig(input: ParseServerNextDevConfigInput = {}): ServerNextDevConfig {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const args = parseArgs(argv);
  const host = args.host ?? env.AGENTBEAN_NEXT_HOST ?? (env.PORT ? '0.0.0.0' : '127.0.0.1');
  const port = Number(args.port ?? env.AGENTBEAN_NEXT_PORT ?? env.PORT ?? 4100);
  const storage = args.storage ?? env.AGENTBEAN_NEXT_STORAGE ?? (env.PORT ? 'sqlite' : 'memory');
  const webEntry = args['web-entry'] ?? env.AGENTBEAN_NEXT_WEB_ENTRY ?? (env.PORT ? 'app' : 'preview');
  const configuredDataDir = args['data-dir'] ?? env.AGENTBEAN_NEXT_DATA_DIR;
  const hasExplicitDataDir = configuredDataDir !== undefined && configuredDataDir.length > 0;
  const dataDir = hasExplicitDataDir ? configuredDataDir : join(process.cwd(), '.agentbean-next');
  const sessionSecret = args['session-secret'] ?? env.AGENTBEAN_NEXT_SESSION_SECRET ?? '';
  const workerPoolId = env.AGENTBEAN_NEXT_SERVER_WORKER_POOL_ID;
  const providerCredentialRef = env.AGENTBEAN_NEXT_SERVER_WORKER_PROVIDER_CREDENTIAL_REF;
  const serverWorkerAuthToken = env.AGENTBEAN_NEXT_SERVER_WORKER_AUTH_TOKEN;
  const changelogInternalToken = env.AGENTBEAN_CHANGELOG_INTERNAL_TOKEN;
  const maxArtifactBytes = parsePositiveByteLimit(env.AGENTBEAN_NEXT_MAX_ARTIFACT_BYTES, 'AGENTBEAN_NEXT_MAX_ARTIFACT_BYTES');
  const serverWorkerValues = [workerPoolId, providerCredentialRef, serverWorkerAuthToken];
  const hasAnyServerWorkerConfig = serverWorkerValues.some((value) => Boolean(value));
  const hasCompleteServerWorkerConfig = serverWorkerValues.every((value) => Boolean(value));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('AGENTBEAN_NEXT_PORT or --port must be an integer between 0 and 65535');
  }
  if (storage !== 'memory' && storage !== 'sqlite') {
    throw new Error('AGENTBEAN_NEXT_STORAGE or --storage must be memory or sqlite');
  }
  if (webEntry !== 'preview' && webEntry !== 'app') {
    throw new Error('AGENTBEAN_NEXT_WEB_ENTRY or --web-entry must be preview or app');
  }
  if (env.PORT && !sessionSecret) {
    throw new Error('AGENTBEAN_NEXT_SESSION_SECRET or --session-secret is required when PORT is set');
  }
  if (env.PORT && storage === 'sqlite' && !hasExplicitDataDir) {
    throw new Error('AGENTBEAN_NEXT_DATA_DIR or --data-dir is required when PORT uses sqlite storage');
  }
  if (hasAnyServerWorkerConfig && (!hasCompleteServerWorkerConfig || serverWorkerAuthToken!.length < 32)) {
    throw new Error('AGENTBEAN_NEXT_SERVER_WORKER configuration must be complete and auth token at least 32 characters');
  }
  if (hasCompleteServerWorkerConfig && (workerPoolId!.length > 256 || providerCredentialRef!.length > 512)) {
    throw new Error('AGENTBEAN_NEXT_SERVER_WORKER pool id or credential reference exceeds contract limits');
  }
  const serverWorker = hasCompleteServerWorkerConfig ? {
    workerPoolId: workerPoolId!,
    providerCredentialRef: providerCredentialRef!,
    authToken: serverWorkerAuthToken!,
  } : undefined;
  // 启动配置解析阶段先执行依赖校验；非法或乱序项目 rollout 必须在监听端口前 fail closed。
  const projectCollaborationRollout = parseProjectCollaborationRolloutConfig(env);
  return {
    host,
    port,
    storage,
    dataDir,
    sessionSecret: sessionSecret || 'agentbean-next-dev-session-secret',
    webEntry,
    projectCollaborationRollout,
    ...(maxArtifactBytes ? { maxArtifactBytes } : {}),
    ...(serverWorker ? { serverWorker } : {}),
    ...(changelogInternalToken ? { changelogInternalToken } : {}),
  };
}

export async function startServerNextDevServer(
  input: StartServerNextDevServerInput = {},
): Promise<ServerNextDevServerHandle> {
  const parsedConfig = input.config ?? parseServerNextDevConfig();
  const projectCollaborationRollout = parsedConfig.projectCollaborationRollout
    ?? parseProjectCollaborationRolloutConfig();
  validateProjectCollaborationRolloutConfig(projectCollaborationRollout);
  const config: ServerNextDevConfig = {
    ...parsedConfig,
    channelFileRollout: parsedConfig.channelFileRollout ?? parseChannelFileRolloutConfig(),
    channelFileMetrics: parsedConfig.channelFileMetrics ?? createChannelFileMetrics(),
    projectCollaborationRollout,
    projectCollaborationMetrics: parsedConfig.projectCollaborationMetrics
      ?? createProjectCollaborationMetrics(),
  };
  // ADR 0061: production host defaults to durable-job so Channel Coordinator runs.
  const messageIngestionMode = resolveMessageIngestionMode(input.messageIngestionMode);
  const messageTracerEnabled = resolveMessageTracerEnabled(input.messageTracerEnabled);
  // #921 outbox 投递 late-bind：realtime 在 attachServerNextNamespaces 后才创建，用 ref 闭包延迟接通。
  let realtimeRef: ServerNextRealtime | undefined;
  const onMessageTracerDelivered = messageTracerEnabled
    ? async (delivery: { teamId: string; channelId: string; messageId: string }) => {
        await realtimeRef?.emitMessageDelivered(delivery);
      }
    : undefined;
  const onChannelCollaborationMessageAppended = async (
    delivery: { teamId: string; channelId: string; messageId: string },
  ) => {
    await realtimeRef?.emitMessageDelivered(delivery);
  };
  // #1084 workspace revision commit fan-out：真正新建 revision 后通知频道在线设备 materialize。
  // late-bind 同 #921——realtime 在 attachServerNextNamespaces 后才创建。
  const onWorkspaceRevisionCommitted = async (payload: WorkspaceRevisionCommittedPayload) => {
    await realtimeRef?.emitWorkspaceRevisionCommitted(payload);
  };
  const appWithCleanup = input.app
    ? { app: input.app, managementWorkerScheduler: input.managementWorkerScheduler,
      serverWorkerScheduler: input.serverWorkerScheduler,
      taskClaimBroker: input.taskClaimBroker, serverWorkerPool: input.serverWorkerPool,
      serverWorkerAuthToken: input.serverWorkerAuthToken, reconcileDisconnectedDevicesOnStart: false,
      close: async () => undefined }
    : createDefaultApp(
        config,
        input.Database,
        messageIngestionMode,
        messageTracerEnabled,
        onMessageTracerDelivered,
        onWorkspaceRevisionCommitted,
        onChannelCollaborationMessageAppended,
      );
  const app = appWithCleanup.app;
  const taskClaimBroker = input.taskClaimBroker ?? appWithCleanup.taskClaimBroker;
  const taskClaimExpiryMetrics = createTaskClaimExpiryMetrics();
  if (appWithCleanup.reconcileDisconnectedDevicesOnStart) {
    await app.reconcileDisconnectedDevices({ timestamp: Date.now() });
  }
  const Server = input.Server ?? loadSocketIoServer();
  const webEntry = config.webEntry ?? 'preview';
  const webApp = webEntry === 'app' ? input.webApp ?? await createWebAppHandler(config) : null;
  const restCorsOrigin = resolveRestCorsOrigin();
  const httpServer = createServer(async (request, response) => {
    try {
      if (handleRestCors(request, response, restCorsOrigin)) {
        return;
      }
      const url = new URL(request.url ?? '/', 'http://agentbean-next.local');
      if (url.pathname === '/preview' || (url.pathname === '/' && !webApp)) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(readPreviewHtml());
        return;
      }
      if (url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, service: 'agentbean-next-server' }));
        return;
      }
      if (url.pathname === '/metricsz') {
        // #830 报告只含计数与原因码，不含正文、文件名或设备路径，可安全随指标暴露。
        const documentBundleBackfill = await appWithCleanup.projectDocumentBundleBackfill?.snapshot();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          channelFiles: config.channelFileMetrics?.snapshot(),
          projectCollaboration: {
            rollout: config.projectCollaborationRollout,
            metrics: config.projectCollaborationMetrics?.snapshot(),
          },
          taskClaimExpiry: taskClaimExpiryMetrics.snapshot(),
          ...(documentBundleBackfill ? { documentBundleBackfill } : {}),
        }));
        return;
      }
      if (await handleAgentWorkspaceHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleTeamWorkspaceRunsHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleWorkspaceRunLogHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleWorkspaceRunHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleArtifactHttp({ app, config, request, response, url, previewService: appWithCleanup.artifactPreviewService })) {
        return;
      }
      if (await handleDeviceWorkspaceSnapshotHttp({ app, config, request, response, url })) {
        return;
      }
      // #967 hardening：Workspace publish staging 分块续传 HTTP 入口。
      if (await handleWorkspacePublishStagingHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleAgentEnvHttp({ app, config, request, response, url })) {
        return;
      }
      // 每日更新日志 LLM 兜底（CI 内部调用）：PR 未写用户向小节时，用 Active PI Model 生成条目。
      if (await handleChangelogSummarizeHttp({ app, config, request, response, url })) {
        return;
      }
      if (webApp) {
        await webApp.handle(request, response);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
    } catch (error) {
      writeInternalHttpError(response, error);
    }
  });
  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  const realtime = attachServerNextNamespaces(ioServer, app, {
    managementWorkerScheduler: input.managementWorkerScheduler ?? appWithCleanup.managementWorkerScheduler,
    serverWorkerScheduler: input.serverWorkerScheduler ?? appWithCleanup.serverWorkerScheduler,
    taskClaimBroker,
    serverWorkerPool: input.serverWorkerPool ?? appWithCleanup.serverWorkerPool,
    serverWorkerAuthToken: input.serverWorkerAuthToken ?? appWithCleanup.serverWorkerAuthToken,
    projectCollaborationMetrics: config.projectCollaborationMetrics,
    onAgentAvailabilityChanged: async (teamId) => {
      await appWithCleanup.recoverProjectStages?.(teamId);
    },
  });
  realtimeRef = realtime; // #921 接通 outbox 投递 late-bind
  appWithCleanup.bindManagementDispatchEmitter?.((dispatchId) => realtime.dispatchRequest(dispatchId));
  appWithCleanup.bindTaskClaimEmitter?.(async (taskId, options) => {
    return realtime.offerTaskClaims(taskId, options);
  });
  await appWithCleanup.recoverProjectStages?.();
  const dispatchTimeoutInterval = startDispatchTimeoutScheduler(
    app,
    realtime,
    input.dispatchTimeout ?? { heartbeatTimeoutMs: 90 * 1000, legacyTimeoutMs: 10 * 60 * 1000, intervalMs: 5000 },
  );
  const coordinationScheduler = startCoordinationScheduler(
    app,
    messageIngestionMode === 'durable-job',
    input.coordination ?? { intervalMs: 1000 },
  );
  const taskClaimExpiryScheduler = taskClaimBroker
    ? startTaskClaimExpiryScheduler(
        taskClaimBroker,
        realtime,
        input.taskClaimExpiry ?? { intervalMs: 5_000, maxAutomaticReoffersPerTask: 1 },
        taskClaimExpiryMetrics,
      )
    : null;

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, () => resolve());
  });
  const stopVersionRefresh = startDaemonVersionRefresh();
  let projectStageRecoveryRunning = false;
  const projectStageRecoveryInterval = appWithCleanup.recoverProjectStages
    ? setInterval(() => {
      if (projectStageRecoveryRunning) return;
      projectStageRecoveryRunning = true;
      void appWithCleanup.recoverProjectStages?.()
        .catch(() => undefined)
        .finally(() => {
          projectStageRecoveryRunning = false;
        });
    }, 30_000)
    : undefined;
  projectStageRecoveryInterval?.unref();
  const previewWorkerInterval = appWithCleanup.artifactPreviewService
    ? setInterval(() => {
      void appWithCleanup.artifactPreviewService?.runOnce().catch(() => undefined);
    }, 250)
    : undefined;
  // #967 hardening：周期清理过期未提交 Workspace publish staging。
  let workspaceStagingCleanupRunning = false;
  const workspaceStagingCleanupInterval = setInterval(() => {
    if (workspaceStagingCleanupRunning) return;
    if (typeof app.cleanupExpiredWorkspacePublishStaging !== 'function') return;
    workspaceStagingCleanupRunning = true;
    void app.cleanupExpiredWorkspacePublishStaging({ limit: 50 })
      .catch(() => undefined)
      .finally(() => {
        workspaceStagingCleanupRunning = false;
      });
  }, 5 * 60_000);
  workspaceStagingCleanupInterval.unref();
  const channelFileBackfillInterval = appWithCleanup.channelFileBackfill
    ? setInterval(() => {
      try {
        const result = appWithCleanup.channelFileBackfill?.runBatch();
        if (result?.completed && channelFileBackfillInterval) {
          clearInterval(channelFileBackfillInterval);
        }
      } catch {
        // 保留当前批次游标，下一轮从同一位置安全重试。
      }
    }, 100)
    : undefined;
  // #830：与 channelFileBackfill 同样的分批节奏。裁决过程本身可暂停/恢复 —— 游标只推进到
  // 连续成功的最后一个候选，进程随时停掉都能从同一位置续跑。
  let projectDocumentBundleBackfillRunning = false;
  const projectDocumentBundleBackfillInterval = appWithCleanup.projectDocumentBundleBackfill
    ? setInterval(() => {
      if (projectDocumentBundleBackfillRunning) return;
      projectDocumentBundleBackfillRunning = true;
      void appWithCleanup.projectDocumentBundleBackfill?.runBatch()
        .then((result) => {
          if (result.completed && projectDocumentBundleBackfillInterval) {
            clearInterval(projectDocumentBundleBackfillInterval);
          }
        })
        // 批次内已逐候选记过 failed，这里只保证定时器不被未捕获拒绝打断。
        .catch(() => undefined)
        .finally(() => {
          projectDocumentBundleBackfillRunning = false;
        });
    }, 250)
    : undefined;
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return {
    host: config.host,
    port,
    baseUrl: `http://${config.host}:${port}`,
    httpServer,
    ioServer,
    async close() {
      if (dispatchTimeoutInterval) {
        clearInterval(dispatchTimeoutInterval);
      }
      if (previewWorkerInterval) {
        clearInterval(previewWorkerInterval);
      }
      if (projectStageRecoveryInterval) {
        clearInterval(projectStageRecoveryInterval);
      }
      if (channelFileBackfillInterval) {
        clearInterval(channelFileBackfillInterval);
      }
      if (projectDocumentBundleBackfillInterval) {
        clearInterval(projectDocumentBundleBackfillInterval);
      }
      if (workspaceStagingCleanupInterval) {
        clearInterval(workspaceStagingCleanupInterval);
      }
      await coordinationScheduler?.stop();
      await taskClaimExpiryScheduler?.stop();
      stopVersionRefresh();
      await webApp?.close();
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await appWithCleanup.close();
    },
  };
}

function parseOriginList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function withCanonicalHostVariants(origins: string[]): string[] {
  const expanded = new Set(origins);
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      expanded.add(url.origin);
      if (url.hostname.startsWith('www.')) {
        url.hostname = url.hostname.slice(4);
        expanded.add(url.origin);
      } else {
        url.hostname = `www.${url.hostname}`;
        expanded.add(url.origin);
      }
    } catch {
      // Non-URL CORS values such as "*" are preserved as-is.
    }
  }
  return [...expanded];
}

function corsOriginFromList(origins: string[]): CorsOrigin {
  if (origins.length === 0) return false;
  return origins.length === 1 ? origins[0]! : origins;
}

function resolveRestCorsOrigin(env: NodeJS.ProcessEnv = process.env): CorsOrigin {
  const configured = withCanonicalHostVariants(parseOriginList(env.CORS_ORIGIN));
  if (configured.length > 0) return corsOriginFromList(configured);

  const webOrigins = withCanonicalHostVariants(parseOriginList(env.WEB_URL));
  if (webOrigins.length > 0) return corsOriginFromList(webOrigins);

  if (env.PORT) return DEFAULT_PRODUCTION_WEB_ORIGINS;
  return DEFAULT_LOCAL_WEB_ORIGINS;
}

function resolveRequestCorsOrigin(origin: CorsOrigin, requestOrigin?: string): string | undefined {
  if (!origin) return undefined;
  if (origin === '*') return '*';
  if (Array.isArray(origin)) {
    if (origin.includes('*')) return '*';
    return requestOrigin && origin.includes(requestOrigin) ? requestOrigin : undefined;
  }
  return origin;
}

function handleRestCors(request: IncomingMessage, response: ServerResponse, origin: CorsOrigin): boolean {
  const allowedOrigin = resolveRequestCorsOrigin(origin, request.headers.origin);
  if (allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return true;
  }
  return false;
}

function startDispatchTimeoutScheduler(
  app: ServerNextUseCases,
  realtime: ServerNextRealtime,
  config: DispatchTimeoutSchedulerConfig,
): ReturnType<typeof setInterval> | null {
  if (config.intervalMs <= 0 || config.heartbeatTimeoutMs <= 0 || config.legacyTimeoutMs <= 0) {
    return null;
  }
  return setInterval(async () => {
    const result = await app.failTimedOutDispatches({
      heartbeatCutoff: Date.now() - config.heartbeatTimeoutMs,
      legacyCutoff: Date.now() - config.legacyTimeoutMs,
    });
    if (!result.ok) {
      return;
    }
    for (const dispatch of result.dispatches) {
      realtime.emitDispatchStatus(dispatch);
      await realtime.refreshAgents(dispatch.teamId);
    }
  }, config.intervalMs);
}

interface CoordinationSchedulerConfig {
  intervalMs: number;
  limit?: number;
}

function startCoordinationScheduler(
  app: ServerNextUseCases,
  enabled: boolean,
  config: CoordinationSchedulerConfig,
): { stop(): Promise<void> } | null {
  if (!enabled || config.intervalMs <= 0) return null;
  let stopped = false;
  let running: Promise<void> | null = null;
  const run = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        await app.runCoordinationCycle(config.limit === undefined ? undefined : { limit: config.limit });
      } catch {
        // 单轮失败不终止 consumer；running lease 会让异常中断的 Job 后续可恢复。
      }
    })().finally(() => {
      running = null;
    });
  };
  run();
  const interval = setInterval(run, config.intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await running;
    },
  };
}

function createTaskClaimExpiryMetrics() {
  const snapshot: TaskClaimExpiryMetricSnapshot = {
    cycles: 0,
    failedCycles: 0,
    expiredClaims: 0,
    reofferAttempts: 0,
    reofferedOffers: 0,
    reofferFailures: 0,
  };
  return {
    recordCycle(expiredClaims: number, reofferAttempts: number, reofferedOffers: number) {
      snapshot.cycles += 1;
      snapshot.expiredClaims += expiredClaims;
      snapshot.reofferAttempts += reofferAttempts;
      snapshot.reofferedOffers += reofferedOffers;
    },
    recordFailedCycle() {
      snapshot.cycles += 1;
      snapshot.failedCycles += 1;
    },
    recordReofferFailure() {
      snapshot.reofferFailures += 1;
    },
    snapshot(): TaskClaimExpiryMetricSnapshot {
      return { ...snapshot };
    },
  };
}

function startTaskClaimExpiryScheduler(
  broker: TaskClaimBroker,
  realtime: ServerNextRealtime,
  config: TaskClaimExpirySchedulerConfig,
  metrics: ReturnType<typeof createTaskClaimExpiryMetrics>,
): { stop(): Promise<void> } | null {
  if (config.intervalMs <= 0) return null;
  const maxAutomaticReoffers = config.maxAutomaticReoffersPerTask ?? 1;
  let stopped = false;
  let running: Promise<void> | null = null;
  const run = () => {
    if (stopped || running) return;
    running = (async () => {
      let expiredClaims: Awaited<ReturnType<ServerNextRealtime['expireTaskClaims']>>;
      try {
        // expireTaskClaims 先提交 Claim expiry/Task reopen，再广播可见过期状态。
        expiredClaims = await realtime.expireTaskClaims();
      } catch {
        metrics.recordFailedCycle();
        return;
      }
      let reofferAttempts = 0;
      let reofferedOffers = 0;
      for (const expired of expiredClaims) {
        try {
          if (!await broker.canAutoReofferExpiredChannelCollaborationClaim(expired, {
            maxAutomaticReoffers,
          })) continue;
          reofferAttempts += 1;
          const result = await realtime.offerTaskClaims(expired.taskId, {
            allowedAgentIds: [expired.agentId],
          });
          reofferedOffers += result.offered;
        } catch {
          // 单个 Task 的恢复失败不阻塞同轮其他 Agent；下一次人工动作仍可按权威状态恢复。
          metrics.recordReofferFailure();
        }
      }
      metrics.recordCycle(expiredClaims.length, reofferAttempts, reofferedOffers);
    })().finally(() => {
      running = null;
    });
  };
  run();
  const interval = setInterval(run, config.intervalMs);
  interval.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await running;
    },
  };
}

interface ArtifactHttpInput {
  app: ServerNextUseCases;
  config: ServerNextDevConfig;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  previewService?: ArtifactPreviewService;
}

/** #1043 Device-only snapshot refresh; authority is rechecked by the use case. */
async function handleDeviceWorkspaceSnapshotHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/channels\/([^/]+)\/device-workspace-snapshots\/([^/]+)$/);
  if (!match) return false;
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const token = readToken(input.url, input.request);
  if (!token) {
    writeJson(input.response, 401, { ok: false, error: 'UNAUTHENTICATED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const channelId = decodeURIComponent(match[2] ?? '');
  const snapshotId = decodeURIComponent(match[3] ?? '');
  const result = await input.app.getDeviceWorkspaceSnapshot({ token, teamId, channelId, snapshotId });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, { ok: true, snapshot: result.snapshot });
  return true;
}

async function handleAgentWorkspaceHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/agents\/([^/]+)\/workspace$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const agentId = decodeURIComponent(match[2] ?? '');
  const token = readToken(input.url, input.request);
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    writeAckFailure(input.response, session);
    return true;
  }
  const result = await input.app.listAgentWorkspaceRuns({
    userId: session.user.id,
    teamId,
    agentId,
  });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, {
    ok: true,
    teamId,
    agentId,
    runs: result.runs.map((run) => ({
      ...run,
      files: run.files.map(withArtifactUrls),
    })),
  });
  return true;
}

async function handleAgentEnvHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/agents\/([^/]+)\/env$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const agentId = decodeURIComponent(match[2] ?? '');
  const token = readBearerToken(input.request);
  if (!token) {
    writeJson(input.response, 401, { ok: false, error: 'UNAUTHENTICATED' });
    return true;
  }
  const result = await input.app.getAgentEnvForDevice({ token, teamId, agentId });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, { ok: true, env: result.env });
  return true;
}

/**
 * CI 每日更新日志 LLM 兜底端点（仅内部调用）：
 * POST /api/internal/changelog-summarize，Bearer token（env AGENTBEAN_CHANGELOG_INTERNAL_TOKEN）。
 * 请求 { pulls: [{ number, title, body }] }；响应 { ok, results: [{ number, entries: [{ type, text }] }] }。
 * 未配置 token → 503；token 不匹配 → 401；输入非法 → 400。模型 fail-open 由 usecase 保证。
 */
async function handleChangelogSummarizeHttp(input: ArtifactHttpInput): Promise<boolean> {
  const { app, config, request, response, url } = input;
  if (url.pathname !== '/api/internal/changelog-summarize') {
    return false;
  }
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const expected = config.changelogInternalToken;
  if (!expected) {
    writeJson(response, 503, { ok: false, error: 'INTERNAL_ENDPOINT_NOT_CONFIGURED' });
    return true;
  }
  const auth = request.headers.authorization ?? '';
  if (auth !== `Bearer ${expected}`) {
    writeJson(response, 401, { ok: false, error: 'UNAUTHORIZED' });
    return true;
  }
  let body: { pulls?: unknown };
  try {
    body = (await readJsonBody(request)) as { pulls?: unknown };
  } catch {
    // readJsonBody 对非法 JSON 抛异常：作为 400 返回，避免落入外层 500 路径。
    writeJson(response, 400, { ok: false, error: 'INVALID_JSON_BODY' });
    return true;
  }
  const rawPulls = body.pulls;
  if (
    !Array.isArray(rawPulls) || rawPulls.length === 0 || rawPulls.length > 100
    || rawPulls.some((item) => typeof item !== 'object' || item === null)
  ) {
    writeJson(response, 400, { ok: false, error: 'INVALID_PULLS' });
    return true;
  }
  const pulls = rawPulls.map((item) => {
    const pull = item as { number?: unknown; title?: unknown; body?: unknown };
    return {
      number: Number(pull.number),
      title: typeof pull.title === 'string' ? pull.title : '',
      body: typeof pull.body === 'string' ? pull.body : '',
    };
  });
  const result = await app.summarizeChangelogEntries({ pulls });
  if (!result.ok) {
    writeAckFailure(response, result);
    return true;
  }
  // SuccessAck 为属性展开（{ ok: true } & payload），成功载荷直接是 results。
  writeJson(response, 200, { ok: true, results: result.results });
  return true;
}

async function handleTeamWorkspaceRunsHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/workspace-runs$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const token = readToken(input.url, input.request);
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    writeAckFailure(input.response, session);
    return true;
  }
  const status = parseWorkspaceRunStatus(input.url.searchParams.get('status'));
  if (status === 'invalid') {
    writeJson(input.response, 400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid workspace run status' });
    return true;
  }
  const pageSizeParam = readOptionalQueryString(input.url, 'pageSize');
  const pageSize = pageSizeParam === undefined ? undefined : Number(pageSizeParam);
  const result = await input.app.listTeamWorkspaceRuns({
    userId: session.user.id,
    teamId,
    agentId: readOptionalQueryString(input.url, 'agentId'),
    deviceId: readOptionalQueryString(input.url, 'deviceId'),
    status,
    cursor: readOptionalQueryString(input.url, 'cursor'),
    pageSize: pageSize !== undefined && Number.isFinite(pageSize) ? pageSize : undefined,
  });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, {
    ok: true,
    teamId,
    runs: result.runs.map((run) => ({
      workspaceRun: run.workspaceRun,
      artifacts: run.artifacts.map(withArtifactUrls),
    })),
    nextCursor: result.nextCursor,
  });
  return true;
}

async function handleWorkspaceRunHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/workspace-runs\/([^/]+)$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const runId = decodeURIComponent(match[2] ?? '');
  const token = readToken(input.url, input.request);
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    writeAckFailure(input.response, session);
    return true;
  }
  const result = await input.app.getWorkspaceRunDetail({
    userId: session.user.id,
    teamId,
    runId,
  });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, {
    ok: true,
    workspaceRun: result.workspaceRun,
    artifacts: result.artifacts,
  });
  return true;
}

async function handleWorkspaceRunLogHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/workspace-runs\/([^/]+)\/log$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const runId = decodeURIComponent(match[2] ?? '');
  const token = readToken(input.url, input.request);
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    writeAckFailure(input.response, session);
    return true;
  }
  const result = await input.app.getWorkspaceRunLogFile({
    userId: session.user.id,
    teamId,
    runId,
  });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  const storedPath = resolveStoredArtifactPath(input, result.storagePath);
  if (!storedPath.ok) {
    writeJson(input.response, storedPath.status, storedPath.payload);
    return true;
  }
  const query = readOptionalQueryString(input.url, 'query');
  const tailLines = clampIntegerQuery(input.url, 'tailLines', DEFAULT_WORKSPACE_LOG_TAIL_LINES, 1, 2000);
  const maxBytes = clampIntegerQuery(input.url, 'maxBytes', MAX_WORKSPACE_LOG_RESPONSE_BYTES, 1024, MAX_WORKSPACE_LOG_RESPONSE_BYTES);
  const log = query
    ? await searchWorkspaceRunLogFile({ absolutePath: storedPath.absolutePath, query, maxBytes })
    : readWorkspaceRunLogTail({ absolutePath: storedPath.absolutePath, tailLines, maxBytes });
  writeJson(input.response, 200, {
    ok: true,
    teamId,
    runId,
    artifact: withArtifactUrls(result.artifact),
    ...log,
  });
  return true;
}

/**
 * #967 / #1003 Workspace publish staging HTTP 面。
 * - POST .../begin  JSON
 * - POST .../put    multipart 或 raw body
 * - GET  ...?channelId&publishId
 * - POST .../commit JSON
 * - GET  .../workspace?channelId  → 当前 revision（device 冻结 baseline）
 */
async function handleWorkspacePublishStagingHttp(input: ArtifactHttpInput): Promise<boolean> {
  const baseMatch = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/workspace-publish-staging(?:\/(begin|put|commit))?$/);
  const workspaceMatch = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/project-channel-workspace$/);
  if (!baseMatch && !workspaceMatch) return false;
  const teamId = decodeURIComponent((baseMatch?.[1] ?? workspaceMatch?.[1]) ?? '');
  try {
    if (workspaceMatch) {
      if (input.request.method !== 'GET') {
        writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const channelId = input.url.searchParams.get('channelId')?.trim() ?? '';
      const revisionId = input.url.searchParams.get('revisionId')?.trim() || undefined;
      if (!channelId) {
        throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'channelId is required' });
      }
      const token = readToken(input.url, input.request, {});
      const result = await getWorkspaceForToken(input, token, {
        teamId,
        channelId,
        revisionId,
        ...(input.url.searchParams.get('agentId')?.trim() ? { agentId: input.url.searchParams.get('agentId')!.trim() } : {}),
      });
      if (!result.ok) {
        writeAckFailure(input.response, result);
        return true;
      }
      writeJson(input.response, 200, { ok: true, workspace: result.workspace });
      return true;
    }

    const action = baseMatch?.[2]; // undefined = GET list/status
    const token = readToken(input.url, input.request, {});

    if (input.request.method === 'GET' && !action) {
      const channelId = input.url.searchParams.get('channelId')?.trim() ?? '';
      const publishId = input.url.searchParams.get('publishId')?.trim() ?? '';
      if (!channelId || !publishId) {
        throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'channelId and publishId are required' });
      }
      const result = await getWorkspaceStagingForToken(input, token, { teamId, channelId, publishId });
      if (!result.ok) {
        writeAckFailure(input.response, result);
        return true;
      }
      writeJson(input.response, 200, { ok: true, staging: result.staging });
      return true;
    }

    if (input.request.method === 'POST' && action === 'begin') {
      const body = await readJsonBody(input.request) as Record<string, unknown>;
      const result = await beginWorkspaceStagingForToken(input, readToken(input.url, input.request, body) ?? token, {
        teamId,
        channelId: readRequiredString(body, 'channelId'),
        publishId: readRequiredString(body, 'publishId'),
        // baselineRevisionId 可选:无 workspace 频道(DM / 新建)首次发布时为空,
        // 由 usecase 层(#1099)commit 端 bootstrap 建 workspace。修前 route 用
        // readRequiredString 在调 usecase 前就抛 BAD_REQUEST,使 #1099 放宽失效。
        baselineRevisionId: typeof body.baselineRevisionId === 'string' ? body.baselineRevisionId.trim() : '',
        files: Array.isArray(body.files) ? body.files as BeginWorkspacePublishStagingInput['files'] : [],
        provenance: body.provenance as BeginWorkspacePublishStagingInput['provenance'] | undefined,
      });
      if (!result.ok) {
        writeAckFailure(input.response, result);
        return true;
      }
      writeJson(input.response, 200, { ok: true, staging: result.staging });
      return true;
    }

    if (input.request.method === 'POST' && action === 'commit') {
      const body = await readJsonBody(input.request) as Record<string, unknown>;
      const result = await commitWorkspaceStagingForToken(input, readToken(input.url, input.request, body) ?? token, {
        teamId,
        channelId: readRequiredString(body, 'channelId'),
        publishId: readRequiredString(body, 'publishId'),
      });
      if (!result.ok) {
        writeAckFailure(input.response, result);
        return true;
      }
      writeJson(input.response, 200, {
        ok: true,
        staging: result.staging,
        ...(result.workspace ? { workspace: result.workspace } : {}),
      });
      return true;
    }

    if (input.request.method === 'POST' && action === 'put') {
      const contentType = input.request.headers['content-type'];
      let channelId: string;
      let publishId: string;
      let path: string;
      let offset: number;
      let content: Buffer;
      let putToken = token;
      if (typeof contentType === 'string' && contentType.toLowerCase().startsWith('multipart/form-data')) {
        const multipart = await readMultipartUpload(
          input.request,
          contentType,
          input.config.dataDir,
          input.config.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES,
        );
        try {
          channelId = readRequiredString(multipart.fields, 'channelId');
          publishId = readRequiredString(multipart.fields, 'publishId');
          path = readRequiredString(multipart.fields, 'path');
          offset = Number(multipart.fields.offset ?? '0');
          if (!Number.isFinite(offset) || offset < 0) {
            throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid offset' });
          }
          content = readFileSync(multipart.file.tempPath);
        } finally {
          safeUnlink(multipart.file.tempPath);
        }
        putToken = readToken(input.url, input.request, multipart.fields) ?? token;
      } else {
        const maxBytes = input.config.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
        content = await readRequestBody(input.request, maxBytes);
        channelId = input.url.searchParams.get('channelId')?.trim()
          || (typeof input.request.headers['x-channel-id'] === 'string' ? input.request.headers['x-channel-id'].trim() : '');
        publishId = input.url.searchParams.get('publishId')?.trim()
          || (typeof input.request.headers['x-publish-id'] === 'string' ? input.request.headers['x-publish-id'].trim() : '');
        path = input.url.searchParams.get('path')?.trim()
          || (typeof input.request.headers['x-workspace-path'] === 'string' ? safeDecodePathHeader(input.request.headers['x-workspace-path'].trim()) : '');
        offset = Number(input.url.searchParams.get('offset') ?? input.request.headers['x-upload-offset'] ?? '0');
        if (!channelId || !publishId || !path) {
          throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'channelId, publishId and path are required' });
        }
        if (!Number.isFinite(offset) || offset < 0) {
          throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid offset' });
        }
      }
      const result = await putWorkspaceStagingForToken(input, putToken, {
        teamId, channelId, publishId, path, offset, content,
      });
      if (!result.ok) {
        writeAckFailure(input.response, result);
        return true;
      }
      writeJson(input.response, 200, { ok: true, staging: result.staging });
      return true;
    }

    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  } catch (error) {
    if (error instanceof ArtifactHttpError) {
      writeJson(input.response, error.status, error.payload);
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeJson(input.response, 500, { ok: false, error: 'INTERNAL_ERROR', message });
    return true;
  }
}

type StagingAck = { ok: true; staging: unknown; workspace?: unknown } | { ok: false; error?: string; message?: string; details?: unknown };

async function putWorkspaceStagingForToken(
  input: ArtifactHttpInput,
  token: string | undefined,
  put: {
    teamId: string;
    channelId: string;
    publishId: string;
    path: string;
    offset: number;
    content: Buffer;
  },
): Promise<StagingAck> {
  if (isDeviceToken(token)) {
    return input.app.putWorkspacePublishStagingFileForDevice({
      token,
      teamId: put.teamId,
      channelId: put.channelId,
      publishId: put.publishId,
      path: put.path,
      offset: put.offset,
      content: put.content,
    });
  }
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) return session;
  return input.app.putWorkspacePublishStagingFile({
    userId: session.user.id,
    teamId: put.teamId,
    channelId: put.channelId,
    publishId: put.publishId,
    path: put.path,
    offset: put.offset,
    content: put.content,
  });
}

async function beginWorkspaceStagingForToken(
  input: ArtifactHttpInput,
  token: string | undefined,
  begin: {
    teamId: string;
    channelId: string;
    publishId: string;
    baselineRevisionId: string;
    files: BeginWorkspacePublishStagingInput['files'];
    provenance?: BeginWorkspacePublishStagingInput['provenance'];
  },
): Promise<StagingAck> {
  if (isDeviceToken(token)) {
    return input.app.beginWorkspacePublishStagingForDevice({
      token,
      teamId: begin.teamId,
      channelId: begin.channelId,
      publishId: begin.publishId,
      baselineRevisionId: begin.baselineRevisionId,
      files: begin.files,
      ...(begin.provenance ? { provenance: begin.provenance } : {}),
    });
  }
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) return session;
  return input.app.beginWorkspacePublishStaging({
    userId: session.user.id,
    teamId: begin.teamId,
    channelId: begin.channelId,
    publishId: begin.publishId,
    baselineRevisionId: begin.baselineRevisionId,
    files: begin.files,
    ...(begin.provenance ? { provenance: begin.provenance } : {}),
  });
}

async function getWorkspaceStagingForToken(
  input: ArtifactHttpInput,
  token: string | undefined,
  get: { teamId: string; channelId: string; publishId: string },
): Promise<StagingAck> {
  if (isDeviceToken(token)) {
    return input.app.getWorkspacePublishStagingForDevice({
      token,
      teamId: get.teamId,
      channelId: get.channelId,
      publishId: get.publishId,
    });
  }
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) return session;
  return input.app.getWorkspacePublishStaging({
    userId: session.user.id,
    teamId: get.teamId,
    channelId: get.channelId,
    publishId: get.publishId,
  });
}

async function commitWorkspaceStagingForToken(
  input: ArtifactHttpInput,
  token: string | undefined,
  commit: { teamId: string; channelId: string; publishId: string },
): Promise<StagingAck> {
  if (isDeviceToken(token)) {
    return input.app.commitWorkspacePublishStagingForDevice({
      token,
      teamId: commit.teamId,
      channelId: commit.channelId,
      publishId: commit.publishId,
    });
  }
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) return session;
  return input.app.commitWorkspacePublishStaging({
    userId: session.user.id,
    teamId: commit.teamId,
    channelId: commit.channelId,
    publishId: commit.publishId,
  });
}

async function getWorkspaceForToken(
  input: ArtifactHttpInput,
  token: string | undefined,
  get: { teamId: string; channelId: string; revisionId?: string; agentId?: string },
): Promise<{ ok: true; workspace: unknown } | { ok: false; error?: string; message?: string }> {
  if (isDeviceToken(token)) {
    return input.app.materializeProjectChannelWorkspace({
      token,
      teamId: get.teamId,
      channelId: get.channelId,
      ...(get.revisionId ? { revisionId: get.revisionId } : {}),
      ...(get.agentId ? { agentId: get.agentId } : {}),
    });
  }
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) return session;
  return input.app.getProjectChannelWorkspace({
    userId: session.user.id,
    teamId: get.teamId,
    channelId: get.channelId,
    ...(get.revisionId ? { revisionId: get.revisionId } : {}),
  });
}

async function handleArtifactHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/artifacts(?:\/upload|\/([^/]+)\/(preview|download|preview-derivative))$/);
  if (!match) {
    return false;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  try {
    if (input.request.method === 'POST' && input.url.pathname.endsWith('/upload')) {
      await handleArtifactUpload(input, teamId);
      return true;
    }
    const artifactId = match[2] ? decodeURIComponent(match[2]) : '';
    if (input.request.method === 'GET' && match[3] === 'preview-derivative' && artifactId) {
      await handleArtifactDerivativeRead(input, { teamId, artifactId });
      return true;
    }
    const disposition = match[3] === 'download' ? 'attachment' : 'inline';
    if (input.request.method === 'GET' && artifactId) {
      await handleArtifactRead(input, {
        teamId,
        artifactId,
        disposition,
        expectedArtifactVersionId: readOptionalQueryString(input.url, 'artifactVersionId'),
        agentId: readOptionalQueryString(input.url, 'agentId'),
      });
      return true;
    }
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  } catch (error) {
    if (error instanceof ArtifactHttpError) {
      writeJson(input.response, error.status, error.payload);
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeJson(input.response, 500, { ok: false, error: 'INTERNAL_ERROR', message });
    return true;
  }
}

async function handleArtifactUpload(input: ArtifactHttpInput, teamId: string): Promise<void> {
  const upload = await readArtifactUpload(input);
  let cleanupPath = upload.tempPath;
  try {
    const token = readToken(input.url, input.request, upload.fields);
    const filename = sanitizeFilename(upload.filename);
    const artifactId = randomUUID();
    const relativeStoragePath = join('artifacts', teamId, artifactId, filename);
    const deviceUpload = isDeviceToken(token);
    const deviceRole = deviceUpload ? parseArtifactRole(upload.fields.artifactRole) : undefined;
    const deviceSourceRoot = deviceUpload ? parseArtifactSourceRoot(upload.fields) : undefined;
    const uploadInput = {
      teamId,
      channelId: upload.channelId,
      filename,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
       storagePath: relativeStoragePath,
       relativePath: filename,
       role: deviceRole ?? (deviceUpload ? 'run_output' : 'attachment'),
       ...(deviceSourceRoot ? { sourceRoot: deviceSourceRoot } : {}),
       sha256: upload.sha256,
    };
    const absoluteDir = join(input.config.dataDir, 'artifacts', teamId, artifactId);
    const absolutePath = join(absoluteDir, filename);
    if (upload.tempPath) {
      mkdirSync(absoluteDir, { recursive: true });
      renameSync(upload.tempPath, absolutePath);
      cleanupPath = absolutePath;
    } else if (upload.content) {
      mkdirSync(absoluteDir, { recursive: true });
      cleanupPath = absolutePath;
      writeFileSync(absolutePath, upload.content, { flag: 'wx' });
    }
    const result = deviceUpload
      ? await input.app.uploadArtifactForDevice({
        ...uploadInput,
        token,
        // #1056：跨 Team 上传按声明的执行 Agent 逐 Agent 授权（daemon 总是附带）。
        ...(typeof upload.fields.agentId === 'string' && upload.fields.agentId.trim()
          ? { agentId: upload.fields.agentId.trim() }
          : {}),
      })
      : await uploadArtifactForSession(input, token, uploadInput);
    if (!result.ok) {
      writeAckFailure(input.response, result);
      return;
    }
    cleanupPath = undefined;
     writeJson(input.response, 201, {
       ok: true,
       artifact: withArtifactUrls(result.artifact),
     });
     await input.previewService?.enqueue({
       artifactId: result.artifact.id,
       teamId,
       inputPath: join(input.config.dataDir, 'artifacts', teamId, result.artifact.id, filename),
       mimeType: result.artifact.mimeType,
     });
   } finally {
     if (cleanupPath) safeUnlink(cleanupPath);
   }
}

async function handleArtifactDerivativeRead(
  input: ArtifactHttpInput,
  options: { teamId: string; artifactId: string },
): Promise<void> {
  if (!input.previewService) {
    writeJson(input.response, 404, { ok: false, error: 'PREVIEW_NOT_FOUND' });
    return;
  }
  const token = readToken(input.url, input.request);
  const result = isDeviceToken(token)
    ? await input.app.getArtifactFileForDevice({ token, teamId: options.teamId, artifactId: options.artifactId })
    : await getArtifactFileForSession(input, token, options);
  if (!result.ok) { writeAckFailure(input.response, result); return; }
  const preview = await input.previewService.get(options.artifactId);
  if (!preview || preview.status !== 'ready') {
    writeJson(input.response, preview?.status === 'pending' || preview?.status === 'processing' ? 202 : 404, { ok: false, error: preview?.status === 'unsupported' ? 'PREVIEW_UNSUPPORTED' : 'PREVIEW_NOT_READY', preview });
    return;
  }
  const previewPath = join(input.config.dataDir, 'artifact-previews', options.teamId, options.artifactId, 'preview.webp');
  const stored = resolveStoredArtifactPath(input, previewPath);
  if (!stored.ok) { writeJson(input.response, stored.status, stored.payload); return; }
  const sizeBytes = statSync(stored.absolutePath).size;
  input.response.writeHead(200, { 'content-type': 'image/webp', 'content-length': String(sizeBytes), 'cache-control': 'private, max-age=31536000, immutable', 'content-disposition': 'inline' });
  createReadStream(stored.absolutePath).pipe(input.response);
}

async function handleArtifactRead(
  input: ArtifactHttpInput,
  options: {
    teamId: string;
    artifactId: string;
    disposition: 'inline' | 'attachment';
    expectedArtifactVersionId?: string;
    agentId?: string;
  },
): Promise<void> {
  const token = readToken(input.url, input.request);
  const result = isDeviceToken(token)
    ? await input.app.getArtifactFileForDevice({
        token,
        teamId: options.teamId,
        artifactId: options.artifactId,
        ...(options.expectedArtifactVersionId ? { expectedArtifactVersionId: options.expectedArtifactVersionId } : {}),
        ...(options.agentId ? { agentId: options.agentId } : {}),
      })
    : await getArtifactFileForSession(input, token, options);
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return;
  }
  const stored = resolveStoredArtifactPath(input, result.storagePath);
  if (!stored.ok) {
    writeJson(input.response, stored.status, stored.payload);
    return;
  }
  const fileSize = statSync(stored.absolutePath).size;
  if (options.expectedArtifactVersionId && result.artifact.sizeBytes !== fileSize) {
    writeJson(input.response, 409, { ok: false, error: 'ARTIFACT_SIZE_MISMATCH' });
    return;
  }
  const markdownPreview = options.disposition === 'inline'
    && (result.artifact.mimeType === 'text/markdown' || /\.(?:md|markdown)$/i.test(result.artifact.filename));
  if (markdownPreview) {
    if (fileSize > 10 * 1024 * 1024) {
      writeJson(input.response, 413, { ok: false, error: 'MARKDOWN_PREVIEW_TOO_LARGE' });
      return;
    }
    let body = readFileSync(stored.absolutePath);
    if (!isUtf8(body)) {
      writeJson(input.response, 415, { ok: false, error: 'MARKDOWN_PREVIEW_REQUIRES_UTF8' });
      return;
    }
    if (body.length > 2 * 1024 * 1024) {
      let previewBytes = 2 * 1024 * 1024;
      while (previewBytes > 0 && !isUtf8(body.subarray(0, previewBytes))) previewBytes -= 1;
      body = body.subarray(0, previewBytes);
    }
    input.response.writeHead(200, {
      'content-type': result.artifact.mimeType,
      'content-length': String(body.length),
      ...(fileSize > body.length ? { 'x-agentbean-preview-truncated': 'true' } : {}),
      'content-disposition': buildContentDisposition('inline', result.artifact.filename),
    });
    input.response.end(body);
    return;
  }
  const streamingEnabled = input.config.channelFileRollout?.streaming ?? false;
  const range = streamingEnabled
    ? parseArtifactRange(input.request.headers.range, fileSize)
    : { kind: 'full' as const };
  if (range.kind === 'partial') {
    input.config.channelFileMetrics?.increment('rangeResponses');
  }
  if (range.kind === 'invalid') {
    input.response.writeHead(416, { 'content-range': `bytes */${fileSize}`, 'accept-ranges': 'bytes' });
    input.response.end();
    return;
  }
  const start = range.kind === 'partial' ? range.start : 0;
  const end = range.kind === 'partial' ? range.end : fileSize - 1;
  const contentLength = fileSize === 0 ? 0 : end - start + 1;
  const disposition = shouldForceArtifactDownload(result.artifact.mimeType)
    ? 'attachment'
    : options.disposition;
  input.response.writeHead(range.kind === 'partial' ? 206 : 200, {
    'content-type': result.artifact.mimeType,
    'content-length': String(contentLength),
    'content-disposition': buildContentDisposition(disposition, result.artifact.filename),
    ...(streamingEnabled ? { 'accept-ranges': 'bytes' } : {}),
    ...(range.kind === 'partial' ? { 'content-range': `bytes ${start}-${end}/${fileSize}` } : {}),
    ...(options.expectedArtifactVersionId ? { 'x-artifact-version-id': options.expectedArtifactVersionId } : {}),
  });
  if (contentLength === 0) {
    input.response.end();
    return;
  }
  createReadStream(stored.absolutePath, { start, end }).pipe(input.response);
}

async function uploadArtifactForSession(
  input: ArtifactHttpInput,
  token: string | undefined,
  upload: {
    teamId: string;
    channelId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storagePath: string;
    relativePath: string;
    sha256: string;
    role?: ArtifactRole;
    sourceRoot?: ArtifactSourceRootDto;
  },
): ReturnType<ArtifactHttpInput['app']['uploadArtifact']> {
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    return session;
  }
  return input.app.uploadArtifact({
    userId: session.user.id,
    ...upload,
  });
}

async function getArtifactFileForSession(
  input: ArtifactHttpInput,
  token: string | undefined,
  options: { teamId: string; artifactId: string },
): ReturnType<ArtifactHttpInput['app']['getArtifactFile']> {
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    return session;
  }
  return input.app.getArtifactFile({
    userId: session.user.id,
    teamId: options.teamId,
    artifactId: options.artifactId,
  });
}

function withArtifactUrls(artifact: ArtifactDto): ArtifactDto {
  return {
    ...artifact,
    previewUrl: `/api/teams/${encodeURIComponent(artifact.teamId)}/artifacts/${encodeURIComponent(artifact.id)}/preview`,
    downloadUrl: `/api/teams/${encodeURIComponent(artifact.teamId)}/artifacts/${encodeURIComponent(artifact.id)}/download`,
  };
}

async function readJsonBody(request: ArtifactHttpInput['request']): Promise<Record<string, unknown>> {
  const rawBody = await readRequestBody(request, MAX_LEGACY_ARTIFACT_UPLOAD_BODY_BYTES);
  if (rawBody.length === 0) return {};
  return parseJsonBody(rawBody);
}

async function readArtifactUpload(input: ArtifactHttpInput): Promise<{
  fields: Record<string, unknown>;
  channelId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  tempPath?: string;
  content?: Buffer;
}> {
  const contentType = input.request.headers['content-type'];
  if (typeof contentType === 'string' && contentType.toLowerCase().startsWith('multipart/form-data')) {
    const multipart = await readMultipartUpload(
      input.request,
      contentType,
      input.config.dataDir,
      input.config.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES,
    );
    try {
      return {
        fields: multipart.fields,
        channelId: readRequiredString(multipart.fields, 'channelId'),
        filename: multipart.file.filename,
        mimeType: multipart.file.mimeType,
        sizeBytes: multipart.file.sizeBytes,
        sha256: multipart.file.sha256,
        tempPath: multipart.file.tempPath,
      };
    } catch (error) {
      safeUnlink(multipart.file.tempPath);
      throw error;
    }
  }
  const body = await readJsonBody(input.request);
  const contentBase64 = readRequiredString(body, 'contentBase64');
  const content = Buffer.from(contentBase64, 'base64');
  if (content.length === 0 && contentBase64.length > 0) {
    throw new ArtifactHttpError(400, { ok: false, error: 'INVALID_CONTENT' });
  }
  if (content.length > (input.config.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES)) {
    throw new ArtifactHttpError(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  }
  return {
    fields: body,
    channelId: readRequiredString(body, 'channelId'),
    filename: readRequiredString(body, 'filename'),
    mimeType: typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim()
      : 'application/octet-stream',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    content,
  };
}

interface MultipartUploadResult {
  fields: Record<string, string>;
  file: { filename: string; mimeType: string; sizeBytes: number; sha256: string; tempPath: string };
}

async function readMultipartUpload(
  request: IncomingMessage,
  contentType: string,
  dataDir: string,
  maxArtifactBytes: number,
): Promise<MultipartUploadResult> {
  mkdirSync(dataDir, { recursive: true });
  const Busboy = createRequire(import.meta.url)('busboy') as (options: {
    headers: IncomingMessage['headers'];
    limits: { fileSize: number; files: number; fieldSize: number; fields: number; parts: number };
    defParamCharset?: string;
  }) => NodeJS.WritableStream & { destroy(error?: Error): void; on(event: string, listener: (...args: any[]) => void): unknown };
  const parser = Busboy({
    headers: request.headers,
    limits: { fileSize: maxArtifactBytes, files: 1, fieldSize: 64 * 1024, fields: 16, parts: 18 },
    // 浏览器把 multipart 的 filename 参数按 UTF-8 字节发送；busboy 默认按 latin1 解码，
    // 会导致中文等非 ASCII 文件名乱码（如 中文文档.md -> 一串下划线）。
    defParamCharset: 'utf8',
  });
  const fields: Record<string, string> = {};
  let fileResult: MultipartUploadResult['file'] | undefined;
  let filePromise: Promise<void> | undefined;
  let failure: Error | undefined;
  const rejectPartLimit = (): void => {
    failure = new ArtifactHttpError(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
    parser.destroy(failure);
  };
  parser.on('fieldsLimit', rejectPartLimit);
  parser.on('partsLimit', rejectPartLimit);
  parser.on('field', (name: string, value: string) => { fields[name] = value; });
  parser.on('file', (name: string, file: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
    if (name !== 'file' || fileResult) {
      file.resume();
      return;
    }
    const tempPath = join(dataDir, `.artifact-upload-${randomUUID()}.part`);
    const output = createWriteStream(tempPath, { flags: 'wx' });
    const hash = createHash('sha256');
    let sizeBytes = 0;
    file.on('data', (chunk: Buffer) => { sizeBytes += chunk.length; hash.update(chunk); });
    file.on('limit', () => {
      failure = new ArtifactHttpError(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
    });
    filePromise = pipeline(file as NodeJS.ReadableStream, output).then(() => {
      fileResult = { filename: info.filename || 'artifact.bin', mimeType: info.mimeType || 'application/octet-stream', sizeBytes, sha256: hash.digest('hex'), tempPath };
    }).catch((error: unknown) => {
      safeUnlink(tempPath);
      throw error;
    });
  });
  try {
    await pipeline(request, parser);
    await filePromise;
    if (failure) {
      if (fileResult?.tempPath) safeUnlink(fileResult.tempPath);
      throw failure;
    }
  } catch (error) {
    if (filePromise) {
      try {
        await filePromise;
      } catch {
        // The file pipeline already removes its partial output on failure.
      }
    }
    if (fileResult?.tempPath) safeUnlink(fileResult.tempPath);
    if (failure) throw failure;
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Invalid multipart upload' });
  }
  if (!fileResult) throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Missing multipart file' });
  return { fields, file: fileResult };
}

async function readRequestBody(request: ArtifactHttpInput['request'], maxBytes: number): Promise<Buffer> {
  const contentLength = readContentLength(request);
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new ArtifactHttpError(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    received += buffer.length;
    if (received > maxBytes) {
      throw new ArtifactHttpError(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function readContentLength(request: ArtifactHttpInput['request']): number | undefined {
  const rawLength = request.headers['content-length'];
  if (typeof rawLength !== 'string') {
    return undefined;
  }
  const parsed = Number(rawLength);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseArtifactRole(value: unknown): ArtifactRole | undefined {
  return value === 'intermediate' || value === 'run_output' || value === 'deliverable' || value === 'attachment' ? value : undefined;
}

function parseArtifactSourceRoot(fields: Record<string, unknown>): ArtifactSourceRootDto | undefined {
  const id = typeof fields.sourceRootId === 'string' ? fields.sourceRootId.trim() : '';
  const kind = typeof fields.sourceRootKind === 'string' ? fields.sourceRootKind.trim() : '';
  const label = typeof fields.sourceRootLabel === 'string' ? fields.sourceRootLabel.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)
    || !label
    || label.length > 120
    || label === '.'
    || label === '..'
    || /[/\\\u0000-\u001f]/.test(label)) return undefined;
  if (kind !== 'run_output' && kind !== 'agent_workspace' && kind !== 'configured_output' && kind !== 'adapter_generated' && kind !== 'legacy_run') return undefined;
  return { id, kind, label };
}

function parsePositiveByteLimit(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Cleanup is best effort; the original upload error remains authoritative.
  }
}

function parseArtifactRange(
  header: string | undefined,
  fileSize: number,
): { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'invalid' } {
  if (!header) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || fileSize <= 0) return { kind: 'invalid' };
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (!rawStart && !rawEnd) return { kind: 'invalid' };
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };
    return { kind: 'partial', start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= fileSize || requestedEnd < start) {
    return { kind: 'invalid' };
  }
  return { kind: 'partial', start, end: Math.min(requestedEnd, fileSize - 1) };
}

function parseJsonBody(rawBody: Buffer): Record<string, unknown> {
  const raw = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid JSON body' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid JSON body' });
  }
  return parsed as Record<string, unknown>;
}

function parseMultipartBody(rawBody: Buffer, contentType: string): {
  fields: Record<string, string>;
  file: { filename: string; mimeType: string; content: Buffer };
} {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Missing multipart boundary' });
  }
  const fields: Record<string, string> = {};
  let file: { filename: string; mimeType: string; content: Buffer } | undefined;
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = findMultipartBoundary(rawBody, delimiter, 0);
  while (cursor >= 0) {
    let partStart = cursor + delimiter.length;
    if (rawBody.subarray(partStart, partStart + 2).toString('latin1') === '--') break;
    if (rawBody.subarray(partStart, partStart + 2).toString('latin1') === '\r\n') {
      partStart += 2;
    } else if (rawBody.subarray(partStart, partStart + 1).toString('latin1') === '\n') {
      partStart += 1;
    }
    const next = findMultipartBoundary(rawBody, delimiter, partStart);
    if (next < 0) break;
    const part = trimTrailingLineBreak(rawBody.subarray(partStart, next));
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    const fallbackSeparator = separator < 0 ? part.indexOf(Buffer.from('\n\n')) : -1;
    const headerEnd = separator >= 0 ? separator : fallbackSeparator;
    if (headerEnd >= 0) {
      const separatorLength = separator >= 0 ? 4 : 2;
      const headers = parseMultipartHeaders(part.subarray(0, headerEnd).toString('utf8'));
      const disposition = headers['content-disposition'] ?? '';
      const name = disposition.match(/(?:^|;\s*)name="([^"]+)"/)?.[1];
      const filename = disposition.match(/(?:^|;\s*)filename="([^"]*)"/)?.[1];
      const content = part.subarray(headerEnd + separatorLength);
      if (name && filename !== undefined) {
        file = {
          filename: filename || 'artifact.bin',
          mimeType: headers['content-type'] ?? 'application/octet-stream',
          content,
        };
      } else if (name) {
        fields[name] = content.toString('utf8');
      }
    }
    cursor = next;
  }
  if (!file) {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Missing multipart file' });
  }
  return { fields, file };
}

function findMultipartBoundary(rawBody: Buffer, delimiter: Buffer, from: number): number {
  let cursor = rawBody.indexOf(delimiter, from);
  while (cursor >= 0) {
    if (isMultipartBoundary(rawBody, delimiter, cursor)) return cursor;
    cursor = rawBody.indexOf(delimiter, cursor + 1);
  }
  return -1;
}

function isMultipartBoundary(rawBody: Buffer, delimiter: Buffer, cursor: number): boolean {
  const isAtLineStart = cursor === 0 || rawBody[cursor - 1] === 0x0a;
  if (!isAtLineStart) return false;
  const afterDelimiter = cursor + delimiter.length;
  return rawBody.subarray(afterDelimiter, afterDelimiter + 2).toString('latin1') === '--'
    || rawBody.subarray(afterDelimiter, afterDelimiter + 2).toString('latin1') === '\r\n'
    || rawBody.subarray(afterDelimiter, afterDelimiter + 1).toString('latin1') === '\n';
}

function parseMultipartHeaders(rawHeaders: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of rawHeaders.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index > 0) {
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
  }
  return headers;
}

function trimTrailingLineBreak(value: Buffer): Buffer {
  if (value.subarray(-2).toString('latin1') === '\r\n') {
    return value.subarray(0, -2);
  }
  if (value.subarray(-1).toString('latin1') === '\n') {
    return value.subarray(0, -1);
  }
  return value;
}

/**
 * x-workspace-path header 的安全解码:daemon 对 path 做 encodeURIComponent(header 只许
 * Latin-1,中文路径直塞会被 undici 拒)。query 参数是权威传输,此 header 仅为兜底;
 * 解码失败(如含裸 % 的合法 ASCII 路径)回退原文。
 */
function safeDecodePathHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readToken(url: URL, request: ArtifactHttpInput['request'], body: Record<string, unknown> = {}): string | undefined {
  const queryToken = url.searchParams.get('token') ?? undefined;
  const bodyToken = typeof body.token === 'string' ? body.token : undefined;
  return readBearerToken(request) ?? queryToken ?? bodyToken;
}

function readBearerToken(request: ArtifactHttpInput['request']): string | undefined {
  const auth = request.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
}

function isDeviceToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.startsWith('abn_device.');
}

function readOptionalQueryString(url: URL, field: string): string | undefined {
  const value = url.searchParams.get(field);
  return value?.trim() || undefined;
}

function clampIntegerQuery(url: URL, field: string, fallback: number, min: number, max: number): number {
  const raw = readOptionalQueryString(url, field);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseWorkspaceRunStatus(value: string | null): WorkspaceRunStatus | 'invalid' | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return WORKSPACE_RUN_STATUSES.has(trimmed as WorkspaceRunStatus) ? trimmed as WorkspaceRunStatus : 'invalid';
}

function readRequiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: `Missing ${field}` });
  }
  return value.trim();
}

function sanitizeFilename(filename: string): string {
  // 保留 Unicode 字母/数字（含中文），仅替换路径分隔符与不安全字符，避免中文名被改写成下划线。
  const safe = basename(filename).replace(/[^\p{L}\p{N} ._@-]/gu, '_').trim();
  return safe || 'artifact.bin';
}

function buildContentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const fallback = basename(filename)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'artifact.bin';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function shouldForceArtifactDownload(mimeType: string): boolean {
  return !isSafeArtifactInlinePreviewMimeType(mimeType);
}

function resolveStoredArtifactPath(
  input: ArtifactHttpInput,
  storagePath: string | undefined,
): { ok: true; absolutePath: string } | { ok: false; status: number; payload: unknown } {
  if (!storagePath) {
    return { ok: false, status: 404, payload: { ok: false, error: 'FILE_MISSING' } };
  }
  const dataRoot = resolve(input.config.dataDir);
  const absolutePath = resolve(dataRoot, storagePath);
  if (!isPathInside(dataRoot, absolutePath) || !existsSync(absolutePath)) {
    return { ok: false, status: 404, payload: { ok: false, error: 'FILE_MISSING' } };
  }
  return { ok: true, absolutePath };
}

function readWorkspaceRunLogTail(input: {
  absolutePath: string;
  tailLines: number;
  maxBytes: number;
}): {
  mode: 'tail';
  text: string;
  returnedLines: number;
  truncated: boolean;
} {
  const size = statSync(input.absolutePath).size;
  const readBytes = Math.min(size, input.maxBytes);
  if (readBytes <= 0) {
    return { mode: 'tail', text: '', returnedLines: 0, truncated: false };
  }
  const fd = openSync(input.absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(readBytes);
    readSync(fd, buffer, 0, readBytes, size - readBytes);
    const lines = buffer.toString('utf8').split(/\r\n|\r|\n/);
    const droppedPartialPrefix = size > readBytes && !buffer.toString('utf8').startsWith('\n');
    const completeLines = droppedPartialPrefix ? lines.slice(1) : lines;
    const selectedLines = completeLines.slice(-input.tailLines);
    return {
      mode: 'tail',
      text: selectedLines.join('\n'),
      returnedLines: selectedLines.length,
      truncated: size > readBytes || completeLines.length > input.tailLines,
    };
  } finally {
    closeSync(fd);
  }
}

async function searchWorkspaceRunLogFile(input: {
  absolutePath: string;
  query: string;
  maxBytes: number;
}): Promise<{
  mode: 'search';
  text: string;
  totalLines: number;
  returnedLines: number;
  matchedLines: number;
  query: string;
  truncated: boolean;
}> {
  const query = input.query.trim();
  const normalizedQuery = query.toLowerCase();
  const stream = createReadStream(input.absolutePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selectedLines: string[] = [];
  let selectedBytes = 0;
  let totalLines = 0;
  let matchedLines = 0;
  let truncated = false;
  for await (const line of lines) {
    totalLines += 1;
    if (!line.toLowerCase().includes(normalizedQuery)) {
      continue;
    }
    matchedLines += 1;
    const nextBytes = Buffer.byteLength(line, 'utf8') + (selectedLines.length > 0 ? 1 : 0);
    if (selectedBytes + nextBytes <= input.maxBytes) {
      selectedLines.push(line);
      selectedBytes += nextBytes;
    } else {
      truncated = true;
    }
  }
  return {
    mode: 'search',
    text: selectedLines.join('\n'),
    totalLines,
    returnedLines: selectedLines.length,
    matchedLines,
    query,
    truncated: truncated || matchedLines > selectedLines.length,
  };
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function isPathInside(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!!delta && !delta.startsWith('..') && !isAbsolute(delta));
}

function writeAckFailure(response: ArtifactHttpInput['response'], ack: { error?: string; message?: string; details?: unknown }): void {
  const status = ack.error === 'UNAUTHENTICATED'
    ? 401
    : ack.error === 'FORBIDDEN'
      ? 403
      : ack.error === 'NOT_FOUND'
        ? 404
        : ack.error === 'CONFLICT'
          ? 409
          : 400;
  writeJson(response, status, {
    ok: false,
    error: ack.error ?? 'ERROR',
    message: ack.message,
    ...(ack.details !== undefined ? { details: ack.details } : {}),
  });
}

function writeInternalHttpError(response: ArtifactHttpInput['response'], error: unknown): void {
  console.error(
    '[server-next] HTTP request threw:',
    error instanceof Error ? error.stack ?? error.message : error,
  );
  if (!response.headersSent) {
    writeJson(response, 500, { ok: false, error: 'INTERNAL_ERROR', message: INTERNAL_HTTP_ERROR_MESSAGE });
    return;
  }
  response.end();
}

function writeJson(response: ArtifactHttpInput['response'], status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

class ArtifactHttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super('Artifact HTTP request failed');
  }
}

function readPreviewHtml(): string {
  const path = findPreviewHtmlPath();
  if (path) {
    return readFileSync(path, 'utf8');
  }
  throw new Error('web-next preview page not found');
}

async function createWebAppHandler(config: ServerNextDevConfig): Promise<WebAppHandler> {
  const createNextApp = loadNextAppFactory();
  const dir = findWebNextDir();
  console.log(`AgentBean Next preparing web app from ${dir}`);
  const nextApp = createNextApp({
    dev: false,
    dir,
    hostname: config.host,
    port: config.port,
  });
  await nextApp.prepare();
  console.log('AgentBean Next web app prepared');
  const handle = nextApp.getRequestHandler();
  return {
    async handle(request, response) {
      await handle(request, response);
    },
    async close() {
      await nextApp.close();
    },
  };
}

function loadNextAppFactory(): NextAppFactory {
  const requireFromHere = createRequire(import.meta.url);
  const loaded = requireFromHere('next') as NextAppFactory | { default?: NextAppFactory };
  if (typeof loaded === 'function') {
    return loaded;
  }
  if (typeof loaded.default === 'function') {
    return loaded.default;
  }
  throw new Error('next module did not expose an app factory');
}

function findWebNextDir(): string {
  const previewPath = findPreviewHtmlPath();
  if (previewPath) {
    return dirname(dirname(previewPath));
  }
  const candidates = [
    new URL('../../../../../web-next', import.meta.url),
    new URL('../../web-next', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/web-next')),
  ];
  for (const candidate of candidates) {
    try {
      const path = candidate.pathname;
      if (existsSync(join(path, 'package.json'))) {
        return path;
      }
    } catch {
      // Try the next known repository layout.
    }
  }
  throw new Error('web-next app directory not found');
}

export type MessageIngestionMode = 'legacy' | 'durable-job' | 'message-tracer';

/** Resolve host ingestion mode: explicit arg > env > durable-job (production default). */
export function resolveMessageIngestionMode(
  explicit?: MessageIngestionMode,
  env: NodeJS.ProcessEnv = process.env,
): MessageIngestionMode {
  if (explicit === 'legacy' || explicit === 'durable-job' || explicit === 'message-tracer') {
    return explicit;
  }
  const fromEnv = env.AGENTBEAN_NEXT_MESSAGE_INGESTION_MODE?.trim();
  if (fromEnv === 'legacy' || fromEnv === 'durable-job' || fromEnv === 'message-tracer') {
    return fromEnv;
  }
  return 'durable-job';
}

/** #921 Message tracer command 路径开关（默认 false）。explicit > env `AGENTBEAN_NEXT_MESSAGE_TRACER_ENABLED`。 */
export function resolveMessageTracerEnabled(
  explicit?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const fromEnv = env.AGENTBEAN_NEXT_MESSAGE_TRACER_ENABLED?.trim().toLowerCase();
  return fromEnv === '1' || fromEnv === 'true';
}

function createDefaultApp(
  config: ServerNextDevConfig,
  Database: BetterSqlite3Constructor | undefined,
  messageIngestionMode: MessageIngestionMode = 'durable-job',
  messageTracerEnabled: boolean = false,
  onMessageTracerDelivered?: (delivery: { teamId: string; channelId: string; messageId: string }) => Promise<void> | void,
  onWorkspaceRevisionCommitted?: (payload: WorkspaceRevisionCommittedPayload) => Promise<void> | void,
  onChannelCollaborationMessageAppended?: (
    delivery: { teamId: string; channelId: string; messageId: string },
  ) => Promise<void> | void,
): AppWithCleanup {
  const artifactContentStore = createFileArtifactContentStore(config.dataDir);
  // #1005：生产/dev host 始终用 dataDir 磁盘 staging，避免大文件塞 team SQLite BLOB。
  const stagingContentStore = createFileWorkspaceStagingContentStore(config.dataDir);
  const channelFileRollout = config.channelFileRollout ?? parseChannelFileRolloutConfig();
  const channelFileMetrics = config.channelFileMetrics ?? createChannelFileMetrics();
  const projectDocumentRollout = config.projectDocumentRollout ?? parseProjectDocumentRolloutConfig();
  const projectCollaborationRollout = config.projectCollaborationRollout
    ?? parseProjectCollaborationRolloutConfig();
  const projectCollaborationMetrics = config.projectCollaborationMetrics
    ?? createProjectCollaborationMetrics();
  if (config.storage === 'memory') {
    const artifactPreviewService = channelFileRollout.previewWorker
      ? createArtifactPreviewService({ outputDir: join(config.dataDir, 'artifact-previews') })
      : undefined;
    const repositories = createInMemoryRepositories();
    const clock = { now: () => Date.now() };
    const ids = { nextId: () => randomUUID() };
    const serverCapsuleRuntimeContextResolver = createDefaultServerCapsuleRuntimeContextResolver(
      repositories, ids,
    );
    const serverWorker = createDefaultServerWorker(config, clock, ids);
    let appForPiReadiness: ServerNextUseCases | undefined;
    const resolvePiConfigurationReady = async () => {
      const result = await appForPiReadiness?.getPiConfigurationReadiness();
      return result?.ok === true && result.readiness.status === 'ready';
    };
    const resolvePiRuntimeHealthy = async () => !getEmergencyStopActive();
    const resolvePiAutomationAvailable = async () => {
      const [configurationReady, runtimeHealthy] = await Promise.all([
        resolvePiConfigurationReady(),
        resolvePiRuntimeHealthy(),
      ]);
      return configurationReady && runtimeHealthy;
    };
    // broker 先于 management runtime 构造：#807 AC#2 的 allocationService 需要它解析候选。
    const taskClaimBroker = createTaskClaimBroker({
      repositories, clock, ids, piAutomationAvailable: resolvePiAutomationAvailable,
    });
    const management = createDefaultManagementRuntime(
      repositories, clock, ids, serverCapsuleRuntimeContextResolver, taskClaimBroker,
      resolvePiAutomationAvailable,
      projectCollaborationRollout.managerAutoAdvance,
      serverWorker?.pool,
      { queueTimeoutMs: serverWorker?.queueTimeoutMs, leaseTtlMs: serverWorker?.leaseTtlMs },
      onChannelCollaborationMessageAppended,
    );
    const app = createServerNextUseCases({
      repositories,
      clock,
      ids,
      sessionSecret: config.sessionSecret,
      artifactContentStore,
      stagingContentStore,
      channelFileRollout,
      channelFileMetrics,
      projectCollaborationRollout,
      projectCollaborationMetrics,
      ...artifactPreviewBindings(artifactPreviewService, config.dataDir),
      managementRouter: management.router,
      managementKernel: management.kernel,
      taskCoordinationKernel: management.taskCoordinationKernel,
      serverCapsuleRuntimeContextResolver,
      resolvePiAutomationAvailable,
      resolveProjectStageCandidates: (taskId, options) =>
        taskClaimBroker.resolveProjectStageCandidates(taskId, options?.dependencyTaskIds),
      // #1064：Task-linked @Agent 请求的 eligibility 解析（复用 broker resolveCandidates，
      // 含 operation restriction / Team visibility / 渠道门禁；fail closed 由复验链兜底）。
      resolveTaskLinkedEligibleAgentIds: async (taskId) => {
        try {
          const resolution = await taskClaimBroker.resolveCandidates(taskId);
          return resolution.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.agentId);
        } catch {
          return [];
        }
      },
      isDeviceRuntimeDisconnected: (deviceId) => taskClaimBroker.isDeviceDisconnected(deviceId),
      onChannelCollaborationTasksPublished: management.publishChannelCollaborationTasks,
      onChannelCollaborationMessageAppended,
      ...(projectCollaborationRollout.managerAutoAdvance
        ? {
            onProjectFactsChanged: async (scope: { teamId: string; channelId: string }) => {
              await management.advanceProjectStages(scope);
            },
          }
        : {}),
      messageIngestionMode,
      messageTracerEnabled,
      onMessageTracerDelivered,
      onWorkspaceRevisionCommitted,
    });
    appForPiReadiness = app;
    return {
      app,
      artifactPreviewService,
      projectDocumentBundleBackfill: createProjectDocumentBundleBackfillIfEnabled({
        repositories, app, clock, rollout: projectDocumentRollout,
      }),
      managementWorkerScheduler: management.scheduler,
      serverWorkerScheduler: management.serverScheduler,
      taskClaimBroker,
      serverWorkerPool: serverWorker?.pool,
      serverWorkerAuthToken: serverWorker?.authToken,
      bindManagementDispatchEmitter: management.bindDispatchEmitter,
      bindTaskClaimEmitter: management.bindTaskClaimEmitter,
      ...(projectCollaborationRollout.managerAutoAdvance
        ? { recoverProjectStages: management.recoverProjectStages }
        : {}),
      reconcileDisconnectedDevicesOnStart: false,
      close: async () => undefined,
    };
  }

  mkdirSync(config.dataDir, { recursive: true });
  const Sqlite = Database ?? loadBetterSqlite3();
  const globalDb = new Sqlite(join(config.dataDir, 'global.sqlite'));
  const teamDb = new Sqlite(join(config.dataDir, 'team.sqlite'));
  applyGlobalMigrations(globalDb);
  applyTeamMigrations(teamDb);
  const artifactPreviewService = channelFileRollout.previewWorker
    ? createArtifactPreviewService({
        outputDir: join(config.dataDir, 'artifact-previews'),
        repository: createSqliteArtifactPreviewRepository(teamDb),
      })
    : undefined;
  const channelFileBackfill = channelFileRollout.historyBackfill
    ? createChannelFileBackfillIfSupported({
        db: teamDb,
        dataDir: config.dataDir,
      })
    : undefined;
  // PRD §6：清理 channel_agent_members 中被 0009 删除的 executor-hosted agent 留下的孤儿行。
  // 必须在两个迁移都跑完后、且 globalDbPath 已知时执行（详见函数注释）。
  cleanupOrphanedChannelMembers(join(config.dataDir, 'global.sqlite'), teamDb);
  const repositories = createSqliteRepositories({ globalDb, teamDb });
  const clock = { now: () => Date.now() };
  const ids = { nextId: () => randomUUID() };
  const serverCapsuleRuntimeContextResolver = createDefaultServerCapsuleRuntimeContextResolver(
    repositories, ids,
  );
  const serverWorker = createDefaultServerWorker(config, clock, ids);
  let appForPiReadiness: ServerNextUseCases | undefined;
  const resolvePiConfigurationReady = async () => {
    const result = await appForPiReadiness?.getPiConfigurationReadiness();
    return result?.ok === true && result.readiness.status === 'ready';
  };
  const resolvePiRuntimeHealthy = async () => !getEmergencyStopActive();
  const resolvePiAutomationAvailable = async () => {
    const [configurationReady, runtimeHealthy] = await Promise.all([
      resolvePiConfigurationReady(),
      resolvePiRuntimeHealthy(),
    ]);
    return configurationReady && runtimeHealthy;
  };
  // broker 先于 management runtime 构造：#807 AC#2 的 allocationService 需要它解析候选。
  const taskClaimBroker = createTaskClaimBroker({
    repositories, clock, ids, piAutomationAvailable: resolvePiAutomationAvailable,
  });
  const management = createDefaultManagementRuntime(
    repositories, clock, ids, serverCapsuleRuntimeContextResolver, taskClaimBroker,
    resolvePiAutomationAvailable,
    projectCollaborationRollout.managerAutoAdvance,
    serverWorker?.pool,
    { queueTimeoutMs: serverWorker?.queueTimeoutMs, leaseTtlMs: serverWorker?.leaseTtlMs },
    onChannelCollaborationMessageAppended,
  );
  const app = createServerNextUseCases({
    repositories,
    clock,
    ids,
    sessionSecret: config.sessionSecret,
    artifactContentStore,
    stagingContentStore,
    channelFileRollout,
    channelFileMetrics,
    projectCollaborationRollout,
    projectCollaborationMetrics,
    ...artifactPreviewBindings(artifactPreviewService, config.dataDir),
    managementRouter: management.router,
    managementKernel: management.kernel,
    taskCoordinationKernel: management.taskCoordinationKernel,
    serverCapsuleRuntimeContextResolver,
    resolvePiAutomationAvailable,
    resolveProjectStageCandidates: (taskId, options) =>
      taskClaimBroker.resolveProjectStageCandidates(taskId, options?.dependencyTaskIds),
    resolveTaskLinkedEligibleAgentIds: async (taskId) => {
      try {
        const resolution = await taskClaimBroker.resolveCandidates(taskId);
        return resolution.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.agentId);
      } catch {
        return [];
      }
    },
    isDeviceRuntimeDisconnected: (deviceId) => taskClaimBroker.isDeviceDisconnected(deviceId),
    onChannelCollaborationTasksPublished: management.publishChannelCollaborationTasks,
    onChannelCollaborationMessageAppended,
    ...(projectCollaborationRollout.managerAutoAdvance
      ? {
          onProjectFactsChanged: async (scope: { teamId: string; channelId: string }) => {
            await management.advanceProjectStages(scope);
          },
        }
      : {}),
    messageIngestionMode,
    messageTracerEnabled,
    onMessageTracerDelivered,
    onWorkspaceRevisionCommitted,
  });
  appForPiReadiness = app;
  return {
    app,
    artifactPreviewService,
    channelFileBackfill,
    projectDocumentBundleBackfill: createProjectDocumentBundleBackfillIfEnabled({
      repositories, app, clock, rollout: projectDocumentRollout,
    }),
    managementWorkerScheduler: management.scheduler,
    serverWorkerScheduler: management.serverScheduler,
    taskClaimBroker,
    serverWorkerPool: serverWorker?.pool,
    serverWorkerAuthToken: serverWorker?.authToken,
    bindManagementDispatchEmitter: management.bindDispatchEmitter,
    bindTaskClaimEmitter: management.bindTaskClaimEmitter,
    ...(projectCollaborationRollout.managerAutoAdvance
      ? { recoverProjectStages: management.recoverProjectStages }
      : {}),
    reconcileDisconnectedDevicesOnStart: true,
    async close() {
      globalDb.close();
      teamDb.close();
    },
  };
}

/**
 * #830：开关关闭时返回 undefined —— 回填的存在与否完全不影响既有 Bundle 读路径与
 * #770 文件库，因此关闭它只是「不再产生新的裁决」，没有任何回退动作。
 */
function createProjectDocumentBundleBackfillIfEnabled(input: {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  clock: { now(): number };
  rollout: ProjectDocumentRolloutConfig;
}) {
  if (!input.rollout.bundleBackfill) return undefined;
  return createProjectDocumentBundleBackfill({
    repositories: input.repositories,
    app: input.app,
    clock: input.clock,
    mode: input.rollout.bundleBackfillDryRun ? 'dry_run' : 'apply',
  });
}

function artifactPreviewBindings(
  service: ArtifactPreviewService | undefined,
  dataDir: string,
): Pick<CreateServerNextUseCasesInput, 'resolveArtifactPreview' | 'onArtifactCommitted'> {
  if (!service) return {};
  const enqueue = async (artifact: ArtifactRecord) => {
    if (!artifact.storagePath) return;
    await service.enqueue({
      artifactId: artifact.id,
      teamId: artifact.teamId,
      inputPath: join(dataDir, artifact.storagePath),
      mimeType: artifact.mimeType,
    });
  };
  return {
    async onArtifactCommitted(artifact) {
      await enqueue(artifact);
    },
    async resolveArtifactPreview(artifact) {
      let preview = await service.get(artifact.id);
      if (!preview) {
        await enqueue(artifact);
        preview = await service.get(artifact.id);
      }
      return preview;
    },
  };
}

function createDefaultServerWorker(
  config: ServerNextDevConfig,
  clock: { now(): number },
  ids: { nextId(): string },
): { pool: ServerWorkerPool; authToken: string; queueTimeoutMs?: number; leaseTtlMs?: number } | undefined {
  if (!config.serverWorker) return undefined;
  return {
    pool: createServerWorkerPool({
      workerPoolId: config.serverWorker.workerPoolId,
      providerCredentialRef: config.serverWorker.providerCredentialRef,
      clock,
      ids,
    }),
    authToken: config.serverWorker.authToken,
    ...(config.serverWorker.queueTimeoutMs ? { queueTimeoutMs: config.serverWorker.queueTimeoutMs } : {}),
    ...(config.serverWorker.leaseTtlMs ? { leaseTtlMs: config.serverWorker.leaseTtlMs } : {}),
  };
}

function createDefaultServerCapsuleRuntimeContextResolver(
  repositories: ServerNextRepositories,
  ids: { nextId(): string },
) {
  const validator = createCapsuleInjectionValidator({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: createServerMemorySearchPermissions(repositories),
    ids,
  });
  return createServerCapsuleRuntimeContextService({
    unitOfWork: repositories.memoryUnitOfWork,
    validator,
    ids,
    currentPolicyVersion: () => CURRENT_MEMORY_POLICY_VERSION,
  });
}

function createDefaultManagementRuntime(
  repositories: ServerNextRepositories,
  clock: { now(): number },
  ids: { nextId(): string },
  memoryCapsules: ReturnType<typeof createDefaultServerCapsuleRuntimeContextResolver>,
  taskClaimBroker: TaskClaimBroker,
  piAutomationAvailable: () => Promise<boolean>,
  projectStageAutoAdvanceEnabled: boolean,
  serverWorkerPool?: ServerWorkerPool,
  serverWorkerTuning?: { queueTimeoutMs?: number; leaseTtlMs?: number },
  onChannelCollaborationMessageAppended?: (
    delivery: { teamId: string; channelId: string; messageId: string },
  ) => Promise<void> | void,
) {
  let dispatchEmitter: ((dispatchId: string) => Promise<void>) | undefined;
  let taskClaimEmitter: ((taskId: string, options?: {
    readonly allowedAgentIds?: readonly string[];
    readonly projectStageAuto?: boolean;
  }) => Promise<{ readonly offered: number }>) | undefined;
  const kernel = createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock,
    ids,
  });
  const taskCoordinationKernel = createTaskCoordinationKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  const taskLifecycleKernel = createTaskLifecycleKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  const subtaskAcceptanceService = createSubtaskAcceptanceService({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  const memorySearchService = createCollaborativeMemorySearchService({
    repositories: repositories.memory,
    permissions: createServerMemorySearchPermissions(repositories),
  });
  const memoryCapsuleService = createMemoryCapsuleService({
    searchService: memorySearchService,
    unitOfWork: repositories.memoryUnitOfWork,
    clock,
    ids,
  });
  const memoryCandidateService = createMemoryCandidateService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: createServerMemoryCandidatePermissions(repositories),
    clock,
    ids,
  });
  const collaborativeMemoryService = createCollaborativeMemoryService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: createServerMemoryWritePermissions(repositories),
    clock,
    ids,
  });
  const projectStageInvocationGateway = createInvocationGateway({ repositories, clock, ids });
  const projectStageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const projectStageRetryAttempts = new Map<string, number>();
  let projectStageAutoAdvance: ReturnType<typeof createProjectStageAutoAdvance>;
  const scheduleProjectStageRetry = (claim: ProjectStageClaimGranted) => {
    const key = `${claim.managementRunId}:${claim.taskId}:${claim.claimLeaseId}`;
    if (projectStageRetryTimers.has(key)) return;
    const attempt = projectStageRetryAttempts.get(key) ?? 0;
    const delayMs = Math.min(1_000 * (2 ** attempt), 30_000);
    projectStageRetryAttempts.set(key, attempt + 1);
    const timer = setTimeout(() => {
      projectStageRetryTimers.delete(key);
      void repositories.tasks.getById(claim.taskId).then(async (task) => {
        if (!task?.channelId) return;
        const outcomes = await projectStageAutoAdvance.advanceChannel({
          teamId: task.teamId,
          channelId: task.channelId,
        });
        const outcome = outcomes.find((item) => item.taskId === claim.taskId);
        if (outcome?.reason === 'automation_unavailable') {
          scheduleProjectStageRetry(claim);
        } else {
          projectStageRetryAttempts.delete(key);
        }
      }).catch(() => {
        scheduleProjectStageRetry(claim);
      });
    }, delayMs);
    timer.unref();
    projectStageRetryTimers.set(key, timer);
  };
  const invokeClaimedProjectStage = async (claim: ProjectStageClaimGranted) => {
    try {
      const invoked = await projectStageInvocationGateway.invokeClaimedProjectStage({
        managementRunId: claim.managementRunId,
        idempotencyKey: [
          'project-stage-auto',
          claim.taskId,
          claim.taskRevision,
          claim.taskAttempt,
          claim.claimLeaseId,
        ].join(':'),
        taskId: claim.taskId,
        expectedTaskRevision: claim.taskRevision,
        taskAttempt: claim.taskAttempt,
        claimLeaseId: claim.claimLeaseId,
        targetAgentId: claim.targetAgentId,
        objective: claim.objective,
        attachmentIds: [],
      });
      const view = invoked.view.activeDispatchId
        ? invoked.view
        : await projectStageInvocationGateway.retryClaimedProjectStage({
          managementRunId: claim.managementRunId,
          invocationId: invoked.view.id,
        });
      const dispatchId = view.activeDispatchId;
      if (!dispatchId) throw new Error('MANAGEMENT_ACTIVE_DISPATCH_MISSING');
      if (!dispatchEmitter) throw new Error('MANAGEMENT_DISPATCH_EMITTER_UNAVAILABLE');
      try {
        await dispatchEmitter(dispatchId);
      } catch {
        await projectStageInvocationGateway.completeAttempt({
          dispatchId,
          status: 'failed',
          error: 'MANAGEMENT_DISPATCH_EMIT_FAILED',
          actorKind: 'system',
        });
        throw new Error('MANAGEMENT_DISPATCH_EMIT_FAILED');
      }
    } catch (error) {
      scheduleProjectStageRetry(claim);
      throw error;
    }
  };
  const invokeClaimedChannelCollaborationTask = async (claim: ProjectStageClaimGranted) => {
    const task = await repositories.tasks.getById(claim.taskId);
    if (!task?.tags.includes(CHANNEL_COLLABORATION_TASK_TAG)) return;
    await recordChannelCollaborationClaim({
      repositories,
      clock,
      ids,
      claim,
    });
    const invoked = await projectStageInvocationGateway.invokeClaimedProjectStage({
      managementRunId: claim.managementRunId,
      idempotencyKey: [
        'channel-collaboration',
        claim.taskId,
        claim.taskRevision,
        claim.taskAttempt,
        claim.claimLeaseId,
      ].join(':'),
      taskId: claim.taskId,
      expectedTaskRevision: claim.taskRevision,
      taskAttempt: claim.taskAttempt,
      claimLeaseId: claim.claimLeaseId,
      targetAgentId: claim.targetAgentId,
      objective: claim.objective,
      attachmentIds: [],
    });
    const view = invoked.view.activeDispatchId
      ? invoked.view
      : await projectStageInvocationGateway.retryClaimedProjectStage({
          managementRunId: claim.managementRunId,
          invocationId: invoked.view.id,
        });
    if (!view.activeDispatchId) throw new Error('MANAGEMENT_ACTIVE_DISPATCH_MISSING');
    if (!dispatchEmitter) throw new Error('MANAGEMENT_DISPATCH_EMITTER_UNAVAILABLE');
    await dispatchEmitter(view.activeDispatchId);
  };
  projectStageAutoAdvance = createProjectStageAutoAdvance({
    repositories,
    broker: taskClaimBroker,
    piAutomationAvailable,
    invokeClaimedProjectStage,
    now: clock.now,
    emitTaskOffers: async (taskId, options) => {
      if (!taskClaimEmitter) throw new Error('TASK_CLAIM_EMITTER_UNAVAILABLE');
      await taskClaimEmitter(taskId, options);
    },
  });
  if (projectStageAutoAdvanceEnabled) {
    taskClaimBroker.bindProjectStageClaimGranted(invokeClaimedProjectStage);
  }
  taskClaimBroker.bindTaskClaimGranted(invokeClaimedChannelCollaborationTask);
  taskClaimBroker.bindTaskOfferResponseRecorded(async ({ taskId, response }) => {
    if (response.kind === 'accepted') return;
    const projected = await recordChannelCollaborationStatus({
      repositories,
      clock,
      status: {
        kind: 'offer_response',
        taskId,
        agentId: response.agentId,
        offerId: response.offerId,
        responseKind: response.kind,
      },
    });
    if (projected?.created) {
      await Promise.resolve(onChannelCollaborationMessageAppended?.({
        teamId: projected.message.teamId,
        channelId: projected.message.channelId,
        messageId: projected.message.id,
      })).catch(() => undefined);
    }
  });
  taskClaimBroker.bindTaskAllocationBlockedRecorded(async ({ taskId, agentId }) => {
    const projected = await recordChannelCollaborationStatus({
      repositories,
      clock,
      status: {
        kind: 'allocation_blocked',
        taskId,
        agentId,
      },
    });
    if (projected?.created) {
      await Promise.resolve(onChannelCollaborationMessageAppended?.({
        teamId: projected.message.teamId,
        channelId: projected.message.channelId,
        messageId: projected.message.id,
      })).catch(() => undefined);
    }
  });
  taskClaimBroker.bindTaskClaimExpired(async (expired) => {
    const projected = await recordChannelCollaborationStatus({
      repositories,
      clock,
      status: {
        kind: 'claim_expired',
        taskId: expired.taskId,
        agentId: expired.agentId,
        claimLeaseId: expired.claimLeaseId,
      },
    });
    if (projected?.created) {
      await Promise.resolve(onChannelCollaborationMessageAppended?.({
        teamId: projected.message.teamId,
        channelId: projected.message.channelId,
        messageId: projected.message.id,
      })).catch(() => undefined);
    }
  });
  const executeManagementTool = createManagementToolExecutor({
    kernel,
    managementMemoryUnitOfWork: repositories.managementMemoryUnitOfWork,
    handlers: createPhase1ManagementToolHandlers({
      repositories,
      kernel,
      taskCoordinationKernel,
      clock,
      ids,
      onDispatchCreated: async (dispatchId) => {
        if (!dispatchEmitter) throw new Error('MANAGEMENT_DISPATCH_EMITTER_UNAVAILABLE');
        await dispatchEmitter(dispatchId);
      },
    }),
    phase2Handlers: {
      ...createPhase2ManagementToolHandlers({ kernel: taskCoordinationKernel,
        repositories, taskLifecycleKernel,
        acceptanceService: subtaskAcceptanceService,
        // #807 AC#2：publish_for_claim 用真实 allocation 决策取代 kernel 的强转 open 兜底，
        // 使 PI 显式指派的子 Task 不再在发布瞬间被改成 open 并清空 assigneeId。
        allocationService: (taskId) => resolveTaskAllocation({
          taskId, broker: taskClaimBroker, repositories,
        }),
        // #948-B ADR-0064：publish 前预解算 offer candidate 列表（事务外 IO），
        // 传给 kernel 在 publishForClaim 事务内原子创建 offer。
        publishOfferResolutionService: async (taskId) => {
          const task = await repositories.tasks.getById(taskId);
          if (!task) return null;
          const resolution = await taskClaimBroker.resolveCandidates(taskId);
          const eligible = resolution.candidates.filter((c) => c.eligible && c.deviceId);
          if (eligible.length === 0) return null;
          const now = clock.now();
          const candidates = await Promise.all(eligible.map(async (c) => {
            const manifest = await repositories.agentExposure.manifests
              .getActiveByTeamAgent(task.teamId, c.agentId);
            const manifestRevision = manifest
              && (manifest.validUntil === null || manifest.validUntil > now)
              ? manifest.revision : 0;
            return {
              agentId: c.agentId,
              manifestRevision,
              hardSpecified: false,
              requirementConfirmation: false,
              projectStageAuto: false,
            };
          }));
          return { candidates, offerTtlMs: 15_000 };
        },
        onTaskPublished: async (taskId) => {
          if (!taskClaimEmitter) throw new Error('TASK_CLAIM_EMITTER_UNAVAILABLE');
          await taskClaimEmitter(taskId);
        },
        onTaskAccepted: async (taskId) => {
          if (!projectStageAutoAdvanceEnabled) return;
          const task = await repositories.tasks.getById(taskId);
          if (!task?.channelId) return;
          await projectStageAutoAdvance.advanceChannel({
            teamId: task.teamId,
            channelId: task.channelId,
          }).catch(() => undefined);
        } }),
      ...createPhase2InvocationToolHandlers({
        repositories,
        kernel,
        taskCoordinationKernel,
        clock,
        ids,
        onDispatchCreated: async (dispatchId) => {
          if (!dispatchEmitter) throw new Error('MANAGEMENT_DISPATCH_EMITTER_UNAVAILABLE');
          await dispatchEmitter(dispatchId);
        },
      }),
      ...createPhase2CollaborationToolHandlers({
        repositories,
        clock,
        ids,
        onDispatchCreated: async (dispatchId) => {
          if (!dispatchEmitter) throw new Error('MANAGEMENT_DISPATCH_EMITTER_UNAVAILABLE');
          await dispatchEmitter(dispatchId);
        },
      }),
    },
    phase3Handlers: createPhase3ManagementToolHandlers({
      repositories,
      searchService: memorySearchService,
      capsuleService: memoryCapsuleService,
      candidateService: memoryCandidateService,
      collaborativeService: collaborativeMemoryService,
      clock,
      currentPolicyVersion: CURRENT_MEMORY_POLICY_VERSION,
    }),
  });
  const scheduler = createDeviceWorkerScheduler({
    devices: repositories.devices,
    messages: repositories.messages,
    management: repositories.management,
    memoryCapsules,
    taskCoordinationUnitOfWork: repositories.taskCoordinationUnitOfWork,
    managementMemoryUnitOfWork: repositories.managementMemoryUnitOfWork,
    kernel,
    executeTool: executeManagementTool,
    clock,
    ids,
    leaseTokens: { nextToken: () => randomBytes(32).toString('base64url') },
  });
  const serverScheduler = serverWorkerPool ? createServerWorkerScheduler({
    pool: serverWorkerPool,
    management: repositories.management,
    messages: repositories.messages,
    taskCoordinationUnitOfWork: repositories.taskCoordinationUnitOfWork,
    memoryCapsules,
    repositories,
    executeTool: executeManagementTool,
    kernel,
    clock,
    ids,
    leaseTokens: { nextToken: () => randomBytes(32).toString('base64url') },
    ...(serverWorkerTuning?.queueTimeoutMs ? { queueTimeoutMs: serverWorkerTuning.queueTimeoutMs } : {}),
    ...(serverWorkerTuning?.leaseTtlMs ? { leaseTtlMs: serverWorkerTuning.leaseTtlMs } : {}),
  }) : undefined;
  const autoPlacementProbe = createAutoPlacementProbe({
    deviceScheduler: scheduler,
    ...(serverWorkerPool ? { serverWorkerPool } : {}),
  });
  const router = createManagementRouter({
    repositories,
    kernel,
    clock,
    ids,
    gateway: {
      async preflight({ teamId, target, placementPolicy }) {
        const device = target.deviceId ? await repositories.devices.getById(target.deviceId) : null;
        if (!device?.profileId) {
          return { workerAvailable: false, credentialAvailable: false, placementAllowed: false, budgetAvailable: true, targetAvailable: false };
        }
        return scheduler.managementPreflight({
          teamId,
          deviceId: device.id,
          profileId: device.profileId,
          placementPolicy,
          targetAvailable: target.status !== 'offline' && device.status === 'online',
        });
      },
      async preflightPhase2({ teamId, target, placementPolicy }) {
        if (placementPolicy.placement === 'managed') {
          return serverScheduler?.managementPreflight({
            placementPolicy,
            managementPhase: 2,
            targetAvailable: target ? target.status !== 'offline' : true,
          }) ?? { preflight: { workerAvailable: false, credentialAvailable: false,
            placementAllowed: true, budgetAvailable: true, targetAvailable: target ? target.status !== 'offline' : true } };
        }
        return scheduler.managementPhase2Preflight({
          teamId,
          placementPolicy,
          targetAvailable: target ? target.status !== 'offline' : true,
        });
      },
      async preflightPhase3({ teamId, target, placementPolicy }) {
        if (placementPolicy.placement === 'managed') {
          return serverScheduler?.managementPreflight({
            placementPolicy,
            managementPhase: 3,
            targetAvailable: target ? target.status !== 'offline' : true,
          }) ?? { preflight: { workerAvailable: false, credentialAvailable: false,
            placementAllowed: true, budgetAvailable: true, targetAvailable: target ? target.status !== 'offline' : true } };
        }
        return scheduler.managementPhase3Preflight({
          teamId,
          placementPolicy,
          targetAvailable: target ? target.status !== 'offline' : true,
        });
      },
      async probeAutoPlacement({ teamId, placementPolicy, managementPhase }) {
        return autoPlacementProbe({ teamId, placementPolicy, managementPhase });
      },
      async schedule(input) {
        const run = await repositories.management.runs.getById(input.managementRunId);
        if (run?.placementPolicy.placement === 'managed') {
          return serverScheduler?.scheduleManagementRun(input) ?? {
            schemaVersion: 1 as const,
            ok: false as const,
            errorCode: 'UNAVAILABLE' as const,
            diagnosticCode: 'SERVER_WORKER_SCHEDULER_NOT_CONFIGURED',
            retryable: false,
          };
        }
        return scheduler.scheduleManagementRun(input);
      },
    },
  });
  return {
    kernel,
    taskCoordinationKernel,
    scheduler,
    serverScheduler,
    router,
    advanceProjectStages(scope: { teamId: string; channelId: string }) {
      if (!projectStageAutoAdvanceEnabled) return Promise.resolve([]);
      return projectStageAutoAdvance.advanceChannel(scope);
    },
    async recoverProjectStages(teamId?: string) {
      if (!projectStageAutoAdvanceEnabled) return;
      const team = teamId ? await repositories.teams.getById(teamId) : null;
      const teams = teamId
        ? team ? [team] : []
        : await repositories.teams.listAll();
      for (const team of teams) {
        const channels = await repositories.channels.listByTeam(team.id);
        for (const channel of channels) {
          await projectStageAutoAdvance.advanceChannel({
            teamId: team.id,
            channelId: channel.id,
          }).catch(() => undefined);
        }
      }
    },
    bindDispatchEmitter(emit: (dispatchId: string) => Promise<void>) {
      dispatchEmitter = emit;
    },
    bindTaskClaimEmitter(emit: (taskId: string, options?: {
      readonly allowedAgentIds?: readonly string[];
      readonly projectStageAuto?: boolean;
    }) => Promise<{ readonly offered: number }>) {
      taskClaimEmitter = emit;
    },
    async publishChannelCollaborationTasks(taskIds: readonly string[]) {
      if (!taskClaimEmitter) throw new Error('TASK_CLAIM_EMITTER_UNAVAILABLE');
      const deliveries = await Promise.allSettled(taskIds.map((taskId) => taskClaimEmitter!(taskId)));
      const offered = deliveries.reduce((total, delivery) =>
        delivery.status === 'fulfilled' ? total + delivery.value.offered : total, 0);
      if (deliveries.every((delivery) => delivery.status === 'rejected')) {
        throw new Error('TASK_CLAIM_OFFER_DELIVERY_UNAVAILABLE');
      }
      return { offered };
    },
  };
}

function findPreviewHtmlPath(): string | undefined {
  const candidates = [
    new URL('../../../../../web-next/preview/index.html', import.meta.url),
    new URL('../../web-next/preview/index.html', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/web-next/preview/index.html')),
  ];
  for (const candidate of candidates) {
    try {
      const path = candidate.pathname;
      if (existsSync(path)) {
        return path;
      }
    } catch {
      // Try the next known repository layout.
    }
  }
  return undefined;
}

function createFileArtifactContentStore(dataDir: string): ArtifactContentStore {
  return {
    async writeContent(input) {
      const filename = sanitizeFilename(input.filename);
      const relativeStoragePath = join('artifacts', input.teamId, input.artifactId, filename);
      const absoluteDir = join(dataDir, 'artifacts', input.teamId, input.artifactId);
      mkdirSync(absoluteDir, { recursive: true });
      writeFileSync(join(absoluteDir, filename), input.content);
      return {
        storagePath: relativeStoragePath,
        sizeBytes: input.content.length,
        sha256: createHash('sha256').update(input.content).digest('hex'),
      };
    },
    async copyContent(input) {
      if (!input.sourceStoragePath) {
        throw new Error('Source artifact has no stored content');
      }
      const sourcePath = join(dataDir, input.sourceStoragePath);
      const content = readFileSync(sourcePath);
      const filename = sanitizeFilename(input.filename);
      const relativeStoragePath = join('artifacts', input.teamId, input.artifactId, filename);
      const absoluteDir = join(dataDir, 'artifacts', input.teamId, input.artifactId);
      mkdirSync(absoluteDir, { recursive: true });
      writeFileSync(join(absoluteDir, filename), content);
      return {
        storagePath: relativeStoragePath,
        sizeBytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
    },
    async deleteContent(input) {
      rmSync(join(dataDir, 'artifacts', input.teamId, input.artifactId), { recursive: true, force: true });
    },
  };
}

export async function runServerNextDevServer(config = parseServerNextDevConfig()): Promise<ServerNextDevServerHandle> {
  const handle = await startServerNextDevServer({ config });
  console.log(`AgentBean Next server listening at ${handle.baseUrl}`);
  return handle;
}

function loadSocketIoServer(): SocketIoServerConstructor {
  const requireUrls = [
    new URL('../package.json', import.meta.url),
    new URL('../../../../package.json', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/server-next/package.json')),
  ];
  for (const requireUrl of requireUrls) {
    try {
      const loaded = createRequire(requireUrl)('socket.io') as { Server: SocketIoServerConstructor };
      return loaded.Server;
    } catch {
      // Try the next known repository layout.
    }
  }
  throw new Error('socket.io is not installed; run npm ci at the repository root');
}

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const requireUrls = [
    new URL('../package.json', import.meta.url),
    new URL('../../../../package.json', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/server-next/package.json')),
  ];
  for (const requireUrl of requireUrls) {
    try {
      const Candidate = createRequire(requireUrl)('better-sqlite3') as BetterSqlite3Constructor;
      const db = new Candidate(':memory:');
      db.close();
      return Candidate;
    } catch {
      // Try the next installed copy; native modules are ABI-specific.
    }
  }
  throw new Error('better-sqlite3 is not installed for this Node.js runtime; run npm ci at the repository root');
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

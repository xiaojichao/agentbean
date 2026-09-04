import { randomBytes } from 'node:crypto';
import {
  createServerNextUseCases,
  type ArtifactContentStore,
  type CreateServerNextUseCasesInput,
  type ServerNextUseCases,
} from './application/usecases.js';
import { getEmergencyStopActive } from './application/pi-provider-service.js';
import type { WorkspaceStagingContentStore } from './application/workspace-staging-content-store.js';
import type { ServerNextRepositories } from './application/repositories.js';
import { createCapsuleInjectionValidator } from './application/capsule-injection-validator.js';
import { createServerCapsuleRuntimeContextService } from './application/server-capsule-runtime-context-service.js';
import {
  createServerMemorySearchPermissions,
  createServerMemoryWritePermissions,
  createServerMemoryCandidatePermissions,
  CURRENT_MEMORY_POLICY_VERSION,
} from './application/server-memory-permissions.js';
import {
  createDeviceWorkerScheduler,
  type DeviceWorkerScheduler,
} from './application/management/device-worker-scheduler.js';
import {
  createServerWorkerPool,
  type ServerWorkerPool,
} from './application/management/server-worker-pool.js';
import {
  createServerWorkerScheduler,
  type ServerWorkerScheduler,
} from './application/management/server-worker-scheduler.js';
import { createAutoPlacementProbe } from './application/management/auto-placement-probe.js';
import { createManagementKernel } from './application/management/management-kernel.js';
import { createInvocationGateway } from './application/management/invocation-gateway.js';
import {
  createManagementToolExecutor,
  createPhase1ManagementToolHandlers,
  createPhase2CollaborationToolHandlers,
  createPhase2InvocationToolHandlers,
  createPhase2ManagementToolHandlers,
  createPhase3ManagementToolHandlers,
} from './application/management/management-tool-executor.js';
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
import { createProjectStageAutoAdvance } from './application/project-stage-auto-advance.js';
import {
  createProjectCollaborationMetrics,
  type ProjectCollaborationRolloutConfig,
} from './application/project-collaboration-rollout.js';
import {
  CHANNEL_COLLABORATION_TASK_TAG,
  type WorkspaceRevisionCommittedPayload,
} from '../../../packages/contracts/src/index.js';

export interface ServerRuntimeAssembly {
  readonly app: ServerNextUseCases;
  readonly managementWorkerScheduler: DeviceWorkerScheduler;
  readonly serverWorkerScheduler?: ServerWorkerScheduler;
  readonly taskClaimBroker: TaskClaimBroker;
  readonly serverWorkerPool?: ServerWorkerPool;
  readonly serverWorkerAuthToken?: string;
  bindManagementDispatchEmitter(emit: (dispatchId: string) => Promise<void>): void;
  bindTaskClaimEmitter(emit: (taskId: string, options?: {
    readonly allowedAgentIds?: readonly string[];
    readonly projectStageAuto?: boolean;
  }) => Promise<{ readonly offered: number }>): void;
  recoverProjectStages?(teamId?: string): Promise<void>;
}

export type CreateServerRuntimeAssemblyInput = Pick<
  CreateServerNextUseCasesInput,
  | 'sessionSecret'
  | 'webPush'
  | 'resolveArtifactPreview'
  | 'onArtifactCommitted'
> & {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly artifactContentStore: ArtifactContentStore;
  readonly stagingContentStore: WorkspaceStagingContentStore;
  readonly channelFileRollout: NonNullable<CreateServerNextUseCasesInput['channelFileRollout']>;
  readonly channelFileMetrics: NonNullable<CreateServerNextUseCasesInput['channelFileMetrics']>;
  readonly projectCollaborationRollout: ProjectCollaborationRolloutConfig;
  readonly projectCollaborationMetrics: ReturnType<typeof createProjectCollaborationMetrics>;
  readonly serverWorker?: {
    readonly workerPoolId: string;
    readonly providerCredentialRef: string;
    readonly authToken: string;
    readonly queueTimeoutMs?: number;
    readonly leaseTtlMs?: number;
  };
  readonly messageIngestionMode: 'legacy' | 'durable-job' | 'message-tracer';
  readonly messageTracerEnabled: boolean;
  readonly onMessageTracerDelivered?: (
    delivery: { teamId: string; channelId: string; messageId: string },
  ) => Promise<void> | void;
  readonly onWorkspaceRevisionCommitted?: (
    payload: WorkspaceRevisionCommittedPayload,
  ) => Promise<void> | void;
  readonly onChannelCollaborationMessageAppended?: (
    delivery: { teamId: string; channelId: string; messageId: string },
  ) => Promise<void> | void;
};

export function createServerRuntimeAssembly(
  input: CreateServerRuntimeAssemblyInput,
): ServerRuntimeAssembly {
  const {
    repositories,
    clock,
    ids,
    projectCollaborationRollout,
    onChannelCollaborationMessageAppended,
  } = input;
  const serverCapsuleRuntimeContextResolver = createDefaultServerCapsuleRuntimeContextResolver(
    repositories,
    ids,
  );
  const serverWorker = createDefaultServerWorker(input.serverWorker, clock, ids);
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
  const taskClaimBroker = createTaskClaimBroker({
    repositories,
    clock,
    ids,
    piAutomationAvailable: resolvePiAutomationAvailable,
  });
  const management = createDefaultManagementRuntime(
    repositories,
    clock,
    ids,
    serverCapsuleRuntimeContextResolver,
    taskClaimBroker,
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
    sessionSecret: input.sessionSecret,
    webPush: input.webPush,
    artifactContentStore: input.artifactContentStore,
    stagingContentStore: input.stagingContentStore,
    channelFileRollout: input.channelFileRollout,
    channelFileMetrics: input.channelFileMetrics,
    projectCollaborationRollout,
    projectCollaborationMetrics: input.projectCollaborationMetrics,
    ...(input.resolveArtifactPreview
      ? { resolveArtifactPreview: input.resolveArtifactPreview }
      : {}),
    ...(input.onArtifactCommitted
      ? { onArtifactCommitted: input.onArtifactCommitted }
      : {}),
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
        return resolution.candidates
          .filter((candidate) => candidate.eligible)
          .map((candidate) => candidate.agentId);
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
    messageIngestionMode: input.messageIngestionMode,
    messageTracerEnabled: input.messageTracerEnabled,
    onMessageTracerDelivered: input.onMessageTracerDelivered,
    onWorkspaceRevisionCommitted: input.onWorkspaceRevisionCommitted,
  });
  appForPiReadiness = app;
  return {
    app,
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
  };
}

function createDefaultServerWorker(
  serverWorker: CreateServerRuntimeAssemblyInput['serverWorker'],
  clock: { now(): number },
  ids: { nextId(): string },
): { pool: ServerWorkerPool; authToken: string; queueTimeoutMs?: number; leaseTtlMs?: number } | undefined {
  if (!serverWorker) return undefined;
  return {
    pool: createServerWorkerPool({
      workerPoolId: serverWorker.workerPoolId,
      providerCredentialRef: serverWorker.providerCredentialRef,
      clock,
      ids,
    }),
    authToken: serverWorker.authToken,
    ...(serverWorker.queueTimeoutMs ? { queueTimeoutMs: serverWorker.queueTimeoutMs } : {}),
    ...(serverWorker.leaseTtlMs ? { leaseTtlMs: serverWorker.leaseTtlMs } : {}),
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

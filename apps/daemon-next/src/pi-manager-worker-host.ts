import { createHash } from 'node:crypto';
import type {
  ManagementRuntimeFactory,
  ManagementSession,
  ManagementSessionContextV1,
  ManagementSessionContextV2,
  ManagementToolCall,
  ManagementToolExecutor,
  ManagementToolResult,
  VersionedManagementPrompt,
} from '@agentbean/pi-management-runtime';
import { PHASE_3_MANAGEMENT_TOOL_NAMES, type ManagementToolName } from '@agentbean/pi-management-runtime';
import type {
  ManagementCheckpointResultV1,
  ManagementLeaseAcquireAckV1,
  ManagementLeaseOfferV1,
  ManagementOutboxReplayV1,
  ManagementWorkerLeaseProofV1,
  ManagementWorkerToolRequestV1,
  Phase1ManagementWorkerToolName,
  Phase2TaskToolRequestV2,
  Phase3MemoryToolRequestV3,
} from '../../../packages/contracts/src/index.js';
import { PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES, PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES } from '../../../packages/contracts/src/index.js';
import type {
  ManagementCredentialProvider,
  ManagementCredentialResolution,
} from './management-credential-provider.js';
import { managementCredentialCapability } from './management-credential-provider.js';
import type {
  ManagementDurableOutbox,
  ManagementDurableOutboxItem,
} from './management-durable-outbox.js';
import type {
  PiManagerWorkerProtocol,
  PiManagerWorkerProtocolHandlers,
} from './management-worker-protocol.js';

type AvailableManagementCredential = Exclude<ManagementCredentialResolution, { credentialStatus: 'unavailable' }>;

export interface CreatePiManagerRuntimeFactoryInput {
  readonly credential: AvailableManagementCredential;
  readonly toolExecutor: ManagementToolExecutor;
}

export interface PiManagerWorkerHost {
  start(): Promise<void>;
  beginDrain(deadlineMs: number): Promise<void>;
  stop(): Promise<void>;
  activeLeaseCount(): number;
  outboxPendingCount(): number;
}

export interface CreatePiManagerWorkerHostInput {
  readonly profileId: string;
  readonly runtimeVersion: string;
  readonly protocol: PiManagerWorkerProtocol;
  readonly credentialProvider: ManagementCredentialProvider;
  readonly createRuntimeFactory: (
    input: CreatePiManagerRuntimeFactoryInput,
  ) => ManagementRuntimeFactory | Promise<ManagementRuntimeFactory>;
  readonly outbox: ManagementDurableOutbox;
  readonly maxConcurrentLeases?: number;
  readonly systemPrompt?: VersionedManagementPrompt;
  readonly now?: () => number;
}

interface ActiveLease {
  readonly managementRunId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
  expiresAt: number;
  session?: ManagementSession;
  renewTimer?: ReturnType<typeof setTimeout>;
  disposing: boolean;
  managementPhase: 1 | 2 | 3;
}

const DEFAULT_SYSTEM_PROMPT: VersionedManagementPrompt = {
  id: 'agentbean-managed-runtime',
  version: 2,
  content: '你是 AgentBean 的 PI 管理运行时。只使用已提供的管理工具；Phase 1 仅处理 frozen target，Phase 2 可按任务契约调用可见 Agent 或发起 handoff。不得访问本地 cwd、源码或任意 coding tools。',
};

const WRITE_TOOL_NAMES = new Set<ManagementToolName>([
  'agents.invoke',
  'agents.cancel_invocation',
  'channel.post_management_status',
  'user.request_input',
  'review.submit_root_delivery',
  'tasks.create_subtasks',
  'tasks.add_dependency',
  'tasks.publish_for_claim',
  'tasks.assign',
  'tasks.retry',
  'tasks.accept_subtask',
  'tasks.report_blocked',
  'handoffs.request',
  'memory.create_capsule',
  'memory.propose_candidate',
  'memory.link_sources',
]);

const PHASE_3_MEMORY_TOOL_NAMES = new Set<ManagementToolName>([
  'memory.search',
  'memory.create_capsule',
  'memory.propose_candidate',
  'memory.link_sources',
]);

const PHASE_3_MEMORY_WRITE_TOOL_NAMES = new Set<ManagementToolName>([
  'memory.create_capsule',
  'memory.propose_candidate',
  'memory.link_sources',
]);

export function createPiManagerWorkerHost(input: CreatePiManagerWorkerHostInput): PiManagerWorkerHost {
  const maxConcurrentLeases = normalizeCapacity(input.maxConcurrentLeases ?? 1);
  const now = input.now ?? Date.now;
  const activeLeases = new Map<string, ActiveLease>();
  const pendingOfferIds = new Set<string>();
  let credential: ManagementCredentialResolution | undefined;
  let runtimeFactory: ManagementRuntimeFactory | undefined;
  let currentWorkerId: string | undefined;
  let started = false;
  let acceptingOffers = false;
  let drainCancelled = false;

  const toolExecutor: ManagementToolExecutor = (call) => executeManagementTool(call);

  const handlers: PiManagerWorkerProtocolHandlers = {
    reserveLeaseOffer(offer) {
      const accepted = started
        && acceptingOffers
        && credential?.credentialStatus !== 'unavailable'
        && Boolean(runtimeFactory)
        && offer.offerExpiresAt > now()
        && offer.workerId === currentWorkerId
        && !pendingOfferIds.has(offer.offerId)
        && !activeLeases.has(offer.managementRunId)
        && activeLeases.size + pendingOfferIds.size < maxConcurrentLeases;
      if (accepted) pendingOfferIds.add(offer.offerId);
      return accepted;
    },
    async onLeaseOffer(offer) {
      if (!pendingOfferIds.has(offer.offerId)) return;
      try {
        await acquireAndStart(offer);
      } finally {
        pendingOfferIds.delete(offer.offerId);
      }
    },
    async onDisconnect() {
      currentWorkerId = undefined;
      pendingOfferIds.clear();
      await Promise.all([...activeLeases.values()].map((lease) => disposeLease(lease, 'worker-disconnected')));
    },
    async onReconnect(workerId) {
      currentWorkerId = workerId;
    },
  };

  return {
    async start() {
      if (started) return;
      credential = await input.credentialProvider.resolve();
      if (credential.credentialStatus !== 'unavailable') {
        runtimeFactory = await input.createRuntimeFactory({ credential, toolExecutor });
      }
      const capability = managementCredentialCapability(credential);
      started = true;
      acceptingOffers = true;
      drainCancelled = false;
      try {
        const registered = await input.protocol.start({
          ...capability,
          capacity: { maxConcurrentLeases, activeLeaseCount: 0 },
        }, handlers);
        currentWorkerId = registered.workerId;
      } catch (error) {
        started = false;
        acceptingOffers = false;
        runtimeFactory = undefined;
        credential = undefined;
        throw error;
      }
    },
    async beginDrain(deadlineMs) {
      acceptingOffers = false;
      const deadlineAt = Date.now() + deadlineMs;
      // Entries left after their lease ends are durable but cannot be replayed without
      // fresh authority. Preserve them for the next legal reacquire instead of turning
      // every normal service stop into a drain timeout.
      while (!drainCancelled && (pendingOfferIds.size > 0 || activeLeases.size > 0)) {
        if (Date.now() >= deadlineAt) throw new Error('PROFILE_DRAIN_FAILED');
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadlineAt - Date.now()))));
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      acceptingOffers = false;
      drainCancelled = true;
      await Promise.all([...activeLeases.values()].map((lease) => abortLease(lease, 'worker-stopped')));
      await input.protocol.stop();
      currentWorkerId = undefined;
      pendingOfferIds.clear();
      runtimeFactory = undefined;
      credential = undefined;
    },
    activeLeaseCount() {
      return activeLeases.size + pendingOfferIds.size;
    },
    outboxPendingCount() {
      return input.outbox.size();
    },
  };

  async function acquireAndStart(offer: ManagementLeaseOfferV1): Promise<void> {
    let acquired: ManagementLeaseAcquireAckV1;
    try {
      acquired = await input.protocol.acquireLease(offer);
    } catch {
      return;
    }
    if (!acquired.ok || acquired.managementRunId !== offer.managementRunId || acquired.workerId !== currentWorkerId) return;
    if (!started || !acceptingOffers) {
      await input.protocol.abortLease({
        schemaVersion: 1,
        managementRunId: acquired.managementRunId,
        workerId: acquired.workerId,
        leaseToken: acquired.leaseToken,
        fencingToken: acquired.fencingToken,
        idempotencyKey: `abort:${acquired.managementRunId}:${acquired.fencingToken}:worker-draining`,
        reasonCode: 'worker-draining',
      }).catch(() => undefined);
      return;
    }
    const lease: ActiveLease = {
      managementRunId: acquired.managementRunId,
      workerId: acquired.workerId,
      leaseToken: acquired.leaseToken,
      fencingToken: acquired.fencingToken,
      expiresAt: acquired.expiresAt,
      disposing: false,
      managementPhase: 1,
    };
    activeLeases.set(lease.managementRunId, lease);

    try {
      const replay = await replayManagementOutboxForLease({
        authority: lease, protocol: input.protocol, outbox: input.outbox,
      });
      if (!canStartLeaseSession(lease)) return;
      if (replay.unresolvedMemoryWriteCount > 0) {
        throw new Error('MANAGEMENT_MEMORY_OUTBOX_UNRESOLVED');
      }
      const restored = await input.protocol.fetchCheckpoint({
        schemaVersion: 1,
        managementRunId: lease.managementRunId,
        workerId: lease.workerId,
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
      });
      if (!canStartLeaseSession(lease)) return;
      if (restored.managementRunId !== lease.managementRunId || restored.workerId !== lease.workerId) {
        throw new Error('MANAGEMENT_CHECKPOINT_AUTHORITY_MISMATCH');
      }
      lease.managementPhase = checkpointManagementPhase(restored);
      const factory = runtimeFactory;
      if (!factory) return;
      const session = await factory.createSession({
        systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        mode: 'managed',
        context: runtimeContext(restored),
      });
      if (!canStartLeaseSession(lease)) {
        await session.dispose().catch(() => undefined);
        return;
      }
      lease.session = session;
      scheduleRenew(lease);
      void session.prompt({ text: restoreObjective(restored) })
        .then(() => finishLease(lease, 'session-completed'))
        .catch(() => abortLease(lease, 'session-failed'));
    } catch {
      await abortLease(lease, 'session-start-failed');
    }
  }

  function canStartLeaseSession(lease: ActiveLease): boolean {
    return started && !lease.disposing && activeLeases.get(lease.managementRunId) === lease;
  }

  async function executeManagementTool(call: ManagementToolCall): Promise<ManagementToolResult> {
    if (call.scope.kind !== 'managed') return toolError('MANAGEMENT_SHADOW_TOOL_UNSUPPORTED');
    const allowedTools = leasePhaseTools(call.scope.managementRunId);
    if (!allowedTools.includes(call.name)) {
      return toolError('MANAGEMENT_TOOL_PHASE_UNSUPPORTED');
    }
    const toolName = call.name;
    const lease = activeLeases.get(call.scope.managementRunId);
    if (!lease || lease.disposing || lease.fencingToken < 1) return toolError('MANAGEMENT_LEASE_UNAVAILABLE');

    const commandId = `${lease.managementRunId}:${call.toolCallId}`;
    const write = WRITE_TOOL_NAMES.has(toolName);
    const idempotencyKey = commandId;
    const phase3Memory = lease.managementPhase === 3 && PHASE_3_MEMORY_TOOL_NAMES.has(toolName);
    const phase2Task = lease.managementPhase >= 2 && !phase3Memory
      && (toolName === 'agents.invoke'
        || !PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES.includes(toolName as Phase1ManagementWorkerToolName));
    const base = {
      schemaVersion: phase2Task || phase3Memory ? 2 as const : 1 as const,
      ...(phase3Memory
        ? { managementPhase: 3 as const }
        : phase2Task ? { managementPhase: 2 as const } : {}),
      commandId,
      managementRunId: lease.managementRunId,
      workerId: lease.workerId,
      toolCallId: call.toolCallId,
      toolName,
      input: structuredClone(call.input),
    };
    const request = (write || phase2Task || phase3Memory ? {
      ...base,
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
      idempotencyKey,
    } : base) as ManagementWorkerToolRequestV1 | Phase2TaskToolRequestV2 | Phase3MemoryToolRequestV3;
    let outboxItem: ManagementDurableOutboxItem | undefined;
    if (write) {
      const item: ManagementDurableOutboxItem = {
        schemaVersion: 1,
        managementRunId: lease.managementRunId,
        commandId,
        idempotencyKey,
        requestHash: hashManagementToolRequest(toolName, call.input),
        toolName,
        createdAt: now(),
      };
      outboxItem = item;
      try {
        await input.outbox.enqueue(item);
      } catch {
        return toolError('MANAGEMENT_OUTBOX_WRITE_FAILED');
      }
    }

    try {
      const result = await input.protocol.executeTool(request);
      if (outboxItem && (result.ok || !result.retryable)) await input.outbox.remove(outboxItem);
      return result.ok
        ? { text: JSON.stringify(result.output) }
        : toolError(result.diagnosticCode ?? result.errorCode);
    } catch {
      return toolError('MANAGEMENT_TOOL_TRANSPORT_FAILED');
    }
  }

  function leasePhaseTools(managementRunId: string): readonly ManagementToolName[] {
    const phase = activeLeases.get(managementRunId)?.managementPhase;
    if (phase === 3) return PHASE_3_MANAGEMENT_TOOL_NAMES;
    if (phase === 2) return PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES;
    return PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES;
  }

  function scheduleRenew(lease: ActiveLease): void {
    if (lease.disposing || activeLeases.get(lease.managementRunId) !== lease) return;
    const delay = Math.max(1, Math.floor((lease.expiresAt - now()) / 2));
    lease.renewTimer = setTimeout(() => {
      void renewLease(lease);
    }, delay);
    lease.renewTimer.unref?.();
  }

  async function renewLease(lease: ActiveLease): Promise<void> {
    if (lease.disposing || activeLeases.get(lease.managementRunId) !== lease) return;
    try {
      const result = await input.protocol.renewLease({
        schemaVersion: 1,
        managementRunId: lease.managementRunId,
        workerId: lease.workerId,
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        idempotencyKey: `renew:${lease.managementRunId}:${lease.fencingToken}`,
      });
      if (!result.ok || result.fencingToken !== lease.fencingToken) {
        await disposeLease(lease, 'lease-renew-rejected');
        return;
      }
      lease.expiresAt = result.expiresAt;
      scheduleRenew(lease);
    } catch {
      await disposeLease(lease, 'lease-renew-failed');
    }
  }

  async function abortLease(lease: ActiveLease, reason: string): Promise<void> {
    if (lease.disposing) return;
    try {
      await input.protocol.abortLease({
        schemaVersion: 1,
        managementRunId: lease.managementRunId,
        workerId: lease.workerId,
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        idempotencyKey: `abort:${lease.managementRunId}:${lease.fencingToken}:${reason}`,
        reasonCode: reason,
      });
    } catch {
      // Server lease expiry remains authoritative when transport is unavailable.
    }
    await disposeLease(lease, reason);
  }

  async function finishLease(lease: ActiveLease, reason: string): Promise<void> {
    if (lease.disposing || activeLeases.get(lease.managementRunId) !== lease) return;
    try {
      await input.protocol.releaseLease({
        schemaVersion: 1,
        managementRunId: lease.managementRunId,
        workerId: lease.workerId,
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        idempotencyKey: `release:${lease.managementRunId}:${lease.fencingToken}:${reason}`,
        reasonCode: reason,
      });
    } catch {
      // The server lease expires authoritatively; a completed local prompt must not hold capacity forever.
    }
    await disposeLease(lease, reason, false);
  }

  async function disposeLease(lease: ActiveLease, reason: string, abortSession = true): Promise<void> {
    if (lease.disposing) return;
    lease.disposing = true;
    if (lease.renewTimer) clearTimeout(lease.renewTimer);
    activeLeases.delete(lease.managementRunId);
    if (!lease.session) return;
    if (abortSession) {
      try {
        await lease.session.abort(reason);
      } catch {
        // Disposal still has to run after an abort failure.
      }
    }
    try {
      await lease.session.dispose();
    } catch {
      // Lease authority is already cleared locally; cleanup is best effort.
    }
  }
}

export async function replayManagementOutboxForLease(input: {
  readonly authority: ManagementWorkerLeaseProofV1;
  readonly protocol: Pick<PiManagerWorkerProtocol, 'replayOutbox'>;
  readonly outbox: Pick<ManagementDurableOutbox, 'list' | 'remove'>;
}): Promise<{ unresolvedMemoryWriteCount: number }> {
  let unresolvedMemoryWriteCount = 0;
  for (const item of input.outbox.list()) {
    if (item.managementRunId !== input.authority.managementRunId) continue;
    const payload: ManagementOutboxReplayV1 = {
      schemaVersion: 1,
      ...input.authority,
      idempotencyKey: item.idempotencyKey,
      commandId: item.commandId,
      requestHash: item.requestHash,
      toolName: item.toolName,
    };
    try {
      const result = await input.protocol.replayOutbox(payload);
      if (result.disposition === 'existing' || result.disposition === 'committed'
        || result.disposition === 'conflict' || result.disposition === 'rejected') {
        await input.outbox.remove(item);
      }
    } catch {
      // Keep the durable entry for the next reconnect/reacquire attempt. A Memory write
      // without an authoritative replay verdict must also block starting a new Session.
      if (PHASE_3_MEMORY_WRITE_TOOL_NAMES.has(item.toolName)) unresolvedMemoryWriteCount += 1;
    }
  }
  return { unresolvedMemoryWriteCount };
}

function runtimeContext(restored: ManagementCheckpointResultV1): ManagementSessionContextV1 | ManagementSessionContextV2 {
  const context = restored.context;
  const managementPhase = checkpointManagementPhase(restored);
  if (managementPhase === 1 && restored.checkpoint && restored.checkpoint.authoritative.taskGraphRevision !== 0) {
    throw new Error('P1_TASK_GRAPH_REVISION_UNSUPPORTED');
  }
  if (managementPhase === 2 || managementPhase === 3) {
    if (!context.rootTaskId) throw new Error(`P${managementPhase}_ROOT_TASK_REQUIRED`);
    return {
      schemaVersion: 2,
      managementPhase,
      scope: {
        kind: 'managed', managementRunId: restored.managementRunId,
        teamId: context.teamId, channelId: context.channelId,
        rootMessageId: context.rootMessageId, rootTaskId: context.rootTaskId,
      },
      ...(context.frozenTarget ? { frozenTarget: structuredClone(context.frozenTarget) } : {}),
      visibleThread: structuredClone(context.visibleThread),
      ...(restored.checkpoint ? {
        checkpoint: visiblePhase2Checkpoint(restored.checkpoint, managementPhase === 3),
      } : {}),
    };
  }
  if (!context.frozenTarget) throw new Error('P1_FROZEN_TARGET_REQUIRED');
  return {
    schemaVersion: 1,
    scope: {
      kind: 'managed',
      managementRunId: restored.managementRunId,
      teamId: context.teamId,
      channelId: context.channelId,
      rootMessageId: context.rootMessageId,
      ...(context.rootTaskId ? { rootTaskId: context.rootTaskId } : {}),
    },
    frozenTarget: structuredClone(context.frozenTarget),
    visibleThread: structuredClone(context.visibleThread),
    ...(restored.checkpoint ? {
      checkpoint: visibleCheckpoint(restored.checkpoint),
    } : {}),
  };
}

export function checkpointManagementPhase(restored: ManagementCheckpointResultV1): 1 | 2 | 3 {
  if (restored.context.managementPhase !== undefined) return restored.context.managementPhase;
  return restored.context.rootTaskId && (!restored.context.frozenTarget
    || restored.checkpoint?.authoritative.taskSnapshots?.length)
    ? 2
    : 1;
}

function visibleCheckpoint(checkpoint: NonNullable<ManagementCheckpointResultV1['checkpoint']>) {
  return {
    revision: checkpoint.revision,
    lastEventSequence: checkpoint.authoritative.lastEventSequence,
    objective: checkpoint.contextHints.objective,
    planSummary: checkpoint.contextHints.planSummary,
    ...(checkpoint.contextHints.nextAction ? { nextAction: checkpoint.contextHints.nextAction } : {}),
  };
}

function visiblePhase2Checkpoint(
  checkpoint: NonNullable<ManagementCheckpointResultV1['checkpoint']>,
  includeMemoryCapsules: boolean,
) {
  return {
    ...visibleCheckpoint(checkpoint),
    taskGraphRevision: checkpoint.authoritative.taskGraphRevision,
    openTaskIds: [...checkpoint.authoritative.openTaskIds],
    waitingInvocationIds: [...checkpoint.authoritative.waitingInvocationIds],
    completedInvocationIds: [...checkpoint.authoritative.completedInvocationIds],
    taskSnapshots: structuredClone(checkpoint.authoritative.taskSnapshots ?? []),
    activeClaimLeaseIds: [...(checkpoint.authoritative.activeClaimLeaseIds ?? [])],
    ...(includeMemoryCapsules ? { memoryCapsuleIds: [...checkpoint.authoritative.memoryCapsuleIds] } : {}),
  };
}

function restoreObjective(restored: ManagementCheckpointResultV1): string {
  const objective = restored.checkpoint?.contextHints.objective.trim();
  if (objective) return objective;
  return restored.context.visibleThread.messages
    .find((message) => message.id === restored.context.rootMessageId)?.body
    ?? '继续当前管理任务。';
}

export function hashManagementToolRequest(toolName: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson({ toolName, input })).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function toolError(code: string): ManagementToolResult {
  return { text: JSON.stringify({ error: code }), isError: true };
}

function normalizeCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('MANAGEMENT_WORKER_CAPACITY_INVALID');
  return value;
}

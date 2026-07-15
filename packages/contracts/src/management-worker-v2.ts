import type { ID, UnixMs } from './common.js';
import type { ManagementWorkerCapacityV1, ManagementWorkerSessionContextV1 } from './management-worker.js';
import type { AcceptanceCriterionDto, EvidenceRefDto, SubtaskAcceptanceV1 } from './task-coordination.js';
import type { AgentHandoffReturnMode, AgentHandoffStatus, SerialAgentHandoffKind } from './collaboration.js';
import { parseAgentCollaborationProposalV1 } from './collaboration.js';
import type { AgentInvocationResultDto } from './invocation.js';

export const PHASE_2_TASK_WORKER_TOOL_NAMES = [
  'tasks.create_subtasks',
  'tasks.add_dependency',
  'tasks.publish_for_claim',
  'tasks.assign',
  'tasks.wait',
  'tasks.retry',
  'tasks.accept_subtask',
  'tasks.report_blocked',
] as const;

export const PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES = [
  'context.get_root_message',
  'context.get_root_task',
  'context.get_visible_thread',
  'context.get_management_state',
  'agents.list_capabilities',
  'agents.get_status',
  'agents.invoke',
  'agents.cancel_invocation',
  'channel.post_management_status',
  'user.request_input',
  'review.submit_root_delivery',
  ...PHASE_2_TASK_WORKER_TOOL_NAMES,
  'agents.list_available',
  'handoffs.request',
  'handoffs.await_result',
] as const;

const PHASE_2_COLLABORATION_WORKER_TOOL_NAMES = [
  'agents.list_available',
  'handoffs.request',
  'handoffs.await_result',
] as const;

export type Phase2ManagementWorkerToolName = (typeof PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES)[number];

export interface ManagementWorkerRegisterV2 {
  readonly schemaVersion: 2;
  readonly workerInstanceId: ID;
  readonly profileId: ID;
  readonly runtimeVersion: string;
  readonly supportedProtocolVersions: readonly [1, 2];
  readonly supportedPhases: readonly [1, 2];
  readonly credentialStatus: 'production_ready' | 'test_only' | 'unavailable';
  readonly providerId?: string;
  readonly modelId?: string;
  readonly capacity: ManagementWorkerCapacityV1;
}

export interface ManagementWorkerSessionContextV2 {
  readonly schemaVersion: 2;
  readonly managementPhase: 2;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly rootMessageId: ID;
  readonly rootTaskId: ID;
  readonly frozenTarget?: ManagementWorkerSessionContextV1['frozenTarget'];
  readonly visibleThread: ManagementWorkerSessionContextV1['visibleThread'];
}

export interface Phase2SubtaskDraftV1 {
  readonly clientKey: string;
  readonly title: string;
  readonly description?: string;
  readonly claimPolicy: 'open' | 'targeted';
  readonly targetAgentId?: ID;
  readonly requiredCapabilities: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly maxAttempts: number;
}

export interface Phase2ManagementWorkerToolInputMapV1 {
  readonly 'agents.invoke': {
    readonly taskId: ID;
    readonly expectedTaskRevision: number;
    readonly taskAttempt: number;
    readonly claimLeaseId: ID;
    readonly targetAgentId?: ID;
    readonly objective: string;
    readonly attachmentIds: readonly ID[];
    readonly deadlineAt?: UnixMs;
  };
  readonly 'agents.list_available': {
    readonly capabilityQuery?: string;
    readonly includeBusy?: boolean;
  };
  readonly 'handoffs.request': {
    readonly sourceProposalId?: ID;
    readonly sourceInvocationId?: ID;
    readonly toAgentId: ID;
    readonly kind: SerialAgentHandoffKind;
    readonly objective: string;
    readonly reason: string;
    readonly contextRefIds: readonly ID[];
    readonly dependencyInvocationIds: readonly ID[];
    readonly attachmentIds: readonly ID[];
    readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
    readonly returnMode: AgentHandoffReturnMode;
    readonly deadlineAt?: UnixMs;
  };
  readonly 'handoffs.await_result': {
    readonly handoffId: ID;
    readonly timeoutAt?: UnixMs;
  };
  readonly 'tasks.create_subtasks': { readonly parentTaskId: ID; readonly subtasks: readonly Phase2SubtaskDraftV1[] };
  readonly 'tasks.add_dependency': { readonly taskId: ID; readonly dependencyTaskId: ID; readonly expectedTaskRevision: number };
  readonly 'tasks.publish_for_claim': { readonly taskId: ID; readonly expectedTaskRevision: number };
  readonly 'tasks.assign': { readonly taskId: ID; readonly agentId: ID; readonly expectedTaskRevision: number };
  readonly 'tasks.wait': { readonly taskIds: readonly ID[] };
  readonly 'tasks.retry': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly reasonCode: string };
  readonly 'tasks.accept_subtask': { readonly acceptance: SubtaskAcceptanceV1 };
  readonly 'tasks.report_blocked': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly reasonCode: string };
}

export interface Phase2ManagementWorkerToolOutputMapV1 {
  readonly 'agents.invoke': {
    readonly invocationId: ID;
    readonly status: 'pending' | 'running' | 'failed' | 'cancelled' | 'timed_out';
  } | {
    readonly invocationId: ID;
    readonly status: 'succeeded';
    readonly deliveryId: ID;
    readonly evidenceRefs: readonly EvidenceRefDto[];
  };
  readonly 'agents.list_available': {
    readonly agents: readonly {
      readonly agentId: ID;
      readonly name: string;
      readonly kind: 'custom' | 'agentos-hosted';
      readonly status: 'online' | 'busy' | 'offline' | 'unknown';
      readonly capabilities: readonly string[];
      readonly skills: readonly string[];
      readonly channelMember: boolean;
    }[];
  };
  readonly 'handoffs.request': {
    readonly handoffId: ID;
    readonly invocationId: ID;
    readonly status: AgentHandoffStatus;
  };
  readonly 'handoffs.await_result': {
    readonly handoffId: ID;
    readonly invocationId: ID;
    readonly status: AgentHandoffStatus;
    readonly result?: AgentInvocationResultDto;
  };
  readonly 'tasks.create_subtasks': { readonly taskIds: readonly ID[]; readonly taskGraphRevision: number };
  readonly 'tasks.add_dependency': { readonly taskId: ID; readonly taskRevision: number; readonly taskGraphRevision: number };
  readonly 'tasks.publish_for_claim': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'todo' };
  readonly 'tasks.assign': { readonly taskId: ID; readonly taskRevision: number; readonly agentId: ID };
  readonly 'tasks.wait': {
    readonly readyTaskIds: readonly ID[];
    readonly waitingTaskIds: readonly ID[];
    readonly taskSnapshots: readonly {
      readonly taskId: ID;
      readonly taskRevision: number;
      readonly taskAttempt: number;
      readonly status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';
      readonly claimLeaseId?: ID;
      readonly claimedAgentId?: ID;
    }[];
  };
  readonly 'tasks.retry': { readonly taskId: ID; readonly taskRevision: number; readonly attempt: number };
  readonly 'tasks.accept_subtask': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'done' | 'in_review' };
  readonly 'tasks.report_blocked': { readonly taskId: ID; readonly status: 'todo'; readonly reportedAt: UnixMs };
}

interface Phase2TaskToolResultBaseV2<K extends keyof Phase2ManagementWorkerToolOutputMapV1> {
  readonly schemaVersion: 2;
  readonly managementPhase: 2;
  readonly commandId: ID;
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly toolCallId: ID;
  readonly toolName: K;
}

export type Phase2TaskToolResultV2 = {
  readonly [K in keyof Phase2ManagementWorkerToolOutputMapV1]: Phase2TaskToolResultBaseV2<K> & {
    readonly ok: true;
    readonly output: Phase2ManagementWorkerToolOutputMapV1[K];
  };
}[keyof Phase2ManagementWorkerToolOutputMapV1] | (Phase2TaskToolResultBaseV2<keyof Phase2ManagementWorkerToolOutputMapV1> & {
  readonly ok: false;
  readonly errorCode: 'INVALID_REQUEST' | 'NOT_AUTHORIZED' | 'CONFLICT' | 'UNAVAILABLE';
  readonly diagnosticCode?: string;
  readonly retryable: boolean;
});

export type Phase2TaskToolRequestV2 = {
  readonly [K in keyof Phase2ManagementWorkerToolInputMapV1]: {
    readonly schemaVersion: 2;
    readonly managementPhase: 2;
    readonly commandId: ID;
    readonly managementRunId: ID;
    readonly workerId: ID;
    readonly toolCallId: ID;
    readonly toolName: K;
    readonly leaseToken: string;
    readonly fencingToken: number;
    readonly idempotencyKey: string;
    readonly input: Phase2ManagementWorkerToolInputMapV1[K];
  };
}[keyof Phase2ManagementWorkerToolInputMapV1];

const registerKeys = ['schemaVersion', 'workerInstanceId', 'profileId', 'runtimeVersion', 'supportedProtocolVersions', 'supportedPhases', 'credentialStatus', 'providerId', 'modelId', 'capacity'];
const contextKeys = ['schemaVersion', 'managementPhase', 'teamId', 'channelId', 'rootMessageId', 'rootTaskId', 'frozenTarget', 'visibleThread'];
const taskRequestKeys = ['schemaVersion', 'managementPhase', 'commandId', 'managementRunId', 'workerId', 'toolCallId', 'toolName', 'leaseToken', 'fencingToken', 'idempotencyKey', 'input'];
const taskResultKeys = ['schemaVersion', 'managementPhase', 'commandId', 'managementRunId', 'workerId', 'toolCallId', 'toolName', 'ok', 'output', 'errorCode', 'diagnosticCode', 'retryable'];

function assertExactKeys(value: unknown, allowed: readonly string[], required: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
}

function assertStringArray(value: unknown): void {
  if (!Array.isArray(value) || value.some((entry) => !nonEmpty(entry))) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
}

function assertEvidenceRef(value: unknown): void {
  assertExactKeys(value, ['kind', 'id', 'snapshotHash', 'snapshotRevision', 'capturedAt'], ['kind', 'id', 'snapshotHash', 'capturedAt']);
  if (!['message', 'artifact', 'workspace-run', 'invocation', 'task'].includes(String(value.kind))
    || !nonEmpty(value.id) || !nonEmpty(value.snapshotHash)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  assertInteger(value.capturedAt, 0);
  if (value.snapshotRevision !== undefined) assertInteger(value.snapshotRevision, 0);
}

function assertCriterion(value: unknown): void {
  assertExactKeys(value, ['id', 'description', 'evidenceRequired', 'allowedEvidenceKinds'], ['id', 'description', 'evidenceRequired']);
  if (!nonEmpty(value.id) || !nonEmpty(value.description) || typeof value.evidenceRequired !== 'boolean') {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  if (value.allowedEvidenceKinds !== undefined) {
    assertStringArray(value.allowedEvidenceKinds);
    if ((value.allowedEvidenceKinds as readonly string[]).some((kind) => ![
      'message', 'artifact', 'workspace-run', 'invocation', 'task',
    ].includes(kind))) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
  }
}

function assertTaskToolInput(toolName: string, value: unknown): void {
  if (toolName === 'agents.invoke') {
    assertExactKeys(value, ['taskId', 'expectedTaskRevision', 'taskAttempt', 'claimLeaseId',
      'targetAgentId', 'objective', 'attachmentIds', 'deadlineAt'], ['taskId', 'expectedTaskRevision', 'taskAttempt',
      'claimLeaseId', 'objective', 'attachmentIds']);
    if (!nonEmpty(value.taskId) || !nonEmpty(value.claimLeaseId) || !nonEmpty(value.objective)) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    if (value.targetAgentId !== undefined && !nonEmpty(value.targetAgentId)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    assertInteger(value.expectedTaskRevision, 1);
    assertInteger(value.taskAttempt, 1);
    assertStringArray(value.attachmentIds);
    if (value.deadlineAt !== undefined) assertInteger(value.deadlineAt, 0);
    return;
  }
  if (toolName === 'agents.list_available') {
    assertExactKeys(value, ['capabilityQuery', 'includeBusy'], []);
    if (value.capabilityQuery !== undefined && !nonEmpty(value.capabilityQuery)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    if (value.includeBusy !== undefined && typeof value.includeBusy !== 'boolean') throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    return;
  }
  if (toolName === 'handoffs.request') {
    const optional = ['sourceProposalId', 'sourceInvocationId', 'deadlineAt'];
    const required = ['toAgentId', 'kind', 'objective', 'reason', 'contextRefIds',
      'dependencyInvocationIds', 'attachmentIds', 'acceptanceCriteria', 'returnMode'];
    assertExactKeys(value, [...optional, ...required], required);
    if ((value.sourceProposalId !== undefined && !nonEmpty(value.sourceProposalId))
      || (value.sourceInvocationId !== undefined && !nonEmpty(value.sourceInvocationId))
      || !nonEmpty(value.toAgentId) || !['consult', 'template_request', 'continuation'].includes(String(value.kind))
      || !nonEmpty(value.objective) || !nonEmpty(value.reason)
      || !['return_to_manager', 'return_to_source_agent', 'deliver_to_root'].includes(String(value.returnMode))) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    if ((value.sourceProposalId === undefined) !== (value.sourceInvocationId === undefined)) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    assertStringArray(value.contextRefIds);
    assertStringArray(value.dependencyInvocationIds);
    assertStringArray(value.attachmentIds);
    if (!Array.isArray(value.acceptanceCriteria)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    value.acceptanceCriteria.forEach(assertCriterion);
    if (value.deadlineAt !== undefined) assertInteger(value.deadlineAt, 0);
    return;
  }
  if (toolName === 'handoffs.await_result') {
    assertExactKeys(value, ['handoffId', 'timeoutAt'], ['handoffId']);
    if (!nonEmpty(value.handoffId)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    if (value.timeoutAt !== undefined) assertInteger(value.timeoutAt, 0);
    return;
  }
  if (toolName === 'tasks.create_subtasks') {
    assertExactKeys(value, ['parentTaskId', 'subtasks'], ['parentTaskId', 'subtasks']);
    if (!nonEmpty(value.parentTaskId) || !Array.isArray(value.subtasks) || value.subtasks.length === 0 || value.subtasks.length > 8) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    for (const draft of value.subtasks) {
      assertExactKeys(draft, ['clientKey', 'title', 'description', 'claimPolicy', 'targetAgentId', 'requiredCapabilities', 'acceptanceCriteria', 'maxAttempts'], ['clientKey', 'title', 'claimPolicy', 'requiredCapabilities', 'acceptanceCriteria', 'maxAttempts']);
      if (!nonEmpty(draft.clientKey) || !nonEmpty(draft.title) || !['open', 'targeted'].includes(String(draft.claimPolicy))) {
        throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
      }
      if (draft.description !== undefined && !nonEmpty(draft.description)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
      if ((draft.claimPolicy === 'open' && draft.targetAgentId !== undefined)
        || (draft.claimPolicy === 'targeted' && !nonEmpty(draft.targetAgentId))) {
        throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
      }
      assertStringArray(draft.requiredCapabilities);
      if (!Array.isArray(draft.acceptanceCriteria)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
      draft.acceptanceCriteria.forEach(assertCriterion);
      assertInteger(draft.maxAttempts, 1);
    }
    return;
  }
  if (toolName === 'tasks.wait') {
    assertExactKeys(value, ['taskIds'], ['taskIds']);
    assertStringArray(value.taskIds);
    return;
  }
  if (toolName === 'tasks.accept_subtask') {
    assertExactKeys(value, ['acceptance'], ['acceptance']);
    const acceptance = value.acceptance;
    assertExactKeys(acceptance, ['schemaVersion', 'taskId', 'deliveryId', 'expectedTaskRevision', 'taskAttempt', 'claimLeaseId', 'decision', 'criteriaResults', 'reason', 'decidedBy', 'decidedAt'], ['schemaVersion', 'taskId', 'deliveryId', 'expectedTaskRevision', 'taskAttempt', 'claimLeaseId', 'decision', 'criteriaResults', 'reason', 'decidedBy', 'decidedAt']);
    if (acceptance.schemaVersion !== 1 || !nonEmpty(acceptance.taskId) || !nonEmpty(acceptance.deliveryId)
      || !nonEmpty(acceptance.claimLeaseId) || !['accepted', 'rejected', 'needs_human'].includes(String(acceptance.decision))
      || !['manager', 'human'].includes(String(acceptance.decidedBy)) || !nonEmpty(acceptance.reason)) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    assertInteger(acceptance.expectedTaskRevision, 1);
    assertInteger(acceptance.taskAttempt, 1);
    assertInteger(acceptance.decidedAt, 0);
    if (!Array.isArray(acceptance.criteriaResults)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    for (const result of acceptance.criteriaResults) {
      assertExactKeys(result, ['criterionId', 'passed', 'evidenceRefs'], ['criterionId', 'passed', 'evidenceRefs']);
      if (!nonEmpty(result.criterionId) || typeof result.passed !== 'boolean' || !Array.isArray(result.evidenceRefs)) {
        throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
      }
      result.evidenceRefs.forEach(assertEvidenceRef);
    }
    return;
  }
  const withAgent = toolName === 'tasks.assign';
  const withDependency = toolName === 'tasks.add_dependency';
  const withReason = toolName === 'tasks.retry' || toolName === 'tasks.report_blocked';
  const allowed = ['taskId', 'expectedTaskRevision', ...(withDependency ? ['dependencyTaskId'] : []), ...(withAgent ? ['agentId'] : []), ...(withReason ? ['reasonCode'] : [] as string[])];
  assertExactKeys(value, allowed, allowed);
  if (!nonEmpty(value.taskId)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  assertInteger(value.expectedTaskRevision, 1);
  if (withDependency && !nonEmpty(value.dependencyTaskId)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  if (withAgent && !nonEmpty(value.agentId)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  if (withReason && !nonEmpty(value.reasonCode)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
}

function assertTaskToolOutput(toolName: string, value: unknown): void {
  if (toolName === 'agents.invoke') {
    assertExactKeys(value, ['invocationId', 'status', 'deliveryId', 'evidenceRefs'], ['invocationId', 'status']);
    if (!nonEmpty(value.invocationId) || !['pending', 'running', 'succeeded', 'failed', 'cancelled',
      'timed_out'].includes(String(value.status))) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    if (value.status === 'succeeded') {
      if (!nonEmpty(value.deliveryId) || !Array.isArray(value.evidenceRefs)
        || value.evidenceRefs.length === 0) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
      value.evidenceRefs.forEach(assertEvidenceRef);
    } else if (value.deliveryId !== undefined || value.evidenceRefs !== undefined) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    return;
  }
  if (toolName === 'agents.list_available') {
    assertExactKeys(value, ['agents'], ['agents']);
    if (!Array.isArray(value.agents)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    for (const agent of value.agents) {
      assertExactKeys(agent, ['agentId', 'name', 'kind', 'status', 'capabilities', 'skills', 'channelMember'],
        ['agentId', 'name', 'kind', 'status', 'capabilities', 'skills', 'channelMember']);
      if (!nonEmpty(agent.agentId) || !nonEmpty(agent.name)
        || !['custom', 'agentos-hosted'].includes(String(agent.kind))
        || !['online', 'busy', 'offline', 'unknown'].includes(String(agent.status))
        || typeof agent.channelMember !== 'boolean') throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
      assertStringArray(agent.capabilities); assertStringArray(agent.skills);
    }
    return;
  }
  if (toolName === 'handoffs.request' || toolName === 'handoffs.await_result') {
    assertExactKeys(value, ['handoffId', 'invocationId', 'status', 'result'],
      ['handoffId', 'invocationId', 'status']);
    if (!nonEmpty(value.handoffId) || !nonEmpty(value.invocationId)
      || !['requested', 'accepted', 'running', 'returned', 'rejected', 'failed', 'cancelled', 'timed_out']
        .includes(String(value.status))) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    if (value.result !== undefined) assertInvocationResult(value.result);
    return;
  }
  if (toolName === 'tasks.create_subtasks') {
    assertExactKeys(value, ['taskIds', 'taskGraphRevision'], ['taskIds', 'taskGraphRevision']);
    assertStringArray(value.taskIds);
    if (new Set(value.taskIds as readonly string[]).size !== (value.taskIds as readonly string[]).length) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    assertInteger(value.taskGraphRevision, 1); return;
  }
  if (toolName === 'tasks.add_dependency') {
    assertExactKeys(value, ['taskId', 'taskRevision', 'taskGraphRevision'], ['taskId', 'taskRevision', 'taskGraphRevision']);
    if (!nonEmpty(value.taskId)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    assertInteger(value.taskRevision, 1); assertInteger(value.taskGraphRevision, 1); return;
  }
  if (toolName === 'tasks.publish_for_claim') {
    assertExactKeys(value, ['taskId', 'taskRevision', 'status'], ['taskId', 'taskRevision', 'status']);
    if (!nonEmpty(value.taskId) || value.status !== 'todo') throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    assertInteger(value.taskRevision, 1); return;
  }
  if (toolName === 'tasks.assign') {
    assertExactKeys(value, ['taskId', 'taskRevision', 'agentId'], ['taskId', 'taskRevision', 'agentId']);
    if (!nonEmpty(value.taskId) || !nonEmpty(value.agentId)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    assertInteger(value.taskRevision, 1); return;
  }
  if (toolName === 'tasks.wait') {
    assertExactKeys(value, ['readyTaskIds', 'waitingTaskIds', 'taskSnapshots'],
      ['readyTaskIds', 'waitingTaskIds', 'taskSnapshots']);
    assertStringArray(value.readyTaskIds); assertStringArray(value.waitingTaskIds);
    const ready = value.readyTaskIds as readonly string[];
    const waiting = value.waitingTaskIds as readonly string[];
    if (new Set(ready).size !== ready.length || new Set(waiting).size !== waiting.length
      || ready.some((id) => waiting.includes(id))) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    if (!Array.isArray(value.taskSnapshots) || value.taskSnapshots.length !== ready.length + waiting.length) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    for (const snapshot of value.taskSnapshots) {
      assertExactKeys(snapshot, ['taskId', 'taskRevision', 'taskAttempt', 'status', 'claimLeaseId', 'claimedAgentId'],
        ['taskId', 'taskRevision', 'taskAttempt', 'status']);
      if (!nonEmpty(snapshot.taskId)
        || !['todo', 'in_progress', 'in_review', 'done', 'closed'].includes(String(snapshot.status))
        || (snapshot.claimLeaseId !== undefined && !nonEmpty(snapshot.claimLeaseId))
        || (snapshot.claimedAgentId !== undefined && !nonEmpty(snapshot.claimedAgentId))
        || ((snapshot.claimLeaseId === undefined) !== (snapshot.claimedAgentId === undefined))) {
        throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
      }
      assertInteger(snapshot.taskRevision, 1); assertInteger(snapshot.taskAttempt, 1);
    }
    const snapshotIds = value.taskSnapshots.map((snapshot: { taskId: string }) => snapshot.taskId);
    if (new Set(snapshotIds).size !== snapshotIds.length
      || [...ready, ...waiting].some((id) => !snapshotIds.includes(id))) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    return;
  }
  if (toolName === 'tasks.retry') {
    assertExactKeys(value, ['taskId', 'taskRevision', 'attempt'], ['taskId', 'taskRevision', 'attempt']);
    if (!nonEmpty(value.taskId)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    assertInteger(value.taskRevision, 1); assertInteger(value.attempt, 1); return;
  }
  if (toolName === 'tasks.accept_subtask') {
    assertExactKeys(value, ['taskId', 'taskRevision', 'status'], ['taskId', 'taskRevision', 'status']);
    if (!nonEmpty(value.taskId) || !['done', 'in_review'].includes(String(value.status))) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    assertInteger(value.taskRevision, 1); return;
  }
  assertExactKeys(value, ['taskId', 'status', 'reportedAt'], ['taskId', 'status', 'reportedAt']);
  if (!nonEmpty(value.taskId) || value.status !== 'todo') throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  assertInteger(value.reportedAt, 0);
}

function assertInvocationResult(value: unknown): asserts value is AgentInvocationResultDto {
  assertExactKeys(value, ['schemaVersion', 'invocationId', 'taskId', 'agentId', 'status', 'body',
    'artifactIds', 'workspaceRunId', 'memoryCandidateIds', 'collaborationProposals', 'startedAt',
    'completedAt', 'error'], ['schemaVersion', 'invocationId', 'agentId', 'status', 'artifactIds',
    'memoryCandidateIds', 'startedAt', 'completedAt']);
  if (value.schemaVersion !== 1 || !nonEmpty(value.invocationId) || !nonEmpty(value.agentId)
    || !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(String(value.status))
    || (value.taskId !== undefined && !nonEmpty(value.taskId))
    || (value.workspaceRunId !== undefined && !nonEmpty(value.workspaceRunId))
    || (value.body !== undefined && typeof value.body !== 'string')
    || (value.error !== undefined && typeof value.error !== 'string')) {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  assertStringArray(value.artifactIds); assertStringArray(value.memoryCandidateIds);
  assertInteger(value.startedAt, 0); assertInteger(value.completedAt, 0);
  if (value.collaborationProposals !== undefined) {
    if (!Array.isArray(value.collaborationProposals)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    value.collaborationProposals.forEach(parseAgentCollaborationProposalV1);
  }
}

export function parsePhase2TaskToolInputV1<K extends keyof Phase2ManagementWorkerToolInputMapV1>(
  toolName: K,
  value: unknown,
): Phase2ManagementWorkerToolInputMapV1[K] {
  assertTaskToolInput(toolName, value);
  return structuredClone(value) as Phase2ManagementWorkerToolInputMapV1[K];
}

export function parseManagementWorkerRegisterV2(value: unknown): ManagementWorkerRegisterV2 {
  assertExactKeys(value, registerKeys, registerKeys.filter((key) => !['providerId', 'modelId'].includes(key)));
  if (value.schemaVersion !== 2 || !nonEmpty(value.workerInstanceId) || !nonEmpty(value.profileId)
    || !nonEmpty(value.runtimeVersion) || JSON.stringify(value.supportedProtocolVersions) !== '[1,2]'
    || JSON.stringify(value.supportedPhases) !== '[1,2]'
    || !['production_ready', 'test_only', 'unavailable'].includes(String(value.credentialStatus))) {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  assertExactKeys(value.capacity, ['maxConcurrentLeases', 'activeLeaseCount'], ['maxConcurrentLeases', 'activeLeaseCount']);
  assertInteger(value.capacity.maxConcurrentLeases, 1);
  assertInteger(value.capacity.activeLeaseCount, 0);
  if (Number(value.capacity.activeLeaseCount) > Number(value.capacity.maxConcurrentLeases)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  if (value.credentialStatus === 'production_ready' && (!nonEmpty(value.providerId) || !nonEmpty(value.modelId))) {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  if (value.credentialStatus === 'unavailable' && (value.providerId !== undefined || value.modelId !== undefined)) {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  return structuredClone(value) as unknown as ManagementWorkerRegisterV2;
}

export function parseManagementWorkerSessionContextV2(value: unknown): ManagementWorkerSessionContextV2 {
  assertExactKeys(value, contextKeys, contextKeys.filter((key) => key !== 'frozenTarget'));
  if (value.schemaVersion !== 2 || value.managementPhase !== 2 || !nonEmpty(value.teamId)
    || !nonEmpty(value.channelId) || !nonEmpty(value.rootMessageId) || !nonEmpty(value.rootTaskId)) {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  assertExactKeys(value.visibleThread, ['revision', 'messages'], ['revision', 'messages']);
  assertInteger(value.visibleThread.revision, 0);
  if (!Array.isArray(value.visibleThread.messages)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  for (const message of value.visibleThread.messages) {
    assertExactKeys(message, ['id', 'senderKind', 'senderId', 'body', 'createdAt'], ['id', 'senderKind', 'senderId', 'body', 'createdAt']);
    if (!nonEmpty(message.id) || !['human', 'agent', 'system'].includes(String(message.senderKind))
      || !nonEmpty(message.senderId) || !nonEmpty(message.body)) throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    assertInteger(message.createdAt, 0);
  }
  if (value.frozenTarget !== undefined) {
    assertExactKeys(value.frozenTarget, ['agentId', 'kind'], ['agentId', 'kind']);
    if (!nonEmpty(value.frozenTarget.agentId) || !['custom', 'agentos-hosted'].includes(String(value.frozenTarget.kind))) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
  }
  return structuredClone(value) as unknown as ManagementWorkerSessionContextV2;
}

export function parsePhase2TaskToolRequestV2(value: unknown): Phase2TaskToolRequestV2 {
  assertExactKeys(value, taskRequestKeys, taskRequestKeys);
  if (value.schemaVersion !== 2 || value.managementPhase !== 2
    || !isPhase2WorkerToolName(value.toolName)
    || !nonEmpty(value.commandId) || !nonEmpty(value.managementRunId) || !nonEmpty(value.workerId)
    || !nonEmpty(value.toolCallId) || !nonEmpty(value.leaseToken) || !nonEmpty(value.idempotencyKey)
    || !Number.isSafeInteger(value.fencingToken) || Number(value.fencingToken) < 1) {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  parsePhase2TaskToolInputV1(value.toolName as keyof Phase2ManagementWorkerToolInputMapV1, value.input);
  return structuredClone(value) as unknown as Phase2TaskToolRequestV2;
}

export function parsePhase2TaskToolResultV2(value: unknown): Phase2TaskToolResultV2 {
  assertExactKeys(value, taskResultKeys, ['schemaVersion', 'managementPhase', 'commandId', 'managementRunId', 'workerId', 'toolCallId', 'toolName', 'ok']);
  if (value.schemaVersion !== 2 || value.managementPhase !== 2
    || !isPhase2WorkerToolName(value.toolName)
    || !nonEmpty(value.commandId) || !nonEmpty(value.managementRunId)
    || !nonEmpty(value.workerId) || !nonEmpty(value.toolCallId)
    || typeof value.ok !== 'boolean') {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  if (value.ok) {
    if (value.output === undefined || value.errorCode !== undefined || value.retryable !== undefined
      || value.diagnosticCode !== undefined) {
      throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
    }
    assertTaskToolOutput(String(value.toolName), value.output);
  } else if (!['INVALID_REQUEST', 'NOT_AUTHORIZED', 'CONFLICT', 'UNAVAILABLE'].includes(String(value.errorCode))
    || typeof value.retryable !== 'boolean' || value.output !== undefined
    || (value.diagnosticCode !== undefined && !nonEmpty(value.diagnosticCode))) {
    throw new Error('MANAGEMENT_WORKER_V2_PAYLOAD_INVALID');
  }
  return structuredClone(value) as unknown as Phase2TaskToolResultV2;
}

function isPhase2WorkerToolName(value: unknown): value is keyof Phase2ManagementWorkerToolInputMapV1 {
  return value === 'agents.invoke'
    || PHASE_2_TASK_WORKER_TOOL_NAMES.includes(value as never)
    || PHASE_2_COLLABORATION_WORKER_TOOL_NAMES.includes(value as never);
}

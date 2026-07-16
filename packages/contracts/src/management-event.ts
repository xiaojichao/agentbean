import type { ID, UnixMs } from './common.js';
import type { AgentInvocationResultDto } from './invocation.js';
import type { SubtaskAcceptanceV1 } from './task-coordination.js';
import type { AgentHandoffKind } from './collaboration.js';
import type { Phase3ManagementWorkerToolOutputMapV1 } from './management-worker-v2.js';

export interface ManagementEventPayloadMapV1 {
  readonly 'run-started': {
    readonly rootMessageId: ID;
    readonly rootTaskId?: ID;
    readonly mode: 'managed';
  };
  readonly 'worker-leased': {
    readonly workerId: ID;
    readonly leaseFingerprint: string;
    readonly expiresAt: UnixMs;
  };
  readonly 'worker-lost': {
    readonly workerId: ID;
    readonly lastHeartbeatAt: UnixMs;
    readonly reasonCode: string;
  };
  readonly 'checkpoint-updated': {
    readonly checkpointRevision: number;
    readonly lastEventSequence: number;
  };
  readonly 'memory-tool-completed': {
    readonly toolName: 'memory.create_capsule' | 'memory.propose_candidate' | 'memory.link_sources';
    readonly resultReferenceId: ID;
    readonly requestHash: string;
    /** Body-free tool output required to short-circuit an idempotent replay. */
    readonly output?:
      | Phase3ManagementWorkerToolOutputMapV1['memory.create_capsule']
      | Phase3ManagementWorkerToolOutputMapV1['memory.propose_candidate']
      | Phase3ManagementWorkerToolOutputMapV1['memory.link_sources'];
  };
  readonly 'task-created': {
    readonly taskId: ID;
    readonly parentTaskId?: ID;
    readonly taskRevision: number;
  };
  readonly 'task-revised': {
    readonly taskId: ID;
    readonly previousRevision: number;
    readonly taskRevision: number;
    readonly criterionIds: readonly ID[];
    readonly reasonCode: string;
  };
  readonly 'task-state-changed': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly from: 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';
    readonly to: 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';
  };
  readonly 'task-published-for-claim': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly requiredCapabilities: readonly string[];
  };
  readonly 'task-assigned': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly agentId: ID;
  };
  readonly 'task-claimed': {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly agentId: ID;
    readonly claimLeaseId: ID;
    readonly attempt: number;
  };
  readonly 'claim-invalidated': {
    readonly taskId: ID;
    readonly previousTaskRevision: number;
    readonly claimLeaseId: ID;
    readonly invalidatedInvocationIds: readonly ID[];
    readonly reasonCode: string;
  };
  readonly 'subtask-delivered': {
    readonly deliveryId: ID;
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly claimLeaseId: ID;
    readonly invocationId: ID;
  };
  readonly 'task-acceptance-decided': {
    readonly taskId: ID;
    readonly acceptance: SubtaskAcceptanceV1;
  };
  readonly 'invocation-created': {
    readonly invocationId: ID;
    readonly intentHash: string;
    readonly taskRevision?: number;
  };
  readonly 'dispatch-attempt-started': {
    readonly invocationId: ID;
    readonly dispatchId: ID;
    readonly attemptNumber: number;
  };
  readonly 'dispatch-attempt-completed': {
    readonly invocationId: ID;
    readonly dispatchId: ID;
    readonly attemptNumber: number;
    readonly status: AgentInvocationResultDto['status'];
  };
  readonly 'handoff-proposed': {
    readonly proposalId: ID;
    readonly sourceInvocationId: ID;
    readonly sourceAgentId: ID;
    readonly toAgentId: ID;
    readonly kind: AgentHandoffKind;
    readonly taskId?: ID;
    readonly taskRevision?: number;
    readonly claimLeaseId?: ID;
    readonly proposalHash: string;
  };
  readonly 'handoff-requested': {
    readonly handoffId: ID;
    readonly sourceProposalId?: ID;
    readonly sourceInvocationId?: ID;
    readonly fromAgentId?: ID;
    readonly toAgentId: ID;
    readonly kind: AgentHandoffKind;
    readonly objectiveHash: string;
  };
  readonly 'handoff-dispatched': {
    readonly handoffId: ID;
    readonly invocationId: ID;
  };
  readonly 'handoff-returned': {
    readonly handoffId: ID;
    readonly invocationId: ID;
    readonly status: AgentInvocationResultDto['status'];
    readonly resultRevision: number;
    readonly artifactIds: readonly ID[];
  };
  readonly 'active-agent-changed': {
    readonly previousAgentId?: ID;
    readonly nextAgentId?: ID;
    readonly handoffId?: ID;
    readonly reasonCode: string;
  };
  readonly 'waiting-for-user': {
    readonly reasonCode: string;
    readonly questionMessageId?: ID;
  };
  readonly 'root-delivery-submitted': {
    readonly messageId: ID;
    readonly contributingInvocationIds: readonly ID[];
  };
  readonly 'run-completed': {
    readonly completedTaskId?: ID;
    readonly deliveryMessageId: ID;
  };
  readonly 'run-failed': {
    readonly errorCode: string;
    readonly recoverable: boolean;
  };
  readonly 'run-cancelled': {
    readonly reasonCode: string;
    readonly cancelledBy: ID;
  };
}

export type ManagementEventTypeV1 = keyof ManagementEventPayloadMapV1;

export type ManagementEventV1 = {
  readonly [T in ManagementEventTypeV1]: {
    readonly schemaVersion: 1;
    readonly id: ID;
    readonly managementRunId: ID;
    readonly sequence: number;
    readonly type: T;
    readonly actorKind: 'system' | 'manager' | 'agent' | 'human';
    readonly actorId?: ID;
    readonly idempotencyKey: string;
    readonly causationEventId?: ID;
    readonly payload: ManagementEventPayloadMapV1[T];
    readonly createdAt: UnixMs;
  };
}[ManagementEventTypeV1];

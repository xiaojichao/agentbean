import type { ID, UnixMs } from './common.js';
import type { AgentInvocationResultDto } from './invocation.js';
import type { SubtaskAcceptanceV1 } from './task-coordination.js';

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

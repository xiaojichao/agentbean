import type { ID, UnixMs } from './common.js';
import type { DispatchStatus } from './dispatch.js';
import type { AcceptanceCriterionDto } from './task-coordination.js';

export type AgentInvocationTargetKind = 'custom' | 'agentos-hosted';

export type AgentInvocationStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface DependencyResultRefDto {
  readonly invocationId: ID;
  readonly resultRevision: number;
  readonly artifactIds: readonly ID[];
  readonly workspaceRunId?: ID;
}

export interface AgentInvocationTaskContextV1 {
  readonly taskId: ID;
  readonly rootTaskId?: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
}

export interface AgentInvocationIntentV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly targetAgentId: ID;
  readonly targetKind: AgentInvocationTargetKind;
  readonly objective: string;
  readonly taskContext?: AgentInvocationTaskContextV1;
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly dependencyResults: readonly DependencyResultRefDto[];
  readonly memoryCapsuleId?: ID;
  readonly attachmentIds: readonly ID[];
  readonly deadlineAt?: UnixMs;
}

export interface AgentInvocationRecordDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly managementRunId: ID;
  readonly intent: AgentInvocationIntentV1;
  readonly intentHash: string;
  readonly idempotencyKey: string;
  readonly createdAt: UnixMs;
}

export interface AgentInvocationDispatchAttemptDto {
  readonly dispatchId: ID;
  readonly attemptNumber: number;
  readonly status: DispatchStatus;
}

export interface AgentInvocationViewDto extends AgentInvocationRecordDto {
  readonly status: AgentInvocationStatus;
  readonly dispatchAttempts: readonly AgentInvocationDispatchAttemptDto[];
  readonly activeDispatchId?: ID;
}

export interface AgentInvocationResultDto {
  readonly schemaVersion: 1;
  readonly invocationId: ID;
  readonly taskId?: ID;
  readonly agentId: ID;
  readonly status: Extract<AgentInvocationStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;
  readonly body?: string;
  readonly artifactIds: readonly ID[];
  readonly workspaceRunId?: ID;
  readonly memoryCandidateIds: readonly ID[];
  readonly startedAt: UnixMs;
  readonly completedAt: UnixMs;
  readonly error?: string;
}

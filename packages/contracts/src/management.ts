import type { ID, UnixMs } from './common.js';

export type ManagementMode = 'direct' | 'shadow' | 'managed';

export type ManagementRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_agents'
  | 'waiting_for_user'
  | 'recovering'
  | 'in_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ManagerPlacement = 'managed' | 'device' | 'auto';

export interface ManagerPlacementPolicyDto {
  readonly placement: ManagerPlacement;
  readonly allowedDeviceIds?: readonly ID[];
  readonly allowServerContext: boolean;
  readonly requireLocalModelCredentials: boolean;
  readonly preferredProvider?: string;
  readonly preferredModel?: string;
}

export interface ManagementBudgetDto {
  readonly maxSubtasks: number;
  readonly maxDepth: number;
  readonly maxExternalInvocations: number;
}

export interface ManagementRunDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly rootTaskId?: ID;
  readonly rootMessageId: ID;
  readonly mode: 'managed';
  readonly status: ManagementRunStatus;
  readonly placementPolicy: ManagerPlacementPolicyDto;
  readonly activeWorkerId?: ID;
  readonly checkpointRevision: number;
  readonly budget: ManagementBudgetDto;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
  readonly completedAt?: UnixMs;
}

export interface ManagementCheckpointAuthoritativeV1 {
  readonly lastEventSequence: number;
  readonly taskGraphRevision: number;
  readonly openTaskIds: readonly ID[];
  readonly waitingInvocationIds: readonly ID[];
  readonly completedInvocationIds: readonly ID[];
  readonly memoryCapsuleIds: readonly ID[];
}

export interface ManagementCheckpointContextHintsV1 {
  readonly objective: string;
  readonly planSummary: string;
  readonly completedInvocationSummaries: readonly {
    readonly invocationId: ID;
    readonly summary: string;
  }[];
  readonly unresolvedQuestions: readonly string[];
  readonly nextAction?: string;
}

export interface ManagementCheckpointV1 {
  readonly schemaVersion: 1;
  readonly managementRunId: ID;
  readonly revision: number;
  readonly authoritative: ManagementCheckpointAuthoritativeV1;
  readonly contextHints: ManagementCheckpointContextHintsV1;
  readonly updatedAt: UnixMs;
}

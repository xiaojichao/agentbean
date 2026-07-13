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

export interface TeamManagementPolicyDto {
  readonly teamId: ID;
  readonly mode: ManagementMode;
  readonly placementPolicy: ManagerPlacementPolicyDto;
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

export interface GetTeamManagementPolicyInput {
  readonly teamId: ID;
}

export interface UpdateTeamManagementPolicyInput {
  readonly teamId: ID;
  readonly mode: ManagementMode;
  readonly placementPolicy?: ManagerPlacementPolicyDto;
}

export interface ManagementRunDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly rootTaskId?: ID;
  readonly rootMessageId: ID;
  readonly frozenTarget?: {
    readonly agentId: ID;
    readonly kind: 'custom' | 'agentos-hosted';
  };
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

export interface TeamManagementPolicyV2Dto {
  readonly schemaVersion: 2;
  readonly teamId: ID;
  readonly mode: ManagementMode;
  readonly maxManagementPhase: 1 | 2;
  readonly placementPolicy: ManagerPlacementPolicyDto;
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

interface ManagementRunV2BaseDto {
  readonly schemaVersion: 2;
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly rootMessageId: ID;
  readonly frozenTarget?: ManagementRunDto['frozenTarget'];
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

export type ManagementRunV2Dto = ManagementRunV2BaseDto & (
  | { readonly managementPhase: 1; readonly rootTaskId?: ID }
  | { readonly managementPhase: 2; readonly rootTaskId: ID }
);

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

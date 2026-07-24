import type { ID, UnixMs } from './common.js';
import type { ActiveMemoryAttributionDto } from './active-memory-context.js';

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
  readonly maxManagementPhase?: 1 | 2 | 3;
  readonly placementPolicy?: ManagerPlacementPolicyDto;
}

export interface ManagementRunDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly rootTaskId?: ID;
  readonly rootMessageId: ID;
  /** 发起本次管理 Run 的用户；Server Worker 只能继承该用户的当前权限。 */
  readonly initiatedByUserId?: ID;
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
  readonly maxManagementPhase: 1 | 2 | 3;
  readonly placementPolicy: ManagerPlacementPolicyDto;
  /** Phase 4 第二阶段 #648：Team 预算覆盖（已钳制）；缺省字段回落 Phase 默认值。 */
  readonly budgetOverrides?: Partial<ManagementBudgetDto>;
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

interface ManagementRunV2BaseDto {
  readonly schemaVersion: 2;
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly rootMessageId: ID;
  /** 发起本次管理 Run 的用户；Server Worker 只能继承该用户的当前权限。 */
  readonly initiatedByUserId?: ID;
  readonly frozenTarget?: ManagementRunDto['frozenTarget'];
  readonly mainAgentId?: ID;
  readonly activeAgentId?: ID;
  readonly collaborationMode?: 'single-agent' | 'manager-orchestrated' | 'handoff';
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
  | { readonly managementPhase: 3; readonly rootTaskId: ID }
);

export interface ManagementCheckpointAuthoritativeV1 {
  readonly lastEventSequence: number;
  readonly taskGraphRevision: number;
  readonly openTaskIds: readonly ID[];
  readonly waitingInvocationIds: readonly ID[];
  readonly completedInvocationIds: readonly ID[];
  readonly memoryCapsuleIds: readonly ID[];
  /** Phase 2 adds these fields without changing the frozen Phase 1 fixture shape. */
  readonly taskSnapshots?: readonly {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';
    readonly claimLeaseId?: ID;
  }[];
  readonly activeClaimLeaseIds?: readonly ID[];
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
  /**
   * #720 Active Memory 渲染片段。由 server 在 checkpoint 写入时调 resolver 产出（已完成权限过滤+渲染）；
   * daemon 恢复时读出拼入 systemPrompt。可选字段——旧 checkpoint 恢复时为 undefined（向后兼容）。
   */
  readonly activeMemorySection?: string;
  /** #720 Active Memory 归因摘要（ID+来源码列表，不存正文）。 */
  readonly activeMemoryAttribution?: ActiveMemoryAttributionDto;
}

export interface ManagementCheckpointV1 {
  readonly schemaVersion: 1;
  readonly managementRunId: ID;
  readonly revision: number;
  readonly authoritative: ManagementCheckpointAuthoritativeV1;
  readonly contextHints: ManagementCheckpointContextHintsV1;
  readonly updatedAt: UnixMs;
}

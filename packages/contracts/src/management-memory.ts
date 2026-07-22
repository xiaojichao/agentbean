import type { ID, UnixMs } from './common.js';

export const MEMORY_KINDS = [
  'semantic',
  'episodic',
  'procedural',
  'preference',
  'decision',
  'artifact-summary',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = [
  'candidate',
  'active',
  'rejected',
  'expired',
  'superseded',
  'deleted',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Server-hosted scopes. Device-local scopes are intentionally excluded. */
export const MEMORY_SCOPE_TYPES = ['team', 'channel', 'dm', 'task', 'agent', 'user'] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export const LOCAL_MEMORY_SCOPE_TYPES = ['local-workspace', 'local-agent', 'local-profile'] as const;
export type LocalMemoryScopeType = (typeof LOCAL_MEMORY_SCOPE_TYPES)[number];

export type MemoryCapsuleScopeType = MemoryScopeType | 'local-workspace';
export type MemorySourceVisibility = 'team' | 'private' | 'dm-participants' | 'local-only';
export type MemoryContentKind = 'summary' | 'fact' | 'decision' | 'preference' | 'procedure';
export type MemoryRedactionLevel = 'none' | 'summary-only' | 'sensitive-removed';
export type MemorySourceKind =
  | 'message'
  | 'task'
  | 'artifact'
  | 'workspace-run'
  | 'invocation'
  | 'memory'
  | 'manual'
  | 'local-summary';

export interface MemorySourceRefDto {
  readonly schemaVersion: 1;
  readonly sourceKind: MemorySourceKind;
  readonly sourceId: ID;
  readonly snapshotHash: string;
}

export interface MemoryRecordDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly kind: MemoryKind;
  readonly status: MemoryStatus;
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: ID;
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly createdByUserId?: ID;
  readonly createdByAgentId?: ID;
  readonly validUntil?: UnixMs;
  readonly supersededById?: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
  /** Formal Memory 产品标记（issue #716）。非 NULL 表示这是 Formal Memory。 */
  readonly formalKind?: import('./formal-memory.js').FormalMemoryKind;
  /** 最近一次人工变更原因（Formal Memory AC#4）。 */
  readonly changeReason?: string;
  /** 版本族 id，supersede 时继承，用于聚合版本历史。 */
  readonly versionFamilyId?: ID;
}

export interface MemoryCapsuleAuthorizationDto {
  readonly schemaVersion: 1;
  readonly decisionId: ID;
  readonly mode: 'scope-policy' | 'explicit-grant';
  readonly policyVersion: number;
  readonly grantId?: ID;
  readonly grantVersion?: number;
  readonly targetAgentId: ID;
  readonly sourceScopeType: MemoryCapsuleScopeType;
  readonly sourceScopeRef: ID;
  readonly sourceRefsHash: string;
  readonly contentHash: string;
  readonly authorizedContentKind: MemoryContentKind;
  readonly authorizedRedactionLevel: MemoryRedactionLevel;
  readonly issuedAt: UnixMs;
  readonly expiresAt: UnixMs;
}

export interface MemoryCapsuleItemDto {
  readonly schemaVersion: 1;
  readonly memoryId: ID;
  readonly scopeType: MemoryCapsuleScopeType;
  readonly scopeRef: ID;
  readonly sourceVisibility: MemorySourceVisibility;
  readonly contentKind: MemoryContentKind;
  readonly redactionLevel: MemoryRedactionLevel;
  readonly content: string;
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly authorization: MemoryCapsuleAuthorizationDto;
  readonly expiresAt?: UnixMs;
}

export interface MemoryCapsuleDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly targetAgentId: ID;
  readonly items: readonly MemoryCapsuleItemDto[];
  readonly createdAt: UnixMs;
  readonly expiresAt: UnixMs;
}

export type MemoryCandidateStatus = 'candidate' | 'accepted' | 'rejected' | 'merged' | 'conflict';

export interface MemoryCandidateDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly sourceAgentId: ID;
  readonly sourceInvocationId: ID;
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly contentKind: MemoryContentKind;
  readonly proposedContent: string;
  readonly projectionHash: string;
  readonly status: MemoryCandidateStatus;
  readonly conflictMemoryIds: readonly ID[];
  readonly createdAt: UnixMs;
  readonly decidedAt?: UnixMs;
}

export interface MemoryCapsuleRefDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly targetAgentId: ID;
  readonly contentHash: string;
  readonly authorizationDecisionId: ID;
  readonly expiresAt: UnixMs;
}

export interface MemoryCandidateRefDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly sourceKind: Exclude<MemorySourceKind, 'manual' | 'local-summary'>;
  readonly sourceId: ID;
  readonly projectionHash: string;
  readonly createdAt: UnixMs;
}

export type MemoryGovernanceSourceState = 'valid' | 'source-invalid';
export type MemoryGovernanceCapsuleState = 'active' | 'expired' | 'revoked';

export interface MemoryGovernanceItemDto extends MemoryRecordDto {
  readonly sourceState: MemoryGovernanceSourceState;
}

export interface MemoryGovernanceGrantDto {
  readonly id: ID;
  readonly version: number;
  readonly teamId: ID;
  readonly sourceScopeType: MemoryScopeType;
  readonly sourceScopeRef: ID;
  readonly targetAgentId: ID;
  readonly authorizedContentKind: MemoryContentKind;
  readonly authorizedRedactionLevel: MemoryRedactionLevel;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly issuedByUserId: ID;
  readonly issuedAt: UnixMs;
  readonly expiresAt: UnixMs;
  readonly revokedAt?: UnixMs;
}

export interface MemoryGovernanceCandidateDto extends MemoryCandidateDto {
  readonly targetAgentId: ID;
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: ID;
  readonly proposedSummary?: string;
  readonly acceptedMemoryId?: ID;
  readonly mergedIntoMemoryId?: ID;
  readonly updatedAt: UnixMs;
  readonly sourceState: MemoryGovernanceSourceState;
}

export interface MemoryGovernanceCapsuleItemDto {
  readonly memoryId: ID;
  readonly position: number;
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: ID;
  readonly contentKind: MemoryContentKind;
  readonly redactionLevel: MemoryRedactionLevel;
  readonly authorization: MemoryCapsuleAuthorizationDto;
  readonly expiresAt?: UnixMs;
}

export interface MemoryGovernanceCapsuleDto extends MemoryCapsuleRefDto {
  readonly state: MemoryGovernanceCapsuleState;
  readonly deniedAt?: UnixMs;
  readonly items: readonly MemoryGovernanceCapsuleItemDto[];
}

export interface MemoryGovernanceInvocationDto {
  readonly id: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly targetAgentId: ID;
  readonly capsuleRef?: MemoryCapsuleRefDto;
  readonly createdAt: UnixMs;
}

export interface MemoryGovernanceSnapshotDto {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly canManage: boolean;
  readonly memories: readonly MemoryGovernanceItemDto[];
  readonly grants: readonly MemoryGovernanceGrantDto[];
  readonly candidates: readonly MemoryGovernanceCandidateDto[];
  readonly capsules: readonly MemoryGovernanceCapsuleDto[];
  readonly invocations: readonly MemoryGovernanceInvocationDto[];
  readonly refreshedAt: UnixMs;
}

export interface LocalMemoryGovernanceSummaryDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly kind: MemoryKind;
  readonly scopeType: LocalMemoryScopeType;
  readonly status: 'active' | 'expired' | 'superseded' | 'deleted';
  readonly sourceKind: 'scan' | 'workspace_run' | 'manual' | 'local_file';
  readonly summary: string;
  readonly workspaceLabel?: string;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
  readonly validUntil?: UnixMs;
}

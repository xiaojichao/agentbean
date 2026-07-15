import type { ID, UnixMs } from './common.js';
import type { TaskDto } from './task.js';
import type { AgentHandoffTraceDto } from './collaboration.js';

export type EvidenceKind = 'message' | 'artifact' | 'workspace-run' | 'invocation' | 'task';

export interface AcceptanceCriterionDto {
  readonly id: ID;
  readonly description: string;
  readonly evidenceRequired: boolean;
  readonly allowedEvidenceKinds?: readonly EvidenceKind[];
}

export interface EvidenceRefDto {
  readonly kind: EvidenceKind;
  readonly id: ID;
  readonly snapshotHash: string;
  readonly snapshotRevision?: number;
  readonly capturedAt: UnixMs;
}

export interface TaskCoordinationDto {
  readonly schemaVersion: 1;
  readonly rootTaskId?: ID;
  readonly parentTaskId?: ID;
  readonly managementRunId: ID;
  readonly nodeKind: 'root' | 'subtask';
  readonly reviewPolicy: 'human' | 'manager';
  readonly claimPolicy: 'open' | 'targeted';
  readonly requiredCapabilities: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly dependencyTaskIds: readonly ID[];
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface SubtaskDeliveryV1 {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly invocationId: ID;
  readonly summary: string;
  readonly claims: readonly {
    readonly statement: string;
    readonly evidenceRefs: readonly EvidenceRefDto[];
  }[];
  readonly evidenceRefs: readonly EvidenceRefDto[];
}

export interface SubtaskAcceptanceV1 {
  readonly schemaVersion: 1;
  readonly taskId: ID;
  readonly deliveryId: ID;
  readonly expectedTaskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly decision: 'accepted' | 'rejected' | 'needs_human';
  readonly criteriaResults: readonly {
    readonly criterionId: ID;
    readonly passed: boolean;
    readonly evidenceRefs: readonly EvidenceRefDto[];
  }[];
  readonly reason: string;
  readonly decidedBy: 'manager' | 'human';
  readonly decidedAt: UnixMs;
}

export interface TaskDagClaimViewDto {
  readonly agentId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly status: 'active' | 'released' | 'expired' | 'invalidated';
  readonly acquiredAt: UnixMs;
  readonly expiresAt: UnixMs;
}

export interface TaskDagResultRefDto {
  readonly kind: EvidenceKind | 'invocation';
  readonly id: ID;
}

export interface TaskDagNodeViewDto {
  readonly task: TaskDto;
  readonly taskRevision: number;
  readonly coordination: TaskCoordinationDto;
  readonly claim?: TaskDagClaimViewDto;
  readonly latestDelivery?: {
    readonly id: ID;
    readonly invocationId: ID;
    readonly summary: string;
  };
  readonly canonicalAcceptance?: {
    readonly decision: SubtaskAcceptanceV1['decision'];
    readonly reason: string;
    readonly decidedBy: SubtaskAcceptanceV1['decidedBy'];
    readonly decidedAt: UnixMs;
  };
  readonly resultRefs: readonly TaskDagResultRefDto[];
}

export interface TaskDagViewDto {
  readonly schemaVersion: 1;
  readonly managementRunId: ID;
  readonly rootTaskId: ID;
  readonly graphRevision: number;
  readonly nodes: readonly TaskDagNodeViewDto[];
  readonly handoffs?: readonly AgentHandoffTraceDto[];
  readonly events: readonly {
    readonly sequence: number;
    readonly type: string;
    readonly createdAt: UnixMs;
  }[];
}

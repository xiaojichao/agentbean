import type { ID, UnixMs } from './common.js';

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

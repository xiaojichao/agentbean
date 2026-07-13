import type {
  AcceptanceCriterionDto,
  EvidenceKind,
  ID,
  SubtaskAcceptanceV1,
  SubtaskDeliveryV1,
  TaskCoordinationDto,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';

export interface TaskCoordinationRecord extends Omit<
  TaskCoordinationDto,
  'acceptanceCriteria' | 'dependencyTaskIds'
> {
  readonly taskId: ID;
  readonly teamId: ID;
  readonly taskRevision: number;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface TaskAcceptanceCriterionRecord extends AcceptanceCriterionDto {
  readonly taskId: ID;
  readonly introducedRevision: number;
  readonly retiredRevision?: number;
  readonly position: number;
}

export interface TaskDependencyRecord {
  readonly taskId: ID;
  readonly dependencyTaskId: ID;
  readonly taskRevision: number;
}

export type TaskClaimLeaseStatus = 'active' | 'released' | 'expired' | 'invalidated';

export interface TaskClaimLeaseRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly agentId: ID;
  readonly leaseTokenHash: string;
  readonly leaseFingerprint: string;
  readonly fencingToken: number;
  readonly status: TaskClaimLeaseStatus;
  readonly acquiredAt: UnixMs;
  readonly heartbeatAt: UnixMs;
  readonly expiresAt: UnixMs;
  readonly releasedAt?: UnixMs;
}

export interface EvidenceSnapshotRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly invocationId: ID;
  readonly kind: EvidenceKind;
  readonly sourceId: ID;
  readonly snapshotHash: string;
  readonly snapshotRevision?: number;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly capturedAt: UnixMs;
}

export interface SubtaskDeliveryRecord extends SubtaskDeliveryV1 {
  readonly teamId: ID;
  readonly idempotencyKey: string;
  readonly createdAt: UnixMs;
}

export interface SubtaskAcceptanceRecord extends SubtaskAcceptanceV1 {
  readonly id: ID;
  readonly teamId: ID;
  readonly decisionVersion: number;
  readonly canonical: boolean;
}

export interface TaskCoordinationRepositories {
  coordinations: {
    create(record: TaskCoordinationRecord): Promise<TaskCoordinationRecord>;
    getByTaskId(taskId: ID): Promise<TaskCoordinationRecord | null>;
    listByManagementRun(managementRunId: ID): Promise<TaskCoordinationRecord[]>;
    update(input: {
      record: TaskCoordinationRecord;
      expectedTaskRevision: number;
    }): Promise<TaskCoordinationRecord | null>;
  };
  criteria: {
    create(record: TaskAcceptanceCriterionRecord): Promise<TaskAcceptanceCriterionRecord>;
    updatePosition(input: {
      taskId: ID;
      criterionId: ID;
      position: number;
    }): Promise<TaskAcceptanceCriterionRecord | null>;
    retire(input: {
      taskId: ID;
      criterionId: ID;
      retiredRevision: number;
    }): Promise<TaskAcceptanceCriterionRecord | null>;
    list(taskId: ID): Promise<TaskAcceptanceCriterionRecord[]>;
  };
  dependencies: {
    create(record: TaskDependencyRecord): Promise<TaskDependencyRecord>;
    delete(input: { taskId: ID; dependencyTaskId: ID }): Promise<void>;
    list(taskId: ID): Promise<TaskDependencyRecord[]>;
  };
  claimLeases: {
    create(record: TaskClaimLeaseRecord): Promise<TaskClaimLeaseRecord>;
    getById(id: ID): Promise<TaskClaimLeaseRecord | null>;
    getCurrent(input: {
      taskId: ID;
      taskRevision: number;
      taskAttempt: number;
    }): Promise<TaskClaimLeaseRecord | null>;
    update(input: {
      id: ID;
      expectedStatus: TaskClaimLeaseStatus;
      status: TaskClaimLeaseStatus;
      heartbeatAt: UnixMs;
      expiresAt: UnixMs;
      releasedAt?: UnixMs;
    }): Promise<TaskClaimLeaseRecord | null>;
  };
  evidenceSnapshots: {
    create(record: EvidenceSnapshotRecord): Promise<EvidenceSnapshotRecord>;
    getById(id: ID): Promise<EvidenceSnapshotRecord | null>;
    listByTask(taskId: ID): Promise<EvidenceSnapshotRecord[]>;
  };
  deliveries: {
    create(record: SubtaskDeliveryRecord): Promise<SubtaskDeliveryRecord>;
    getById(id: ID): Promise<SubtaskDeliveryRecord | null>;
    getByIdempotencyKey(input: {
      taskId: ID;
      idempotencyKey: string;
    }): Promise<SubtaskDeliveryRecord | null>;
  };
  acceptances: {
    create(record: SubtaskAcceptanceRecord): Promise<SubtaskAcceptanceRecord>;
    getCanonicalByDelivery(deliveryId: ID): Promise<SubtaskAcceptanceRecord | null>;
    listByDelivery(deliveryId: ID): Promise<SubtaskAcceptanceRecord[]>;
  };
}

import type {
  AcceptanceCriterionDto,
  EvidenceKind,
  ID,
  SubtaskAcceptanceV1,
  SubtaskDeliveryV1,
  TaskCoordinationDto,
  TaskOfferObjectiveDto,
  TaskOfferResponseRecordDto,
  TaskOfferStatus,
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

/**
 * #712 切片 C 后续：Task Offer 持久化记录。
 * 对应 contracts TaskOfferDto；objective 与发布时冻结的 taskRevision/manifestRevision 一并落库。
 * response 内联最新响应（domain 状态机保证每 offer 至多一个终态响应），null = 尚未响应。
 */
export interface TaskOfferRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly taskId: ID;
  readonly agentId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly manifestRevision: number;
  readonly objective: TaskOfferObjectiveDto;
  readonly offerTtlMs: UnixMs;
  readonly offerExpiresAt: UnixMs;
  readonly hardSpecified: boolean;
  readonly status: TaskOfferStatus;
  readonly response: TaskOfferResponseRecordDto | null;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
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
    getLatest(input: {
      taskId: ID;
      taskRevision: number;
      taskAttempt: number;
    }): Promise<TaskClaimLeaseRecord | null>;
    listActive(): Promise<TaskClaimLeaseRecord[]>;
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
    listByTask(taskId: ID): Promise<SubtaskDeliveryRecord[]>;
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
  offers: {
    create(record: TaskOfferRecord): Promise<TaskOfferRecord>;
    getById(id: ID): Promise<TaskOfferRecord | null>;
    listByTask(taskId: ID): Promise<TaskOfferRecord[]>;
    listByAgent(input: {
      teamId: ID;
      agentId: ID;
      statuses?: readonly TaskOfferStatus[];
    }): Promise<TaskOfferRecord[]>;
    /**
     * CAS 状态转移（AC#3 状态机 + AC#6 并发单赢家的持久化兜底）。
     * expectedStatus 不匹配（已被并发改动）→ 返回 null，调用方据此回滚/判 overtaken，
     * 不写入。与 claimLeases.update 同款乐观并发。
     */
    updateStatus(input: {
      id: ID;
      expectedStatus: TaskOfferStatus;
      status: TaskOfferStatus;
      response: TaskOfferResponseRecordDto | null;
      now: UnixMs;
    }): Promise<TaskOfferRecord | null>;
  };
}

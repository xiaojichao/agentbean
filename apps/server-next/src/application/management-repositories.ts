import type {
  AgentInvocationRecordDto,
  DispatchStatus,
  ID,
  ManagementCheckpointV1,
  ManagementEventV1,
  ManagementMode,
  ManagementRunDto,
  ManagerPlacementPolicyDto,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import type { ManagerLeaseRecord } from '../../../../packages/domain/src/index.js';

export interface ManagedRequestReservationRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly managementRunId: ID;
  readonly createdAt: UnixMs;
}

export interface ManagementPolicyRecord {
  readonly teamId: ID;
  readonly mode: ManagementMode;
  readonly placementPolicy: ManagerPlacementPolicyDto;
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

export interface ManagementEventRecord {
  readonly event: ManagementEventV1;
  readonly payloadHash: string;
}

export interface InvocationDispatchAttemptRecord {
  readonly id: ID;
  readonly invocationId: ID;
  readonly dispatchId: ID;
  readonly attemptNumber: number;
  readonly status: DispatchStatus;
  readonly startedAt: UnixMs;
  readonly completedAt?: UnixMs;
}

export interface ManagementShadowDecisionRecord {
  readonly id: ID;
  readonly managementRunId: ID;
  readonly inputHash: string;
  readonly objectiveHash: string;
  readonly argumentHash: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly toolSequence: readonly string[];
  readonly diagnostics: Readonly<Record<string, unknown>>;
  readonly createdAt: UnixMs;
}

export interface ManagementRepositories {
  policies: {
    get(teamId: ID): Promise<ManagementPolicyRecord | null>;
    upsert(record: ManagementPolicyRecord): Promise<ManagementPolicyRecord>;
  };
  reservations: {
    create(record: ManagedRequestReservationRecord): Promise<ManagedRequestReservationRecord>;
    getByRequestKey(input: { teamId: ID; requestKey: string }): Promise<ManagedRequestReservationRecord | null>;
  };
  runs: {
    create(record: ManagementRunDto): Promise<ManagementRunDto>;
    getById(id: ID): Promise<ManagementRunDto | null>;
  };
  leases: {
    get(managementRunId: ID): Promise<ManagerLeaseRecord | null>;
    put(record: ManagerLeaseRecord): Promise<ManagerLeaseRecord>;
  };
  events: {
    append(record: ManagementEventRecord): Promise<ManagementEventRecord>;
    list(managementRunId: ID): Promise<ManagementEventRecord[]>;
  };
  checkpoints: {
    put(record: ManagementCheckpointV1): Promise<ManagementCheckpointV1>;
    getLatest(managementRunId: ID): Promise<ManagementCheckpointV1 | null>;
  };
  invocations: {
    create(record: AgentInvocationRecordDto): Promise<AgentInvocationRecordDto>;
    getById(id: ID): Promise<AgentInvocationRecordDto | null>;
  };
  dispatchAttempts: {
    create(record: InvocationDispatchAttemptRecord): Promise<InvocationDispatchAttemptRecord>;
    list(invocationId: ID): Promise<InvocationDispatchAttemptRecord[]>;
  };
  shadowDecisions: {
    create(record: ManagementShadowDecisionRecord): Promise<ManagementShadowDecisionRecord>;
  };
}

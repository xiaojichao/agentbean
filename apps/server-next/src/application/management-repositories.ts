import type {
  AgentInvocationRecordDto,
  AgentCollaborationProposalRecordDto,
  AgentHandoffRecordDto,
  DispatchStatus,
  ID,
  ManagementCheckpointV1,
  ManagementEventV1,
  ManagementRunDto,
  ManagementRunV2Dto,
  TeamManagementPolicyV2Dto,
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

export type ManagementPolicyRecord = TeamManagementPolicyV2Dto;
export type ManagementRunRecord = ManagementRunDto | ManagementRunV2Dto;

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
  readonly shadowRequestKey: string;
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
    create(record: ManagementRunRecord): Promise<ManagementRunRecord>;
    getById(id: ID): Promise<ManagementRunRecord | null>;
    getByRootTaskId(rootTaskId: ID): Promise<ManagementRunRecord | null>;
    update(record: ManagementRunRecord): Promise<ManagementRunRecord>;
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
    get(input: { managementRunId: ID; revision: number }): Promise<ManagementCheckpointV1 | null>;
    getLatest(managementRunId: ID): Promise<ManagementCheckpointV1 | null>;
  };
  invocations: {
    create(record: AgentInvocationRecordDto): Promise<AgentInvocationRecordDto>;
    getById(id: ID): Promise<AgentInvocationRecordDto | null>;
    getByIdempotencyKey(input: { managementRunId: ID; idempotencyKey: string }): Promise<AgentInvocationRecordDto | null>;
    listByRun(managementRunId: ID): Promise<AgentInvocationRecordDto[]>;
  };
  collaborationProposals: {
    create(record: AgentCollaborationProposalRecordDto): Promise<AgentCollaborationProposalRecordDto>;
    getById(id: ID): Promise<AgentCollaborationProposalRecordDto | null>;
    getByIdempotencyKey(input: { managementRunId: ID; idempotencyKey: string }): Promise<AgentCollaborationProposalRecordDto | null>;
    listByRun(managementRunId: ID): Promise<AgentCollaborationProposalRecordDto[]>;
  };
  handoffs: {
    create(record: AgentHandoffRecordDto): Promise<AgentHandoffRecordDto>;
    update(record: AgentHandoffRecordDto): Promise<AgentHandoffRecordDto>;
    getById(id: ID): Promise<AgentHandoffRecordDto | null>;
    getByInvocationId(invocationId: ID): Promise<AgentHandoffRecordDto | null>;
    getByIdempotencyKey(input: { managementRunId: ID; idempotencyKey: string }): Promise<AgentHandoffRecordDto | null>;
    listByRun(managementRunId: ID): Promise<AgentHandoffRecordDto[]>;
  };
  dispatchAttempts: {
    create(record: InvocationDispatchAttemptRecord): Promise<InvocationDispatchAttemptRecord>;
    update(record: InvocationDispatchAttemptRecord): Promise<InvocationDispatchAttemptRecord>;
    getByDispatchId(dispatchId: ID): Promise<InvocationDispatchAttemptRecord | null>;
    list(invocationId: ID): Promise<InvocationDispatchAttemptRecord[]>;
  };
  shadowDecisions: {
    create(record: ManagementShadowDecisionRecord): Promise<ManagementShadowDecisionRecord>;
    getByRequestKey(shadowRequestKey: string): Promise<ManagementShadowDecisionRecord | null>;
  };
}

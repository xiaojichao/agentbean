import type {
  ID,
  MemoryCapsuleScopeType,
  MemoryContentKind,
  MemoryRecordDto,
  MemoryRedactionLevel,
  MemoryScopeType,
  MemorySourceKind,
  MemorySourceRefDto,
  MemorySourceVisibility,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';

export interface MemoryItemRecord extends Omit<MemoryRecordDto, 'tags' | 'sourceRefs'> {
  readonly confidence?: number;
  readonly validFrom?: UnixMs;
  readonly approvedByUserId?: ID;
}

export interface MemorySourceRecord {
  readonly memoryId: ID;
  readonly teamId: ID;
  readonly sourceKind: MemorySourceKind;
  readonly sourceId: ID;
  readonly snapshotHash: string;
  readonly sourceScopeType: MemoryScopeType;
  readonly sourceScopeRef: ID;
  readonly sourceVisibility: MemorySourceVisibility;
  readonly createdAt: UnixMs;
}

export interface MemoryTagRecord {
  readonly memoryId: ID;
  readonly teamId: ID;
  readonly tag: string;
  readonly createdAt: UnixMs;
}

export type MemoryGrantStatus = 'active' | 'revoked' | 'expired';

export interface MemoryGrantRecord {
  readonly id: ID;
  readonly version: number;
  readonly teamId: ID;
  readonly sourceScopeType: MemoryScopeType;
  readonly sourceScopeRef: ID;
  readonly targetAgentId: ID;
  readonly authorizedContentKind: MemoryContentKind;
  readonly authorizedRedactionLevel: MemoryRedactionLevel;
  readonly status: MemoryGrantStatus;
  readonly issuedByUserId: ID;
  readonly issuedAt: UnixMs;
  readonly expiresAt: UnixMs;
  readonly revokedAt?: UnixMs;
}

export type MemoryAuditSubjectKind = 'memory' | 'grant' | 'capsule' | 'candidate';
export type MemoryAuditActorKind = 'system' | 'user' | 'agent' | 'manager';
export type MemoryAuditEventType =
  | 'memory-created'
  | 'memory-updated'
  | 'memory-activated'
  | 'memory-rejected'
  | 'memory-expired'
  | 'memory-superseded'
  | 'memory-deleted'
  | 'source-linked'
  | 'tag-linked'
  | 'tag-unlinked'
  | 'grant-issued'
  | 'grant-revoked'
  | 'capsule-created'
  | 'capsule-read'
  | 'capsule-injected'
  | 'capsule-denied'
  | 'capsule-expired'
  | 'candidate-created'
  | 'candidate-decided';

export interface MemoryAuditEventRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly subjectKind: MemoryAuditSubjectKind;
  readonly subjectId: ID;
  readonly eventType: MemoryAuditEventType;
  readonly actorKind: MemoryAuditActorKind;
  readonly actorId?: ID;
  readonly decisionId?: ID;
  readonly targetAgentId?: ID;
  readonly scopeType?: MemoryCapsuleScopeType;
  readonly scopeRef?: ID;
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly sourceRefsHash?: string;
  readonly contentHash?: string;
  readonly redactionLevel?: MemoryRedactionLevel;
  readonly createdAt: UnixMs;
}

export interface MemoryCapsuleRefRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly targetAgentId: ID;
  readonly contentHash: string;
  readonly authorizationDecisionId: ID;
  readonly issuedAt: UnixMs;
  readonly expiresAt: UnixMs;
  readonly deniedAt?: UnixMs;
  readonly createdAt: UnixMs;
}

export interface MemoryRepositories {
  readonly items: {
    create(record: MemoryItemRecord): Promise<MemoryItemRecord>;
    getById(input: { teamId: ID; id: ID }): Promise<MemoryItemRecord | null>;
    listByScope(input: {
      teamId: ID;
      scopeType: MemoryScopeType;
      scopeRef: ID;
    }): Promise<MemoryItemRecord[]>;
    update(input: {
      record: MemoryItemRecord;
      expectedUpdatedAt: UnixMs;
    }): Promise<MemoryItemRecord | null>;
  };
  readonly sources: {
    create(record: MemorySourceRecord): Promise<MemorySourceRecord>;
    listByMemory(input: { teamId: ID; memoryId: ID }): Promise<MemorySourceRecord[]>;
    listBySource(input: {
      teamId: ID;
      sourceKind: MemorySourceKind;
      sourceId: ID;
    }): Promise<MemorySourceRecord[]>;
  };
  readonly tags: {
    create(record: MemoryTagRecord): Promise<MemoryTagRecord>;
    delete(input: { teamId: ID; memoryId: ID; tag: string }): Promise<boolean>;
    listByMemory(input: { teamId: ID; memoryId: ID }): Promise<MemoryTagRecord[]>;
  };
  readonly grants: {
    create(record: MemoryGrantRecord): Promise<MemoryGrantRecord>;
    getCurrent(input: { teamId: ID; id: ID }): Promise<MemoryGrantRecord | null>;
    listCurrentForTarget(input: { teamId: ID; targetAgentId: ID }): Promise<MemoryGrantRecord[]>;
    listVersions(input: { teamId: ID; id: ID }): Promise<MemoryGrantRecord[]>;
  };
  readonly auditEvents: {
    append(record: MemoryAuditEventRecord): Promise<MemoryAuditEventRecord>;
    listBySubject(input: {
      teamId: ID;
      subjectKind: MemoryAuditSubjectKind;
      subjectId: ID;
    }): Promise<MemoryAuditEventRecord[]>;
  };
  readonly capsuleRefs: {
    create(record: MemoryCapsuleRefRecord): Promise<MemoryCapsuleRefRecord>;
    getById(input: { teamId: ID; id: ID }): Promise<MemoryCapsuleRefRecord | null>;
    listByRun(input: { teamId: ID; managementRunId: ID }): Promise<MemoryCapsuleRefRecord[]>;
    markDenied(input: { teamId: ID; id: ID; deniedAt: UnixMs }): Promise<MemoryCapsuleRefRecord | null>;
  };
}

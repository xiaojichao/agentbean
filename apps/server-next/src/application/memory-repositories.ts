import type {
  ID,
  MemoryCandidateStatus,
  MemoryCapsuleAuthorizationDto,
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

/** Immutable, body-free reconstruction manifest for restart/recovery-time Capsule revalidation. */
export interface MemoryCapsuleItemManifestRecord {
  readonly capsuleId: ID;
  readonly teamId: ID;
  readonly requesterUserId: ID;
  readonly memoryId: ID;
  readonly position: number;
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: ID;
  readonly sourceVisibility: Exclude<MemorySourceVisibility, 'local-only'>;
  readonly contentKind: MemoryContentKind;
  readonly redactionLevel: MemoryRedactionLevel;
  readonly contentField: 'content' | 'summary';
  readonly authorization: MemoryCapsuleAuthorizationDto;
  readonly expiresAt?: UnixMs;
  readonly createdAt: UnixMs;
}

export interface MemoryCandidateRecord {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly sourceAgentId: ID;
  readonly sourceInvocationId: ID;
  readonly targetAgentId: ID;
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: ID;
  readonly contentKind: MemoryContentKind;
  readonly proposedContent: string;
  readonly proposedSummary?: string;
  readonly projectionHash: string;
  readonly status: MemoryCandidateStatus;
  readonly conflictMemoryIds: readonly ID[];
  readonly decidedAt?: UnixMs;
  readonly decidedBy?: ID;
  readonly acceptedMemoryId?: ID;
  readonly mergedIntoMemoryId?: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface MemoryCandidateSourceRecord {
  readonly candidateId: ID;
  readonly teamId: ID;
  readonly sourceKind: MemorySourceKind;
  readonly sourceId: ID;
  readonly snapshotHash: string;
  readonly sourceScopeType: MemoryScopeType;
  readonly sourceScopeRef: ID;
  readonly sourceVisibility: Exclude<MemorySourceVisibility, 'local-only'>;
  readonly createdAt: UnixMs;
}

export interface MemoryRepositories {
  readonly items: {
    create(record: MemoryItemRecord): Promise<MemoryItemRecord>;
    getById(input: { teamId: ID; id: ID }): Promise<MemoryItemRecord | null>;
    listByTeam(input: { teamId: ID }): Promise<MemoryItemRecord[]>;
    listByScope(input: {
      teamId: ID;
      scopeType: MemoryScopeType;
      scopeRef: ID;
    }): Promise<MemoryItemRecord[]>;
    update(input: {
      record: MemoryItemRecord;
      expectedUpdatedAt: UnixMs;
    }): Promise<MemoryItemRecord | null>;
    /** 列出某作用域下的 Formal Memory（formal_kind 非空，AC#1/7）。 */
    listFormal(input: {
      teamId: ID;
      scopeType: MemoryScopeType;
      scopeRef: ID;
    }): Promise<MemoryItemRecord[]>;
    /** 版本历史：同 version_family_id 的所有版本，按 created_at 升序（AC#4）。 */
    listByVersionFamily(input: { teamId: ID; versionFamilyId: ID }): Promise<MemoryItemRecord[]>;
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
    listCurrentByTeam(input: { teamId: ID }): Promise<MemoryGrantRecord[]>;
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
    listByTeam(input: { teamId: ID }): Promise<MemoryCapsuleRefRecord[]>;
    listByRun(input: { teamId: ID; managementRunId: ID }): Promise<MemoryCapsuleRefRecord[]>;
    markDenied(input: { teamId: ID; id: ID; deniedAt: UnixMs }): Promise<MemoryCapsuleRefRecord | null>;
  };
  readonly capsuleItems: {
    create(record: MemoryCapsuleItemManifestRecord): Promise<MemoryCapsuleItemManifestRecord>;
    listByCapsule(input: { teamId: ID; capsuleId: ID }): Promise<MemoryCapsuleItemManifestRecord[]>;
  };
  readonly candidates: {
    create(record: MemoryCandidateRecord): Promise<MemoryCandidateRecord>;
    getById(input: { teamId: ID; id: ID }): Promise<MemoryCandidateRecord | null>;
    listByTeam(input: { teamId: ID }): Promise<MemoryCandidateRecord[]>;
    findByProjectionHash(input: {
      teamId: ID;
      projectionHash: string;
    }): Promise<MemoryCandidateRecord | null>;
    update(input: {
      record: MemoryCandidateRecord;
      expectedUpdatedAt: UnixMs;
    }): Promise<MemoryCandidateRecord | null>;
  };
  readonly candidateSources: {
    create(record: MemoryCandidateSourceRecord): Promise<MemoryCandidateSourceRecord>;
    listByCandidate(input: { teamId: ID; candidateId: ID }): Promise<MemoryCandidateSourceRecord[]>;
    listBySource(input: {
      teamId: ID;
      sourceKind: MemorySourceKind;
      sourceId: ID;
    }): Promise<MemoryCandidateSourceRecord[]>;
  };
}

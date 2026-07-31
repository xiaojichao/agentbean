import type { ID, UnixMs } from '../../../../packages/contracts/src/common.js';
import type {
  LegacyDrainLineageState,
  PiAuthorityCutoverCommandName,
  PiAuthorityMigrationState,
} from '../../../../packages/contracts/src/pi-authority-cutover.js';

/**
 * #930 PI authority cutover 仓储接口。
 */

export interface TeamPiAuthorityMigrationRecord {
  readonly teamId: ID;
  readonly authorityEpoch: number;
  readonly migrationRevision: number;
  readonly state: PiAuthorityMigrationState;
  readonly legacyWriterFenced: boolean;
  readonly emergencyStop: boolean;
  readonly cutoverVersion: number | null;
  readonly cutoverAt: UnixMs | null;
  readonly cutoverBy: ID | null;
  readonly drainDeadlineAt: UnixMs | null;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface CutoverReadinessSnapshotRecord {
  readonly snapshotId: ID;
  readonly teamId: ID;
  readonly migrationRevision: number;
  readonly currentEpoch: number;
  readonly targetEpoch: number;
  readonly currentState: PiAuthorityMigrationState;
  readonly checksJson: string;
  readonly allPassed: boolean;
  readonly issuedAt: UnixMs;
  readonly expiresAt: UnixMs;
}

export interface CutoverReadinessTokenRecord {
  readonly tokenId: ID;
  readonly teamId: ID;
  readonly tokenHash: string;
  readonly targetEpoch: number;
  readonly migrationRevision: number;
  readonly readinessSnapshotId: ID;
  readonly issuedTo: ID;
  readonly issuedAt: UnixMs;
  readonly expiresAt: UnixMs;
  readonly consumedAt: UnixMs | null;
}

export interface MessageAuthorityEpochBindingRecord {
  readonly messageId: ID;
  readonly teamId: ID;
  readonly sourceLineageKey: string;
  readonly authorityEpoch: number;
  readonly migrationRevision: number;
  readonly boundAt: UnixMs;
  readonly clientMessageId: string | null;
}

export interface LegacyDrainLineageRecord {
  readonly drainId: ID;
  readonly teamId: ID;
  readonly lineageKey: string;
  readonly jobId: ID;
  readonly cutoverVersion: number;
  readonly fencingToken: number;
  readonly drainLeaseId: ID;
  readonly state: LegacyDrainLineageState;
  readonly deadlineAt: UnixMs;
  readonly resultMessageId: ID | null;
  readonly resultPayloadJson: string | null;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface LegacyCompatibilityProjectionRecord {
  readonly sourceId: ID;
  readonly teamId: ID;
  readonly projectionKind: 'coordination_job' | 'coordination_decision' | 'management_run_legacy';
  readonly payloadJson: string;
  readonly projectedAt: UnixMs;
}

export interface LegacyWriteAttemptAuditRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly writeKind: string;
  readonly correlationId: ID;
  readonly createdAt: UnixMs;
}

export interface PiAuthorityCutoverAuditRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly eventKind: string;
  readonly payloadJson: string;
  readonly createdAt: UnixMs;
}

export interface PiAuthorityCutoverOutboxRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly eventKind: string;
  readonly payloadJson: string;
  readonly createdAt: UnixMs;
  readonly publishedAt: UnixMs | null;
}

export interface PiAuthorityCutoverCommandReceiptRecord {
  readonly receiptId: ID;
  readonly commandName: PiAuthorityCutoverCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: 'applied' | 'no_op';
  readonly committedRevisions: readonly { streamKind: string; streamId: ID; revision: number }[];
  readonly eventRefs: readonly { streamKind: string; streamId: ID; sequence: number }[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
  readonly resultJson: string | null;
}

export interface PiAuthorityCutoverIdempotencyTombstoneRecord {
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly receiptId: ID;
  readonly createdAt: UnixMs;
}

export interface PiAuthorityRetirementCountersRecord {
  readonly teamId: ID;
  readonly legacyWriterCallCount: number;
  readonly legacyClientCallCount: number;
  readonly observationWindowStartedAt: UnixMs | null;
  readonly observationWindowEndsAt: UnixMs | null;
  readonly emergencyStopDrillPassed: boolean;
  readonly forwardRecoveryDrillPassed: boolean;
  readonly historicalProvenanceExportVerified: boolean;
  readonly replacementQueryPathReady: boolean;
  readonly updatedAt: UnixMs;
}

export interface TeamPiAuthorityMigrationRepository {
  get(teamId: ID): Promise<TeamPiAuthorityMigrationRecord | null>;
  upsert(record: TeamPiAuthorityMigrationRecord): Promise<TeamPiAuthorityMigrationRecord>;
}

export interface CutoverReadinessSnapshotRepository {
  create(record: CutoverReadinessSnapshotRecord): Promise<CutoverReadinessSnapshotRecord>;
  getById(snapshotId: ID): Promise<CutoverReadinessSnapshotRecord | null>;
}

export interface CutoverReadinessTokenRepository {
  create(record: CutoverReadinessTokenRecord): Promise<CutoverReadinessTokenRecord>;
  getById(tokenId: ID): Promise<CutoverReadinessTokenRecord | null>;
  getByHash(tokenHash: string): Promise<CutoverReadinessTokenRecord | null>;
  markConsumed(tokenId: ID, consumedAt: UnixMs): Promise<void>;
}

export interface MessageAuthorityEpochBindingRepository {
  create(record: MessageAuthorityEpochBindingRecord): Promise<MessageAuthorityEpochBindingRecord>;
  getByMessageId(messageId: ID): Promise<MessageAuthorityEpochBindingRecord | null>;
  getBySourceLineageKey(sourceLineageKey: string): Promise<MessageAuthorityEpochBindingRecord | null>;
  getByClientMessageId(clientMessageId: string): Promise<MessageAuthorityEpochBindingRecord | null>;
}

export interface LegacyDrainLineageRepository {
  create(record: LegacyDrainLineageRecord): Promise<LegacyDrainLineageRecord>;
  update(record: LegacyDrainLineageRecord): Promise<void>;
  getById(drainId: ID): Promise<LegacyDrainLineageRecord | null>;
  getByLineageKey(lineageKey: string): Promise<LegacyDrainLineageRecord | null>;
  listOpen(teamId: ID): Promise<readonly LegacyDrainLineageRecord[]>;
  countByState(teamId: ID, state: LegacyDrainLineageState): Promise<number>;
}

export interface LegacyCompatibilityProjectionRepository {
  upsert(record: LegacyCompatibilityProjectionRecord): Promise<LegacyCompatibilityProjectionRecord>;
  get(input: {
    sourceId: ID;
    projectionKind: LegacyCompatibilityProjectionRecord['projectionKind'];
  }): Promise<LegacyCompatibilityProjectionRecord | null>;
}

export interface LegacyWriteAttemptAuditRepository {
  create(record: LegacyWriteAttemptAuditRecord): Promise<LegacyWriteAttemptAuditRecord>;
  count(teamId: ID): Promise<number>;
}

export interface PiAuthorityCutoverAuditRepository {
  append(record: PiAuthorityCutoverAuditRecord): Promise<PiAuthorityCutoverAuditRecord>;
  list(teamId: ID, limit: number): Promise<readonly PiAuthorityCutoverAuditRecord[]>;
}

export interface PiAuthorityCutoverOutboxRepository {
  enqueue(record: PiAuthorityCutoverOutboxRecord): Promise<PiAuthorityCutoverOutboxRecord>;
  listPending(limit: number): Promise<readonly PiAuthorityCutoverOutboxRecord[]>;
  markPublished(id: ID, publishedAt: UnixMs): Promise<void>;
}

export interface PiAuthorityCutoverReceiptRepository {
  create(record: PiAuthorityCutoverCommandReceiptRecord): Promise<PiAuthorityCutoverCommandReceiptRecord>;
  getByIdempotencyKey(idempotencyKey: string): Promise<PiAuthorityCutoverCommandReceiptRecord | null>;
  createTombstone(record: PiAuthorityCutoverIdempotencyTombstoneRecord): Promise<void>;
  getTombstone(idempotencyKey: string): Promise<PiAuthorityCutoverIdempotencyTombstoneRecord | null>;
}

export interface PiAuthorityRetirementCountersRepository {
  get(teamId: ID): Promise<PiAuthorityRetirementCountersRecord | null>;
  upsert(record: PiAuthorityRetirementCountersRecord): Promise<PiAuthorityRetirementCountersRecord>;
}

export interface PiAuthorityCutoverRepositories {
  readonly migrations: TeamPiAuthorityMigrationRepository;
  readonly readinessSnapshots: CutoverReadinessSnapshotRepository;
  readonly readinessTokens: CutoverReadinessTokenRepository;
  readonly epochBindings: MessageAuthorityEpochBindingRepository;
  readonly drainLineages: LegacyDrainLineageRepository;
  readonly compatibilityProjections: LegacyCompatibilityProjectionRepository;
  readonly legacyWriteAudits: LegacyWriteAttemptAuditRepository;
  readonly audits: PiAuthorityCutoverAuditRepository;
  readonly outbox: PiAuthorityCutoverOutboxRepository;
  readonly receipts: PiAuthorityCutoverReceiptRepository;
  readonly retirementCounters: PiAuthorityRetirementCountersRepository;
}

import type {
  CutoverReadinessSnapshotRecord,
  CutoverReadinessTokenRecord,
  LegacyCompatibilityProjectionRecord,
  LegacyDrainLineageRecord,
  LegacyWriteAttemptAuditRecord,
  MessageAuthorityEpochBindingRecord,
  PiAuthorityCutoverAuditRecord,
  PiAuthorityCutoverCommandReceiptRecord,
  PiAuthorityCutoverIdempotencyTombstoneRecord,
  PiAuthorityCutoverOutboxRecord,
  PiAuthorityCutoverRepositories,
  PiAuthorityRetirementCountersRecord,
  TeamPiAuthorityMigrationRecord,
} from '../../application/pi-authority-cutover-repositories.js';
import type { LegacyDrainLineageState } from '../../../../../packages/contracts/src/pi-authority-cutover.js';

export interface PiAuthorityCutoverMemoryState {
  migrations: Map<string, TeamPiAuthorityMigrationRecord>;
  readinessSnapshots: Map<string, CutoverReadinessSnapshotRecord>;
  readinessTokens: Map<string, CutoverReadinessTokenRecord>;
  epochBindings: Map<string, MessageAuthorityEpochBindingRecord>;
  epochBindingsByLineage: Map<string, string>;
  epochBindingsByClientMessageId: Map<string, string>;
  drainLineages: Map<string, LegacyDrainLineageRecord>;
  drainByLineage: Map<string, string>;
  compatibilityProjections: Map<string, LegacyCompatibilityProjectionRecord>;
  legacyWriteAudits: LegacyWriteAttemptAuditRecord[];
  audits: PiAuthorityCutoverAuditRecord[];
  outbox: Map<string, PiAuthorityCutoverOutboxRecord>;
  receipts: Map<string, PiAuthorityCutoverCommandReceiptRecord>;
  tombstones: Map<string, PiAuthorityCutoverIdempotencyTombstoneRecord>;
  retirementCounters: Map<string, PiAuthorityRetirementCountersRecord>;
}

export function createPiAuthorityCutoverMemoryState(): PiAuthorityCutoverMemoryState {
  return {
    migrations: new Map(),
    readinessSnapshots: new Map(),
    readinessTokens: new Map(),
    epochBindings: new Map(),
    epochBindingsByLineage: new Map(),
    epochBindingsByClientMessageId: new Map(),
    drainLineages: new Map(),
    drainByLineage: new Map(),
    compatibilityProjections: new Map(),
    legacyWriteAudits: [],
    audits: [],
    outbox: new Map(),
    receipts: new Map(),
    tombstones: new Map(),
    retirementCounters: new Map(),
  };
}

export function clonePiAuthorityCutoverMemoryState(
  state: PiAuthorityCutoverMemoryState,
): PiAuthorityCutoverMemoryState {
  return {
    migrations: new Map(state.migrations),
    readinessSnapshots: new Map(state.readinessSnapshots),
    readinessTokens: new Map(state.readinessTokens),
    epochBindings: new Map(state.epochBindings),
    epochBindingsByLineage: new Map(state.epochBindingsByLineage),
    epochBindingsByClientMessageId: new Map(state.epochBindingsByClientMessageId),
    drainLineages: new Map(state.drainLineages),
    drainByLineage: new Map(state.drainByLineage),
    compatibilityProjections: new Map(state.compatibilityProjections),
    legacyWriteAudits: [...state.legacyWriteAudits],
    audits: [...state.audits],
    outbox: new Map(state.outbox),
    receipts: new Map(state.receipts),
    tombstones: new Map(state.tombstones),
    retirementCounters: new Map(state.retirementCounters),
  };
}

export function restorePiAuthorityCutoverMemoryState(
  target: PiAuthorityCutoverMemoryState,
  source: PiAuthorityCutoverMemoryState,
): void {
  target.migrations = new Map(source.migrations);
  target.readinessSnapshots = new Map(source.readinessSnapshots);
  target.readinessTokens = new Map(source.readinessTokens);
  target.epochBindings = new Map(source.epochBindings);
  target.epochBindingsByLineage = new Map(source.epochBindingsByLineage);
  target.epochBindingsByClientMessageId = new Map(source.epochBindingsByClientMessageId);
  target.drainLineages = new Map(source.drainLineages);
  target.drainByLineage = new Map(source.drainByLineage);
  target.compatibilityProjections = new Map(source.compatibilityProjections);
  target.legacyWriteAudits = [...source.legacyWriteAudits];
  target.audits = [...source.audits];
  target.outbox = new Map(source.outbox);
  target.receipts = new Map(source.receipts);
  target.tombstones = new Map(source.tombstones);
  target.retirementCounters = new Map(source.retirementCounters);
}

function projectionKey(
  sourceId: string,
  kind: LegacyCompatibilityProjectionRecord['projectionKind'],
): string {
  return `${kind}|${sourceId}`;
}

export function createInMemoryPiAuthorityCutoverRepositories(
  state: PiAuthorityCutoverMemoryState = createPiAuthorityCutoverMemoryState(),
): PiAuthorityCutoverRepositories {
  return {
    migrations: {
      async get(teamId) {
        return state.migrations.get(teamId) ?? null;
      },
      async upsert(record) {
        state.migrations.set(record.teamId, record);
        return record;
      },
    },
    readinessSnapshots: {
      async create(record) {
        state.readinessSnapshots.set(record.snapshotId, record);
        return record;
      },
      async getById(snapshotId) {
        return state.readinessSnapshots.get(snapshotId) ?? null;
      },
    },
    readinessTokens: {
      async create(record) {
        state.readinessTokens.set(record.tokenId, record);
        return record;
      },
      async getById(tokenId) {
        return state.readinessTokens.get(tokenId) ?? null;
      },
      async getByHash(tokenHash) {
        for (const row of state.readinessTokens.values()) {
          if (row.tokenHash === tokenHash) return row;
        }
        return null;
      },
      async markConsumed(tokenId, consumedAt) {
        const row = state.readinessTokens.get(tokenId);
        if (!row) return;
        state.readinessTokens.set(tokenId, { ...row, consumedAt });
      },
    },
    epochBindings: {
      async create(record) {
        state.epochBindings.set(record.messageId, record);
        state.epochBindingsByLineage.set(record.sourceLineageKey, record.messageId);
        if (record.clientMessageId) {
          state.epochBindingsByClientMessageId.set(record.clientMessageId, record.messageId);
        }
        return record;
      },
      async getByMessageId(messageId) {
        return state.epochBindings.get(messageId) ?? null;
      },
      async getBySourceLineageKey(sourceLineageKey) {
        const messageId = state.epochBindingsByLineage.get(sourceLineageKey);
        return messageId ? state.epochBindings.get(messageId) ?? null : null;
      },
      async getByClientMessageId(clientMessageId) {
        const messageId = state.epochBindingsByClientMessageId.get(clientMessageId);
        return messageId ? state.epochBindings.get(messageId) ?? null : null;
      },
    },
    drainLineages: {
      async create(record) {
        state.drainLineages.set(record.drainId, record);
        state.drainByLineage.set(record.lineageKey, record.drainId);
        return record;
      },
      async update(record) {
        state.drainLineages.set(record.drainId, record);
        state.drainByLineage.set(record.lineageKey, record.drainId);
      },
      async getById(drainId) {
        return state.drainLineages.get(drainId) ?? null;
      },
      async getByLineageKey(lineageKey) {
        const id = state.drainByLineage.get(lineageKey);
        return id ? state.drainLineages.get(id) ?? null : null;
      },
      async listOpen(teamId) {
        return [...state.drainLineages.values()].filter(
          (row) => row.teamId === teamId && (row.state === 'draining' || row.state === 'recovery_pending'),
        );
      },
      async countByState(teamId, drainState: LegacyDrainLineageState) {
        return [...state.drainLineages.values()].filter(
          (row) => row.teamId === teamId && row.state === drainState,
        ).length;
      },
    },
    compatibilityProjections: {
      async upsert(record) {
        state.compatibilityProjections.set(projectionKey(record.sourceId, record.projectionKind), record);
        return record;
      },
      async get({ sourceId, projectionKind }) {
        return state.compatibilityProjections.get(projectionKey(sourceId, projectionKind)) ?? null;
      },
    },
    legacyWriteAudits: {
      async create(record) {
        state.legacyWriteAudits.push(record);
        return record;
      },
      async count(teamId) {
        return state.legacyWriteAudits.filter((row) => row.teamId === teamId).length;
      },
    },
    audits: {
      async append(record) {
        state.audits.push(record);
        return record;
      },
      async list(teamId, limit) {
        return state.audits.filter((row) => row.teamId === teamId).slice(-limit);
      },
    },
    outbox: {
      async enqueue(record) {
        state.outbox.set(record.id, record);
        return record;
      },
      async listPending(limit) {
        return [...state.outbox.values()]
          .filter((row) => row.publishedAt === null)
          .slice(0, limit);
      },
      async markPublished(id, publishedAt) {
        const row = state.outbox.get(id);
        if (!row) return;
        state.outbox.set(id, { ...row, publishedAt });
      },
    },
    receipts: {
      async create(record) {
        state.receipts.set(record.idempotencyKey, record);
        return record;
      },
      async getByIdempotencyKey(idempotencyKey) {
        return state.receipts.get(idempotencyKey) ?? null;
      },
      async createTombstone(record) {
        state.tombstones.set(record.idempotencyKey, record);
      },
      async getTombstone(idempotencyKey) {
        return state.tombstones.get(idempotencyKey) ?? null;
      },
    },
    retirementCounters: {
      async get(teamId) {
        return state.retirementCounters.get(teamId) ?? null;
      },
      async upsert(record) {
        state.retirementCounters.set(record.teamId, record);
        return record;
      },
    },
  };
}

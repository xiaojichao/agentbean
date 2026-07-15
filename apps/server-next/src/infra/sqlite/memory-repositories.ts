import type {
  MemoryAuditEventRecord,
  MemoryGrantRecord,
  MemoryItemRecord,
  MemoryRepositories,
  MemorySourceRecord,
  MemoryTagRecord,
} from '../../application/memory-repositories.js';
import {
  assertMemoryAuditEventRecord,
  assertMemoryGrantRecord,
  assertMemoryGrantTransition,
  assertMemoryItemRecord,
  assertMemoryItemUpdate,
  assertMemorySourceRecord,
  assertMemoryTag,
} from '../../application/memory-repository-validation.js';
import type { MemorySourceRefDto } from '../../../../../packages/contracts/src/index.js';
import type { SqliteDatabase } from './repositories.js';

export function createSqliteMemoryRepositories(db: SqliteDatabase): MemoryRepositories {
  return {
    items: {
      async create(record) {
        assertMemoryItemRecord(record);
        db.prepare(`INSERT INTO memory_items
          (id, team_id, kind, status, scope_type, scope_ref, content, summary, confidence,
           created_by_user_id, created_by_agent_id, approved_by_user_id, valid_from, valid_until,
           superseded_by_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.kind, record.status, record.scopeType, record.scopeRef,
            record.content, record.summary ?? null, record.confidence ?? null,
            record.createdByUserId ?? null, record.createdByAgentId ?? null,
            record.approvedByUserId ?? null, record.validFrom ?? null, record.validUntil ?? null,
            record.supersededById ?? null, record.createdAt, record.updatedAt);
        return record;
      },
      async getById(input) {
        return mapItem(db.prepare('SELECT * FROM memory_items WHERE team_id = ? AND id = ?')
          .get(input.teamId, input.id));
      },
      async listByScope(input) {
        return db.prepare(`SELECT * FROM memory_items
          WHERE team_id = ? AND scope_type = ? AND scope_ref = ?
          ORDER BY updated_at DESC, id`)
          .all(input.teamId, input.scopeType, input.scopeRef).map(mapItemRequired);
      },
      async update(input) {
        assertMemoryItemRecord(input.record);
        const record = input.record;
        const current = mapItem(db.prepare('SELECT * FROM memory_items WHERE team_id = ? AND id = ?')
          .get(record.teamId, record.id));
        if (!current || current.updatedAt !== input.expectedUpdatedAt) return null;
        assertMemoryItemUpdate(current, record);
        const result = db.prepare(`UPDATE memory_items SET
          kind = ?, status = ?, scope_type = ?, scope_ref = ?, content = ?, summary = ?,
          confidence = ?, created_by_user_id = ?, created_by_agent_id = ?, approved_by_user_id = ?,
          valid_from = ?, valid_until = ?, superseded_by_id = ?, created_at = ?, updated_at = ?
          WHERE id = ? AND team_id = ? AND updated_at = ?`)
          .run(record.kind, record.status, record.scopeType, record.scopeRef, record.content,
            record.summary ?? null, record.confidence ?? null, record.createdByUserId ?? null,
            record.createdByAgentId ?? null, record.approvedByUserId ?? null,
            record.validFrom ?? null, record.validUntil ?? null, record.supersededById ?? null,
            record.createdAt, record.updatedAt, record.id, record.teamId, input.expectedUpdatedAt);
        return changes(result) === 0 ? null : record;
      },
    },
    sources: {
      async create(record) {
        assertMemorySourceRecord(record);
        db.prepare(`INSERT INTO memory_sources
          (memory_id, team_id, source_kind, source_id, snapshot_hash, source_scope_type,
           source_scope_ref, source_visibility, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.memoryId, record.teamId, record.sourceKind, record.sourceId,
            record.snapshotHash, record.sourceScopeType, record.sourceScopeRef,
            record.sourceVisibility, record.createdAt);
        return record;
      },
      async listByMemory(input) {
        return db.prepare(`SELECT * FROM memory_sources WHERE team_id = ? AND memory_id = ?
          ORDER BY created_at, source_kind, source_id`)
          .all(input.teamId, input.memoryId).map(mapSourceRequired);
      },
      async listBySource(input) {
        return db.prepare(`SELECT * FROM memory_sources
          WHERE team_id = ? AND source_kind = ? AND source_id = ?
          ORDER BY created_at, memory_id`)
          .all(input.teamId, input.sourceKind, input.sourceId).map(mapSourceRequired);
      },
    },
    tags: {
      async create(record) {
        assertMemoryTag(record.tag);
        db.prepare(`INSERT INTO memory_tags (memory_id, team_id, tag, created_at)
          VALUES (?, ?, ?, ?)`)
          .run(record.memoryId, record.teamId, record.tag, record.createdAt);
        return record;
      },
      async delete(input) {
        return changes(db.prepare(`DELETE FROM memory_tags
          WHERE team_id = ? AND memory_id = ? AND tag = ?`)
          .run(input.teamId, input.memoryId, input.tag)) > 0;
      },
      async listByMemory(input) {
        return db.prepare(`SELECT * FROM memory_tags WHERE team_id = ? AND memory_id = ? ORDER BY tag`)
          .all(input.teamId, input.memoryId).map(mapTagRequired);
      },
    },
    grants: {
      async create(record) {
        assertMemoryGrantRecord(record);
        const current = mapGrant(db.prepare(`SELECT * FROM memory_grants
          WHERE team_id = ? AND id = ? ORDER BY version DESC LIMIT 1`)
          .get(record.teamId, record.id));
        assertMemoryGrantTransition(current, record);
        db.prepare(`INSERT INTO memory_grants
          (id, version, team_id, source_scope_type, source_scope_ref, target_agent_id,
           authorized_content_kind, authorized_redaction_level, status, issued_by_user_id,
           issued_at, expires_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.version, record.teamId, record.sourceScopeType,
            record.sourceScopeRef, record.targetAgentId, record.authorizedContentKind,
            record.authorizedRedactionLevel, record.status, record.issuedByUserId,
            record.issuedAt, record.expiresAt, record.revokedAt ?? null);
        return record;
      },
      async getCurrent(input) {
        return mapGrant(db.prepare(`SELECT * FROM memory_grants
          WHERE team_id = ? AND id = ? ORDER BY version DESC LIMIT 1`)
          .get(input.teamId, input.id));
      },
      async listCurrentForTarget(input) {
        return db.prepare(`SELECT grant_row.* FROM memory_grants AS grant_row
          INNER JOIN (
            SELECT id, MAX(version) AS version
            FROM memory_grants
            WHERE team_id = ? AND target_agent_id = ?
            GROUP BY id
          ) AS current
            ON current.id = grant_row.id AND current.version = grant_row.version
          WHERE grant_row.team_id = ? AND grant_row.target_agent_id = ?
          ORDER BY grant_row.source_scope_type, grant_row.source_scope_ref, grant_row.id`)
          .all(input.teamId, input.targetAgentId, input.teamId, input.targetAgentId)
          .map(mapGrantRequired);
      },
      async listVersions(input) {
        return db.prepare(`SELECT * FROM memory_grants
          WHERE team_id = ? AND id = ? ORDER BY version`)
          .all(input.teamId, input.id).map(mapGrantRequired);
      },
    },
    auditEvents: {
      async append(record) {
        assertMemoryAuditEventRecord(record);
        db.prepare(`INSERT INTO memory_audit_events
          (id, team_id, subject_kind, subject_id, event_type, actor_kind, actor_id,
           decision_id, target_agent_id, scope_type, scope_ref, source_refs_json,
           source_refs_hash, content_hash, redaction_level, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.subjectKind, record.subjectId, record.eventType,
            record.actorKind, record.actorId ?? null, record.decisionId ?? null,
            record.targetAgentId ?? null, record.scopeType ?? null, record.scopeRef ?? null,
            JSON.stringify(record.sourceRefs), record.sourceRefsHash ?? null,
            record.contentHash ?? null, record.redactionLevel ?? null, record.createdAt);
        return record;
      },
      async listBySubject(input) {
        return db.prepare(`SELECT * FROM memory_audit_events
          WHERE team_id = ? AND subject_kind = ? AND subject_id = ?
          ORDER BY created_at, id`)
          .all(input.teamId, input.subjectKind, input.subjectId).map(mapAuditRequired);
      },
    },
  };
}

function mapItem(value: unknown): MemoryItemRecord | null {
  if (!value) return null;
  return {
    schemaVersion: 1,
    id: text(value, 'id'),
    teamId: text(value, 'team_id'),
    kind: text(value, 'kind') as MemoryItemRecord['kind'],
    status: text(value, 'status') as MemoryItemRecord['status'],
    scopeType: text(value, 'scope_type') as MemoryItemRecord['scopeType'],
    scopeRef: text(value, 'scope_ref'),
    content: text(value, 'content'),
    summary: optionalText(value, 'summary'),
    confidence: optionalNumber(value, 'confidence'),
    createdByUserId: optionalText(value, 'created_by_user_id'),
    createdByAgentId: optionalText(value, 'created_by_agent_id'),
    approvedByUserId: optionalText(value, 'approved_by_user_id'),
    validFrom: optionalNumber(value, 'valid_from'),
    validUntil: optionalNumber(value, 'valid_until'),
    supersededById: optionalText(value, 'superseded_by_id'),
    createdAt: number(value, 'created_at'),
    updatedAt: number(value, 'updated_at'),
  };
}

function mapSource(value: unknown): MemorySourceRecord | null {
  if (!value) return null;
  return {
    memoryId: text(value, 'memory_id'),
    teamId: text(value, 'team_id'),
    sourceKind: text(value, 'source_kind') as MemorySourceRecord['sourceKind'],
    sourceId: text(value, 'source_id'),
    snapshotHash: text(value, 'snapshot_hash'),
    sourceScopeType: text(value, 'source_scope_type') as MemorySourceRecord['sourceScopeType'],
    sourceScopeRef: text(value, 'source_scope_ref'),
    sourceVisibility: text(value, 'source_visibility') as MemorySourceRecord['sourceVisibility'],
    createdAt: number(value, 'created_at'),
  };
}

function mapTag(value: unknown): MemoryTagRecord | null {
  if (!value) return null;
  return {
    memoryId: text(value, 'memory_id'),
    teamId: text(value, 'team_id'),
    tag: text(value, 'tag'),
    createdAt: number(value, 'created_at'),
  };
}

function mapGrant(value: unknown): MemoryGrantRecord | null {
  if (!value) return null;
  return {
    id: text(value, 'id'),
    version: number(value, 'version'),
    teamId: text(value, 'team_id'),
    sourceScopeType: text(value, 'source_scope_type') as MemoryGrantRecord['sourceScopeType'],
    sourceScopeRef: text(value, 'source_scope_ref'),
    targetAgentId: text(value, 'target_agent_id'),
    authorizedContentKind: text(value, 'authorized_content_kind') as MemoryGrantRecord['authorizedContentKind'],
    authorizedRedactionLevel: text(value, 'authorized_redaction_level') as MemoryGrantRecord['authorizedRedactionLevel'],
    status: text(value, 'status') as MemoryGrantRecord['status'],
    issuedByUserId: text(value, 'issued_by_user_id'),
    issuedAt: number(value, 'issued_at'),
    expiresAt: number(value, 'expires_at'),
    revokedAt: optionalNumber(value, 'revoked_at'),
  };
}

function mapAudit(value: unknown): MemoryAuditEventRecord | null {
  if (!value) return null;
  const record: MemoryAuditEventRecord = {
    id: text(value, 'id'),
    teamId: text(value, 'team_id'),
    subjectKind: text(value, 'subject_kind') as MemoryAuditEventRecord['subjectKind'],
    subjectId: text(value, 'subject_id'),
    eventType: text(value, 'event_type') as MemoryAuditEventRecord['eventType'],
    actorKind: text(value, 'actor_kind') as MemoryAuditEventRecord['actorKind'],
    actorId: optionalText(value, 'actor_id'),
    decisionId: optionalText(value, 'decision_id'),
    targetAgentId: optionalText(value, 'target_agent_id'),
    scopeType: optionalText(value, 'scope_type') as MemoryAuditEventRecord['scopeType'],
    scopeRef: optionalText(value, 'scope_ref'),
    sourceRefs: parseSourceRefs(text(value, 'source_refs_json')),
    sourceRefsHash: optionalText(value, 'source_refs_hash'),
    contentHash: optionalText(value, 'content_hash'),
    redactionLevel: optionalText(value, 'redaction_level') as MemoryAuditEventRecord['redactionLevel'],
    createdAt: number(value, 'created_at'),
  };
  assertMemoryAuditEventRecord(record);
  return record;
}

function mapItemRequired(value: unknown): MemoryItemRecord {
  const record = mapItem(value);
  if (!record) throw new Error('SQLite memory item row could not be mapped');
  return record;
}

function mapSourceRequired(value: unknown): MemorySourceRecord {
  const record = mapSource(value);
  if (!record) throw new Error('SQLite memory source row could not be mapped');
  return record;
}

function mapTagRequired(value: unknown): MemoryTagRecord {
  const record = mapTag(value);
  if (!record) throw new Error('SQLite memory tag row could not be mapped');
  return record;
}

function mapGrantRequired(value: unknown): MemoryGrantRecord {
  const record = mapGrant(value);
  if (!record) throw new Error('SQLite memory grant row could not be mapped');
  return record;
}

function mapAuditRequired(value: unknown): MemoryAuditEventRecord {
  const record = mapAudit(value);
  if (!record) throw new Error('SQLite memory audit row could not be mapped');
  return record;
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('SQLite memory row is missing');
  return value as Record<string, unknown>;
}

function text(value: unknown, key: string): string {
  const result = row(value)[key];
  if (typeof result !== 'string') throw new Error(`Invalid memory ${key}`);
  return result;
}

function optionalText(value: unknown, key: string): string | undefined {
  const result = row(value)[key];
  if (result === null || result === undefined) return undefined;
  if (typeof result !== 'string') throw new Error(`Invalid memory ${key}`);
  return result;
}

function number(value: unknown, key: string): number {
  const result = row(value)[key];
  if (typeof result !== 'number') throw new Error(`Invalid memory ${key}`);
  return result;
}

function optionalNumber(value: unknown, key: string): number | undefined {
  const result = row(value)[key];
  if (result === null || result === undefined) return undefined;
  if (typeof result !== 'number') throw new Error(`Invalid memory ${key}`);
  return result;
}

function changes(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const result = (value as { changes?: unknown }).changes;
  return typeof result === 'number' ? result : 0;
}

function parseSourceRefs(value: string): readonly MemorySourceRefDto[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Invalid memory source refs JSON');
  return parsed.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid memory source ref');
    const candidate = item as Record<string, unknown>;
    if (candidate.schemaVersion !== 1 || typeof candidate.sourceKind !== 'string'
      || typeof candidate.sourceId !== 'string' || typeof candidate.snapshotHash !== 'string') {
      throw new Error('Invalid memory source ref');
    }
    return candidate as unknown as MemorySourceRefDto;
  });
}

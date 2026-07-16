import type {
  MemoryAuditEventRecord,
  MemoryCandidateRecord,
  MemoryCandidateSourceRecord,
  MemoryCapsuleRefRecord,
  MemoryCapsuleItemManifestRecord,
  MemoryGrantRecord,
  MemoryItemRecord,
  MemoryRepositories,
  MemorySourceRecord,
  MemoryTagRecord,
} from '../../application/memory-repositories.js';
import {
  assertMemoryAuditEventRecord,
  assertMemoryCapsuleRefDenial,
  assertMemoryCapsuleRefRecord,
  assertMemoryCapsuleItemManifestRecord,
  assertMemoryCandidateRecord,
  assertMemoryCandidateSourceRecord,
  assertMemoryCandidateUpdate,
  assertMemoryGrantRecord,
  assertMemoryGrantTransition,
  assertMemoryItemRecord,
  assertMemoryItemUpdate,
  assertMemorySourceRecord,
  assertMemoryTag,
} from '../../application/memory-repository-validation.js';
import type { MemoryCapsuleAuthorizationDto, MemorySourceRefDto } from '../../../../../packages/contracts/src/index.js';
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
      async listByTeam(input) {
        return db.prepare(`SELECT * FROM memory_items
          WHERE team_id = ? ORDER BY updated_at DESC, id`)
          .all(input.teamId).map(mapItemRequired);
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
      async listCurrentByTeam(input) {
        return db.prepare(`SELECT grant_row.* FROM memory_grants AS grant_row
          INNER JOIN (
            SELECT id, MAX(version) AS version
            FROM memory_grants WHERE team_id = ? GROUP BY id
          ) AS current ON current.id = grant_row.id AND current.version = grant_row.version
          WHERE grant_row.team_id = ?
          ORDER BY grant_row.source_scope_type, grant_row.source_scope_ref, grant_row.id`)
          .all(input.teamId, input.teamId).map(mapGrantRequired);
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
    capsuleRefs: {
      async create(record) {
        assertMemoryCapsuleRefRecord(record);
        const existing = db.prepare(`SELECT id FROM memory_capsule_refs
          WHERE team_id = ? AND id = ?`).get(record.teamId, record.id);
        if (existing) throw new Error('memory capsule ref already exists');
        db.prepare(`INSERT INTO memory_capsule_refs
          (id, team_id, management_run_id, task_id, target_agent_id, content_hash,
           authorization_decision_id, issued_at, expires_at, denied_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.managementRunId, record.taskId ?? null,
            record.targetAgentId, record.contentHash, record.authorizationDecisionId,
            record.issuedAt, record.expiresAt, record.deniedAt ?? null, record.createdAt);
        return record;
      },
      async getById(input) {
        return mapCapsuleRef(db.prepare(`SELECT * FROM memory_capsule_refs
          WHERE team_id = ? AND id = ?`).get(input.teamId, input.id));
      },
      async listByTeam(input) {
        return db.prepare(`SELECT * FROM memory_capsule_refs
          WHERE team_id = ? ORDER BY created_at DESC, id`)
          .all(input.teamId).map(mapCapsuleRefRequired);
      },
      async listByRun(input) {
        return db.prepare(`SELECT * FROM memory_capsule_refs
          WHERE team_id = ? AND management_run_id = ? ORDER BY id`)
          .all(input.teamId, input.managementRunId).map(mapCapsuleRefRequired);
      },
      async markDenied(input) {
        const current = mapCapsuleRef(db.prepare(`SELECT * FROM memory_capsule_refs
          WHERE team_id = ? AND id = ?`).get(input.teamId, input.id));
        if (!current) return null;
        assertMemoryCapsuleRefDenial(current, input.deniedAt);
        db.prepare(`UPDATE memory_capsule_refs SET denied_at = ? WHERE team_id = ? AND id = ?`)
          .run(input.deniedAt, input.teamId, input.id);
        return { ...current, deniedAt: input.deniedAt };
      },
    },
    capsuleItems: {
      async create(record) {
        assertMemoryCapsuleItemManifestRecord(record);
        db.prepare(`INSERT INTO memory_capsule_item_manifests
          (capsule_id, team_id, requester_user_id, memory_id, position, scope_type, scope_ref,
           source_visibility, content_kind, redaction_level, content_field, authorization_json,
           expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          record.capsuleId, record.teamId, record.requesterUserId, record.memoryId, record.position,
          record.scopeType, record.scopeRef, record.sourceVisibility, record.contentKind,
          record.redactionLevel, record.contentField, JSON.stringify(record.authorization),
          record.expiresAt ?? null, record.createdAt,
        );
        return record;
      },
      async listByCapsule(input) {
        return db.prepare(`SELECT * FROM memory_capsule_item_manifests
          WHERE team_id = ? AND capsule_id = ? ORDER BY position, memory_id`)
          .all(input.teamId, input.capsuleId).map(mapCapsuleItemManifestRequired);
      },
    },
    candidates: {
      async create(record) {
        assertMemoryCandidateRecord(record);
        db.prepare(`INSERT INTO memory_candidates
          (id, team_id, management_run_id, task_id, source_agent_id, source_invocation_id, target_agent_id,
           scope_type, scope_ref, content_kind, proposed_content, proposed_summary, projection_hash, status,
           conflict_memory_ids_json, decided_at, decided_by, accepted_memory_id, merged_into_memory_id,
           created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.managementRunId, record.taskId ?? null,
            record.sourceAgentId, record.sourceInvocationId, record.targetAgentId,
            record.scopeType, record.scopeRef,
            record.contentKind, record.proposedContent, record.proposedSummary ?? null,
            record.projectionHash, record.status,
            JSON.stringify(record.conflictMemoryIds), record.decidedAt ?? null, record.decidedBy ?? null,
            record.acceptedMemoryId ?? null, record.mergedIntoMemoryId ?? null,
            record.createdAt, record.updatedAt);
        return record;
      },
      async getById(input) {
        return mapCandidate(db.prepare('SELECT * FROM memory_candidates WHERE team_id = ? AND id = ?')
          .get(input.teamId, input.id));
      },
      async listByTeam(input) {
        return db.prepare(`SELECT * FROM memory_candidates
          WHERE team_id = ? ORDER BY updated_at DESC, id`)
          .all(input.teamId).map(mapCandidateRequired);
      },
      async findByProjectionHash(input) {
        return mapCandidate(db.prepare(`SELECT * FROM memory_candidates
          WHERE team_id = ? AND projection_hash = ? AND status IN ('candidate', 'conflict')
          ORDER BY updated_at DESC, id LIMIT 1`)
          .get(input.teamId, input.projectionHash));
      },
      async update(input) {
        assertMemoryCandidateRecord(input.record);
        const record = input.record;
        const current = mapCandidate(db.prepare('SELECT * FROM memory_candidates WHERE team_id = ? AND id = ?')
          .get(record.teamId, record.id));
        if (!current || current.updatedAt !== input.expectedUpdatedAt) return null;
        assertMemoryCandidateUpdate(current, record);
        const result = db.prepare(`UPDATE memory_candidates SET
          status = ?, conflict_memory_ids_json = ?, decided_at = ?, decided_by = ?,
          accepted_memory_id = ?, merged_into_memory_id = ?, updated_at = ?
          WHERE id = ? AND team_id = ? AND updated_at = ?`)
          .run(record.status, JSON.stringify(record.conflictMemoryIds), record.decidedAt ?? null,
            record.decidedBy ?? null, record.acceptedMemoryId ?? null, record.mergedIntoMemoryId ?? null,
            record.updatedAt, record.id, record.teamId, input.expectedUpdatedAt);
        return changes(result) === 0 ? null : record;
      },
    },
    candidateSources: {
      async create(record) {
        assertMemoryCandidateSourceRecord(record);
        db.prepare(`INSERT INTO memory_candidate_sources
          (memory_candidate_id, team_id, source_kind, source_id, snapshot_hash,
           source_scope_type, source_scope_ref, source_visibility, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.candidateId, record.teamId, record.sourceKind, record.sourceId,
            record.snapshotHash, record.sourceScopeType, record.sourceScopeRef,
            record.sourceVisibility, record.createdAt);
        return record;
      },
      async listByCandidate(input) {
        return db.prepare(`SELECT * FROM memory_candidate_sources
          WHERE team_id = ? AND memory_candidate_id = ?
          ORDER BY created_at, source_kind, source_id`)
          .all(input.teamId, input.candidateId).map(mapCandidateSourceRequired);
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

function mapCapsuleRef(value: unknown): MemoryCapsuleRefRecord | null {
  if (!value) return null;
  const record: MemoryCapsuleRefRecord = {
    id: text(value, 'id'),
    teamId: text(value, 'team_id'),
    managementRunId: text(value, 'management_run_id'),
    taskId: optionalText(value, 'task_id'),
    targetAgentId: text(value, 'target_agent_id'),
    contentHash: text(value, 'content_hash'),
    authorizationDecisionId: text(value, 'authorization_decision_id'),
    issuedAt: number(value, 'issued_at'),
    expiresAt: number(value, 'expires_at'),
    deniedAt: optionalNumber(value, 'denied_at'),
    createdAt: number(value, 'created_at'),
  };
  assertMemoryCapsuleRefRecord(record);
  return record;
}

function mapCapsuleItemManifest(value: unknown): MemoryCapsuleItemManifestRecord | null {
  if (!value) return null;
  const authorization = JSON.parse(text(value, 'authorization_json')) as MemoryCapsuleAuthorizationDto;
  const record: MemoryCapsuleItemManifestRecord = {
    capsuleId: text(value, 'capsule_id'),
    teamId: text(value, 'team_id'),
    requesterUserId: text(value, 'requester_user_id'),
    memoryId: text(value, 'memory_id'),
    position: number(value, 'position'),
    scopeType: text(value, 'scope_type') as MemoryCapsuleItemManifestRecord['scopeType'],
    scopeRef: text(value, 'scope_ref'),
    sourceVisibility: text(value, 'source_visibility') as MemoryCapsuleItemManifestRecord['sourceVisibility'],
    contentKind: text(value, 'content_kind') as MemoryCapsuleItemManifestRecord['contentKind'],
    redactionLevel: text(value, 'redaction_level') as MemoryCapsuleItemManifestRecord['redactionLevel'],
    contentField: text(value, 'content_field') as MemoryCapsuleItemManifestRecord['contentField'],
    authorization,
    expiresAt: optionalNumber(value, 'expires_at'),
    createdAt: number(value, 'created_at'),
  };
  assertMemoryCapsuleItemManifestRecord(record);
  return record;
}

function mapCandidate(value: unknown): MemoryCandidateRecord | null {
  if (!value) return null;
  return {
    schemaVersion: 1,
    id: text(value, 'id'),
    teamId: text(value, 'team_id'),
    managementRunId: text(value, 'management_run_id'),
    taskId: optionalText(value, 'task_id'),
    sourceAgentId: text(value, 'source_agent_id'),
    sourceInvocationId: text(value, 'source_invocation_id'),
    targetAgentId: text(value, 'target_agent_id'),
    scopeType: text(value, 'scope_type') as MemoryCandidateRecord['scopeType'],
    scopeRef: text(value, 'scope_ref'),
    contentKind: text(value, 'content_kind') as MemoryCandidateRecord['contentKind'],
    proposedContent: text(value, 'proposed_content'),
    proposedSummary: optionalText(value, 'proposed_summary'),
    projectionHash: text(value, 'projection_hash'),
    status: text(value, 'status') as MemoryCandidateRecord['status'],
    conflictMemoryIds: JSON.parse(text(value, 'conflict_memory_ids_json')) as MemoryCandidateRecord['conflictMemoryIds'],
    decidedAt: optionalNumber(value, 'decided_at'),
    decidedBy: optionalText(value, 'decided_by'),
    acceptedMemoryId: optionalText(value, 'accepted_memory_id'),
    mergedIntoMemoryId: optionalText(value, 'merged_into_memory_id'),
    createdAt: number(value, 'created_at'),
    updatedAt: number(value, 'updated_at'),
  };
}

function mapCandidateSource(value: unknown): MemoryCandidateSourceRecord | null {
  if (!value) return null;
  return {
    candidateId: text(value, 'memory_candidate_id'),
    teamId: text(value, 'team_id'),
    sourceKind: text(value, 'source_kind') as MemoryCandidateSourceRecord['sourceKind'],
    sourceId: text(value, 'source_id'),
    snapshotHash: text(value, 'snapshot_hash'),
    sourceScopeType: text(value, 'source_scope_type') as MemoryCandidateSourceRecord['sourceScopeType'],
    sourceScopeRef: text(value, 'source_scope_ref'),
    sourceVisibility: text(value, 'source_visibility') as MemoryCandidateSourceRecord['sourceVisibility'],
    createdAt: number(value, 'created_at'),
  };
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

function mapCapsuleRefRequired(value: unknown): MemoryCapsuleRefRecord {
  const record = mapCapsuleRef(value);
  if (!record) throw new Error('SQLite memory capsule ref row could not be mapped');
  return record;
}

function mapCapsuleItemManifestRequired(value: unknown): MemoryCapsuleItemManifestRecord {
  const record = mapCapsuleItemManifest(value);
  if (!record) throw new Error('SQLite memory capsule item manifest row could not be mapped');
  return record;
}

function mapCandidateRequired(value: unknown): MemoryCandidateRecord {
  const record = mapCandidate(value);
  if (!record) throw new Error('SQLite memory candidate row could not be mapped');
  return record;
}

function mapCandidateSourceRequired(value: unknown): MemoryCandidateSourceRecord {
  const record = mapCandidateSource(value);
  if (!record) throw new Error('SQLite memory candidate source row could not be mapped');
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

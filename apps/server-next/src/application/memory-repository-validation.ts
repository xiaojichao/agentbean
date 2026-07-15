import {
  MEMORY_KINDS,
  MEMORY_SCOPE_TYPES,
  MEMORY_STATUSES,
  type MemoryScopeType,
  type UnixMs,
} from '../../../../packages/contracts/src/index.js';
import type {
  MemoryAuditEventRecord,
  MemoryCapsuleRefRecord,
  MemoryGrantRecord,
  MemoryItemRecord,
  MemorySourceRecord,
} from './memory-repositories.js';

const SERVER_SCOPE_TYPES = new Set<string>(MEMORY_SCOPE_TYPES);
const MEMORY_KIND_VALUES = new Set<string>(MEMORY_KINDS);
const MEMORY_STATUS_VALUES = new Set<string>(MEMORY_STATUSES);
const SOURCE_KIND_VALUES = new Set<string>([
  'message', 'task', 'artifact', 'workspace-run', 'invocation', 'memory', 'manual', 'local-summary',
]);
const SOURCE_VISIBILITY_VALUES = new Set<string>(['team', 'private', 'dm-participants', 'local-only']);
const CONTENT_KIND_VALUES = new Set<string>(['summary', 'fact', 'decision', 'preference', 'procedure']);
const REDACTION_LEVEL_VALUES = new Set<string>(['none', 'summary-only', 'sensitive-removed']);
const GRANT_STATUS_VALUES = new Set<string>(['active', 'revoked', 'expired']);
const AUDIT_SUBJECT_VALUES = new Set<string>(['memory', 'grant', 'capsule', 'candidate']);
const AUDIT_ACTOR_VALUES = new Set<string>(['system', 'user', 'agent', 'manager']);
const AUDIT_EVENT_VALUES = new Set<string>([
  'memory-created', 'memory-updated', 'memory-activated', 'memory-rejected',
  'memory-expired', 'memory-superseded', 'memory-deleted', 'source-linked',
  'tag-linked', 'tag-unlinked', 'grant-issued', 'grant-revoked', 'capsule-created',
  'capsule-read', 'capsule-injected', 'capsule-denied', 'capsule-expired',
  'candidate-created', 'candidate-decided',
]);
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertServerMemoryScope(scopeType: string, scopeRef: string): asserts scopeType is MemoryScopeType {
  if (!SERVER_SCOPE_TYPES.has(scopeType)) throw new Error('server memory scope is not allowed');
  if (scopeRef.trim().length === 0) throw new Error('server memory scope ref is required');
}

export function assertMemoryItemRecord(record: MemoryItemRecord): void {
  assertServerMemoryScope(record.scopeType, record.scopeRef);
  if (!MEMORY_KIND_VALUES.has(record.kind) || !MEMORY_STATUS_VALUES.has(record.status)) {
    throw new Error('memory kind or status is invalid');
  }
  if (record.content.length === 0) throw new Error('memory content is required');
  if (record.updatedAt < record.createdAt) throw new Error('memory update time precedes creation');
  if (record.confidence !== undefined && (record.confidence < 0 || record.confidence > 1)) {
    throw new Error('memory confidence must be between zero and one');
  }
  if (record.createdByUserId && record.createdByAgentId) {
    throw new Error('memory creator must have one identity kind');
  }
  if (record.validUntil !== undefined && record.validFrom !== undefined
    && record.validUntil <= record.validFrom) {
    throw new Error('memory validity window is invalid');
  }
}

export function assertMemoryItemUpdate(current: MemoryItemRecord, next: MemoryItemRecord): void {
  if (current.id !== next.id || current.teamId !== next.teamId
    || current.createdAt !== next.createdAt
    || current.createdByUserId !== next.createdByUserId
    || current.createdByAgentId !== next.createdByAgentId) {
    throw new Error('memory item immutable identity changed');
  }
  if (next.updatedAt <= current.updatedAt) {
    throw new Error('memory item update time must advance');
  }
}

export function assertMemorySourceRecord(record: MemorySourceRecord): void {
  assertServerMemoryScope(record.sourceScopeType, record.sourceScopeRef);
  if (!SOURCE_KIND_VALUES.has(record.sourceKind)
    || !SOURCE_VISIBILITY_VALUES.has(record.sourceVisibility)) {
    throw new Error('memory source kind or visibility is invalid');
  }
  if (record.snapshotHash.trim().length === 0) throw new Error('memory source snapshot hash is required');
  if (record.sourceVisibility === 'local-only') {
    throw new Error('local-only memory source must stay on Device');
  }
}

export function assertMemoryTag(tag: string): void {
  if (!TAG_PATTERN.test(tag)) throw new Error('memory tag must be a lowercase slug');
}

export function assertMemoryGrantRecord(record: MemoryGrantRecord): void {
  assertServerMemoryScope(record.sourceScopeType, record.sourceScopeRef);
  if (!CONTENT_KIND_VALUES.has(record.authorizedContentKind)
    || !REDACTION_LEVEL_VALUES.has(record.authorizedRedactionLevel)
    || !GRANT_STATUS_VALUES.has(record.status)) {
    throw new Error('memory grant authorization values are invalid');
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new Error('memory grant version must be a positive integer');
  }
  if (record.expiresAt <= record.issuedAt) throw new Error('memory grant expiry must follow issue time');
  if (record.status === 'revoked' && record.revokedAt === undefined) {
    throw new Error('revoked memory grant must record revokedAt');
  }
  if (record.status !== 'revoked' && record.revokedAt !== undefined) {
    throw new Error('only a revoked memory grant may record revokedAt');
  }
  if (record.revokedAt !== undefined
    && (record.revokedAt < record.issuedAt || record.revokedAt > record.expiresAt)) {
    throw new Error('memory grant revocation time is outside its validity window');
  }
}

export function assertMemoryGrantTransition(
  current: MemoryGrantRecord | null,
  next: MemoryGrantRecord,
): void {
  if (!current) {
    if (next.version !== 1) throw new Error('memory grant version is not sequential');
    return;
  }
  if (next.version !== current.version + 1) {
    throw new Error('memory grant version is not sequential');
  }
  if (current.status !== 'active') throw new Error('terminal memory grant cannot be revised');
  if (next.teamId !== current.teamId
    || next.id !== current.id
    || next.sourceScopeType !== current.sourceScopeType
    || next.sourceScopeRef !== current.sourceScopeRef
    || next.targetAgentId !== current.targetAgentId
    || next.authorizedContentKind !== current.authorizedContentKind
    || next.authorizedRedactionLevel !== current.authorizedRedactionLevel) {
    throw new Error('memory grant authorization identity changed');
  }
  if (next.issuedAt < current.issuedAt) throw new Error('memory grant issue time moved backwards');
}

export function assertMemoryAuditEventRecord(record: MemoryAuditEventRecord): void {
  const unsafe = record as unknown as Record<string, unknown>;
  for (const key of ['content', 'body', 'prompt', 'before', 'after']) {
    if (key in unsafe) throw new Error('memory audit event must not contain sensitive body fields');
  }
  if (!AUDIT_SUBJECT_VALUES.has(record.subjectKind)
    || !AUDIT_ACTOR_VALUES.has(record.actorKind)
    || !AUDIT_EVENT_VALUES.has(record.eventType)
    || (record.redactionLevel !== undefined && !REDACTION_LEVEL_VALUES.has(record.redactionLevel))) {
    throw new Error('memory audit event values are invalid');
  }
  for (const sourceRef of record.sourceRefs) {
    if (sourceRef.schemaVersion !== 1 || !SOURCE_KIND_VALUES.has(sourceRef.sourceKind)
      || sourceRef.sourceId.trim().length === 0 || sourceRef.snapshotHash.trim().length === 0) {
      throw new Error('memory audit source ref is invalid');
    }
  }
  if ((record.scopeType === undefined) !== (record.scopeRef === undefined)) {
    throw new Error('memory audit scope type and ref must be provided together');
  }
  if (record.scopeType !== undefined && record.scopeRef !== undefined) {
    if (record.scopeType === 'local-workspace') {
      if (record.eventType !== 'capsule-denied' || record.scopeRef.trim().length === 0) {
        throw new Error('local workspace may only appear in a denied Capsule audit');
      }
    } else {
      assertServerMemoryScope(record.scopeType, record.scopeRef);
    }
  }
}

export function assertMemoryCapsuleRefRecord(record: MemoryCapsuleRefRecord): void {
  if (record.contentHash.trim().length === 0) throw new Error('memory capsule ref content hash is required');
  if (record.authorizationDecisionId.trim().length === 0) {
    throw new Error('memory capsule ref authorization decision is required');
  }
  if (record.targetAgentId.trim().length === 0) throw new Error('memory capsule ref target agent is required');
  if (record.managementRunId.trim().length === 0) throw new Error('memory capsule ref management run is required');
  if (record.expiresAt <= record.issuedAt) throw new Error('memory capsule ref expiry must follow issue time');
  if (record.deniedAt !== undefined
    && (record.deniedAt < record.issuedAt || record.deniedAt > record.expiresAt)) {
    throw new Error('memory capsule ref denial time is outside its validity window');
  }
  if (record.createdAt < record.issuedAt) throw new Error('memory capsule ref creation precedes issue time');
}

export function assertMemoryCapsuleRefDenial(
  current: MemoryCapsuleRefRecord,
  deniedAt: UnixMs,
): void {
  if (current.deniedAt !== undefined) throw new Error('memory capsule ref is already denied');
  if (deniedAt < current.issuedAt || deniedAt > current.expiresAt) {
    throw new Error('memory capsule ref denial time is outside its validity window');
  }
}

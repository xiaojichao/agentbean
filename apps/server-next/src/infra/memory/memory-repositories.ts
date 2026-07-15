import type {
  MemoryAuditEventRecord,
  MemoryCapsuleRefRecord,
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
  assertMemoryGrantRecord,
  assertMemoryGrantTransition,
  assertMemoryItemRecord,
  assertMemoryItemUpdate,
  assertMemorySourceRecord,
  assertMemoryTag,
} from '../../application/memory-repository-validation.js';

export interface MemoryRepositoryMemoryState {
  readonly items: Map<string, MemoryItemRecord>;
  readonly sources: Map<string, MemorySourceRecord>;
  readonly tags: Map<string, MemoryTagRecord>;
  readonly grants: Map<string, MemoryGrantRecord>;
  readonly auditEvents: Map<string, MemoryAuditEventRecord>;
  readonly capsuleRefs: Map<string, MemoryCapsuleRefRecord>;
}

export function createMemoryRepositoryMemoryState(): MemoryRepositoryMemoryState {
  return {
    items: new Map(),
    sources: new Map(),
    tags: new Map(),
    grants: new Map(),
    auditEvents: new Map(),
    capsuleRefs: new Map(),
  };
}

export function cloneMemoryRepositoryMemoryState(
  state: MemoryRepositoryMemoryState,
): MemoryRepositoryMemoryState {
  return {
    items: new Map(state.items),
    sources: new Map(state.sources),
    tags: new Map(state.tags),
    grants: new Map(state.grants),
    auditEvents: new Map(state.auditEvents),
    capsuleRefs: new Map(state.capsuleRefs),
  };
}

export function restoreMemoryRepositoryMemoryState(
  target: MemoryRepositoryMemoryState,
  source: MemoryRepositoryMemoryState,
): void {
  for (const key of Object.keys(source) as (keyof MemoryRepositoryMemoryState)[]) {
    target[key].clear();
    for (const [id, value] of source[key]) target[key].set(id, value as never);
  }
}

export function createInMemoryMemoryRepositories(
  state: MemoryRepositoryMemoryState,
): MemoryRepositories {
  return {
    items: {
      async create(record) {
        assertMemoryItemRecord(record);
        if (state.items.has(record.id)) throw new Error('memory item already exists');
        state.items.set(record.id, record);
        return record;
      },
      async getById(input) {
        const record = state.items.get(input.id);
        return record?.teamId === input.teamId ? record : null;
      },
      async listByScope(input) {
        return [...state.items.values()]
          .filter((record) => record.teamId === input.teamId
            && record.scopeType === input.scopeType && record.scopeRef === input.scopeRef)
          .sort(compareUpdatedDesc);
      },
      async update(input) {
        assertMemoryItemRecord(input.record);
        const current = state.items.get(input.record.id);
        if (!current || current.teamId !== input.record.teamId
          || current.updatedAt !== input.expectedUpdatedAt) return null;
        assertMemoryItemUpdate(current, input.record);
        state.items.set(input.record.id, input.record);
        return input.record;
      },
    },
    sources: {
      async create(record) {
        assertMemorySourceRecord(record);
        requireMemory(state, record.teamId, record.memoryId);
        const key = sourceKey(record);
        if (state.sources.has(key)) throw new Error('memory source already exists');
        state.sources.set(key, record);
        return record;
      },
      async listByMemory(input) {
        return [...state.sources.values()]
          .filter((record) => record.teamId === input.teamId && record.memoryId === input.memoryId)
          .sort(compareSource);
      },
      async listBySource(input) {
        return [...state.sources.values()]
          .filter((record) => record.teamId === input.teamId
            && record.sourceKind === input.sourceKind && record.sourceId === input.sourceId)
          .sort(compareSource);
      },
    },
    tags: {
      async create(record) {
        assertMemoryTag(record.tag);
        requireMemory(state, record.teamId, record.memoryId);
        const key = tagKey(record.teamId, record.memoryId, record.tag);
        if (state.tags.has(key)) throw new Error('memory tag already exists');
        state.tags.set(key, record);
        return record;
      },
      async delete(input) {
        return state.tags.delete(tagKey(input.teamId, input.memoryId, input.tag));
      },
      async listByMemory(input) {
        return [...state.tags.values()]
          .filter((record) => record.teamId === input.teamId && record.memoryId === input.memoryId)
          .sort((left, right) => left.tag.localeCompare(right.tag));
      },
    },
    grants: {
      async create(record) {
        assertMemoryGrantRecord(record);
        const versions = grantVersions(state, record.teamId, record.id);
        assertMemoryGrantTransition(versions.at(-1) ?? null, record);
        const key = grantKey(record.id, record.version);
        if (state.grants.has(key)) throw new Error('memory grant version already exists');
        state.grants.set(key, record);
        return record;
      },
      async getCurrent(input) {
        return grantVersions(state, input.teamId, input.id).at(-1) ?? null;
      },
      async listCurrentForTarget(input) {
        const ids = new Set([...state.grants.values()]
          .filter((record) => record.teamId === input.teamId && record.targetAgentId === input.targetAgentId)
          .map((record) => record.id));
        return [...ids]
          .map((id) => grantVersions(state, input.teamId, id).at(-1))
          .filter((record): record is MemoryGrantRecord => record !== undefined)
          .sort(compareGrantScope);
      },
      async listVersions(input) {
        return grantVersions(state, input.teamId, input.id);
      },
    },
    auditEvents: {
      async append(record) {
        assertMemoryAuditEventRecord(record);
        if (state.auditEvents.has(record.id)) throw new Error('memory audit event already exists');
        state.auditEvents.set(record.id, record);
        return record;
      },
      async listBySubject(input) {
        return [...state.auditEvents.values()]
          .filter((record) => record.teamId === input.teamId
            && record.subjectKind === input.subjectKind && record.subjectId === input.subjectId)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
    },
    capsuleRefs: {
      async create(record) {
        assertMemoryCapsuleRefRecord(record);
        const key = `${record.teamId}:${record.id}`;
        if (state.capsuleRefs.has(key)) throw new Error('memory capsule ref already exists');
        state.capsuleRefs.set(key, record);
        return record;
      },
      async getById(input) {
        return state.capsuleRefs.get(`${input.teamId}:${input.id}`) ?? null;
      },
      async listByRun(input) {
        return [...state.capsuleRefs.values()]
          .filter((record) => record.teamId === input.teamId && record.managementRunId === input.managementRunId)
          .sort((left, right) => left.id.localeCompare(right.id));
      },
      async markDenied(input) {
        const key = `${input.teamId}:${input.id}`;
        const current = state.capsuleRefs.get(key);
        if (!current) return null;
        assertMemoryCapsuleRefDenial(current, input.deniedAt);
        const denied = { ...current, deniedAt: input.deniedAt };
        state.capsuleRefs.set(key, denied);
        return denied;
      },
    },
  };
}

function requireMemory(state: MemoryRepositoryMemoryState, teamId: string, memoryId: string): void {
  const memory = state.items.get(memoryId);
  if (!memory || memory.teamId !== teamId) throw new Error('memory item does not belong to Team');
}

function sourceKey(record: Pick<MemorySourceRecord, 'teamId' | 'memoryId' | 'sourceKind' | 'sourceId'>): string {
  return `${record.teamId}:${record.memoryId}:${record.sourceKind}:${record.sourceId}`;
}

function tagKey(teamId: string, memoryId: string, tag: string): string {
  return `${teamId}:${memoryId}:${tag}`;
}

function grantKey(id: string, version: number): string {
  return `${id}:${version}`;
}

function grantVersions(
  state: MemoryRepositoryMemoryState,
  teamId: string,
  id: string,
): MemoryGrantRecord[] {
  return [...state.grants.values()]
    .filter((record) => record.teamId === teamId && record.id === id)
    .sort((left, right) => left.version - right.version);
}

function compareUpdatedDesc(left: MemoryItemRecord, right: MemoryItemRecord): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

function compareSource(left: MemorySourceRecord, right: MemorySourceRecord): number {
  return left.createdAt - right.createdAt
    || left.sourceKind.localeCompare(right.sourceKind)
    || left.sourceId.localeCompare(right.sourceId)
    || left.memoryId.localeCompare(right.memoryId);
}

function compareGrantScope(left: MemoryGrantRecord, right: MemoryGrantRecord): number {
  return left.sourceScopeType.localeCompare(right.sourceScopeType)
    || left.sourceScopeRef.localeCompare(right.sourceScopeRef)
    || left.id.localeCompare(right.id);
}

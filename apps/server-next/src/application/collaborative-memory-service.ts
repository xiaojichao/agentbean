import { createHash } from 'node:crypto';

import type {
  ID,
  MemoryContentKind,
  MemoryKind,
  MemoryRedactionLevel,
  MemoryScopeType,
  MemorySourceRefDto,
  MemorySourceVisibility,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import type {
  MemoryAuditActorKind,
  MemoryAuditEventRecord,
  MemoryGrantRecord,
  MemoryItemRecord,
  MemoryRepositories,
  MemorySourceRecord,
} from './memory-repositories.js';
import type { MemoryUnitOfWork } from './memory-unit-of-work.js';

/**
 * 协作 Memory 写生命周期 usecase 层。
 *
 * 这一层只编排业务流程：授权预检、状态机迁移合法性、去重、乐观并发与审计编排。
 * 所有不变量（scope 拒 local、source 拒 local-only、tag 小写、grant 版本链、audit 无正文）
 * 已由 PR#577 的 repository 校验层 + 0015 schema CHECK 兜底，本层不重复断言，只在业务
 * 语义点抛出可读错误码。每个写操作都在 `memoryUnitOfWork.run` 内完成，保证状态、来源、
 * tag、grant 与审计原子更新或整体回滚。
 */

export interface MemoryPermissions {
  /** 校验 actor 能否向该 server scope 写入协作 Memory。失败须 throw。 */
  assertWriteAuthority(input: {
    readonly teamId: ID;
    readonly actorId: ID;
    readonly scopeType: MemoryScopeType;
    readonly scopeRef: ID;
  }): Promise<void>;
  /** 校验来源真实可见性允许写入目标 Memory scope。 */
  assertSourceAuthority(input: {
    readonly teamId: ID;
    readonly actorId: ID;
    readonly sourceScopeType: MemoryScopeType;
    readonly sourceScopeRef: ID;
    readonly sourceVisibility: Exclude<MemorySourceVisibility, 'local-only'>;
    readonly targetScopeType: MemoryScopeType;
    readonly targetScopeRef: ID;
  }): Promise<void>;
  /** 校验 actor 可以把来源 scope 显式授权给目标 Agent。 */
  assertGrantAuthority(input: {
    readonly teamId: ID;
    readonly actorId: ID;
    readonly sourceScopeType: MemoryScopeType;
    readonly sourceScopeRef: ID;
    readonly targetAgentId: ID;
  }): Promise<void>;
}

export interface CollaborativeMemoryServiceDeps {
  readonly unitOfWork: MemoryUnitOfWork;
  readonly permissions: MemoryPermissions;
  readonly clock: { now(): UnixMs };
  readonly ids: { nextId(): ID };
}

export interface MemoryView {
  readonly item: MemoryItemRecord;
  readonly tags: readonly string[];
  readonly sources: readonly MemorySourceRefDto[];
}

export interface CollaborativeMemorySourceInput extends MemorySourceRefDto {
  readonly sourceScopeType: MemoryScopeType;
  readonly sourceScopeRef: ID;
  readonly sourceVisibility: Exclude<MemorySourceVisibility, 'local-only'>;
}

export interface CollaborativeMemoryService {
  createMemory(input: CreateMemoryInput): Promise<MemoryView>;
  updateMemory(input: UpdateMemoryInput): Promise<MemoryView>;
  activateCandidate(input: MemoryTargetInput): Promise<MemoryView>;
  rejectCandidate(input: MemoryTargetInput): Promise<MemoryView>;
  expireMemory(input: MemoryTargetInput): Promise<MemoryView>;
  supersedeMemory(input: SupersedeMemoryInput): Promise<{ readonly created: MemoryView }>;
  deleteMemory(input: MemoryTargetInput): Promise<MemoryView>;
  issueGrant(input: IssueGrantInput): Promise<MemoryGrantRecord>;
  revokeGrant(input: RevokeGrantInput): Promise<MemoryGrantRecord>;
}

export interface CreateMemoryInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly kind: MemoryKind;
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: ID;
  readonly content: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly CollaborativeMemorySourceInput[];
  readonly validUntil?: UnixMs;
  /** 高影响/强规则/敏感摘要默认进入 candidate，等待人工确认。 */
  readonly asCandidate?: boolean;
}

export interface UpdateMemoryInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly expectedUpdatedAt: UnixMs;
  readonly content?: string;
  readonly summary?: string;
  readonly validUntil?: UnixMs;
  /** 提供时整体替换 tag 集合。 */
  readonly tags?: readonly string[];
}

export interface MemoryTargetInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly memoryId: ID;
}

export interface SupersedeMemoryInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly content: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly CollaborativeMemorySourceInput[];
}

export interface IssueGrantInput {
  readonly teamId: ID;
  readonly issuedByUserId: ID;
  readonly grantId?: ID;
  readonly sourceScopeType: MemoryScopeType;
  readonly sourceScopeRef: ID;
  readonly targetAgentId: ID;
  readonly authorizedContentKind: MemoryContentKind;
  readonly authorizedRedactionLevel: MemoryRedactionLevel;
  readonly expiresAt: UnixMs;
}

export interface RevokeGrantInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly grantId: ID;
}

const ACTOR_USER: MemoryAuditActorKind = 'user';

export function createCollaborativeMemoryService(
  deps: CollaborativeMemoryServiceDeps,
): CollaborativeMemoryService {
  const { unitOfWork, permissions, clock, ids } = deps;

  async function loadView(memory: MemoryRepositories, teamId: ID, item: MemoryItemRecord): Promise<MemoryView> {
    const [tagRecords, sourceRecords] = await Promise.all([
      memory.tags.listByMemory({ teamId, memoryId: item.id }),
      memory.sources.listByMemory({ teamId, memoryId: item.id }),
    ]);
    return {
      item,
      tags: tagRecords.map((record) => record.tag),
      sources: sourceRecords.map(toSourceRefDto),
    };
  }

  async function loadItem(memory: MemoryRepositories, teamId: ID, memoryId: ID): Promise<MemoryItemRecord> {
    const item = await memory.items.getById({ teamId, id: memoryId });
    if (!item) throw new Error('MEMORY_NOT_FOUND');
    return item;
  }

  async function loadSourceRefs(memory: MemoryRepositories, teamId: ID, memoryId: ID): Promise<MemorySourceRefDto[]> {
    const records = await memory.sources.listByMemory({ teamId, memoryId });
    return records.map(toSourceRefDto);
  }

  async function appendAudit(memory: MemoryRepositories, record: Omit<MemoryAuditEventRecord, 'id' | 'teamId' | 'actorKind' | 'createdAt'> & {
    readonly teamId: ID;
    readonly actorId?: ID;
    readonly createdAt: UnixMs;
  }): Promise<void> {
    const event: MemoryAuditEventRecord = {
      id: ids.nextId(),
      actorKind: ACTOR_USER,
      ...record,
    };
    await memory.auditEvents.append(event);
  }

  return {
    async createMemory(input) {
      return unitOfWork.run(async (memory) => {
        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: input.scopeType, scopeRef: input.scopeRef,
        });
        await assertSourceAuthorities(input);
        const now = clock.now();
        if (input.validUntil !== undefined && input.validUntil <= now) {
          throw new Error('MEMORY_INVALID_VALIDITY');
        }
        await assertNotDuplicate(memory, input);

        const item: MemoryItemRecord = {
          schemaVersion: 1,
          id: ids.nextId(),
          teamId: input.teamId,
          kind: input.kind,
          status: input.asCandidate ? 'candidate' : 'active',
          scopeType: input.scopeType,
          scopeRef: input.scopeRef,
          content: input.content,
          summary: input.summary,
          createdByUserId: input.actorId,
          validFrom: input.validUntil !== undefined ? now : undefined,
          validUntil: input.validUntil,
          approvedByUserId: input.asCandidate ? undefined : input.actorId,
          createdAt: now,
          updatedAt: now,
        };
        await memory.items.create(item);

        const sourceInputs = input.sourceRefs ?? [];
        for (const ref of sourceInputs) {
          await memory.sources.create(toSourceRecord(input.teamId, item.id, ref, now));
        }
        for (const tag of input.tags ?? []) {
          await memory.tags.create({ memoryId: item.id, teamId: input.teamId, tag, createdAt: now });
        }

        const sourceRefs = sourceInputs.map(toSourceRefDto);
        await appendAudit(memory, {
          teamId: input.teamId,
          subjectKind: 'memory',
          subjectId: item.id,
          eventType: 'memory-created',
          actorId: input.actorId,
          scopeType: item.scopeType,
          scopeRef: item.scopeRef,
          sourceRefs,
          sourceRefsHash: hashSourceRefs(sourceRefs),
          contentHash: hashMemoryContent(item.content),
          createdAt: now,
        });

        return loadView(memory, input.teamId, item);
      });
    },

    async updateMemory(input) {
      return unitOfWork.run(async (memory) => {
        const current = await loadItem(memory, input.teamId, input.memoryId);
        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: current.scopeType, scopeRef: current.scopeRef,
        });
        const now = nextUpdatedAt(clock.now(), current.updatedAt);
        if (current.status !== 'active' && current.status !== 'candidate') {
          throw new Error('MEMORY_INVALID_TRANSITION');
        }
        if (input.validUntil !== undefined && input.validUntil <= now) {
          throw new Error('MEMORY_INVALID_VALIDITY');
        }

        const next: MemoryItemRecord = {
          ...current,
          content: input.content ?? current.content,
          summary: input.summary ?? current.summary,
          validUntil: input.validUntil ?? current.validUntil,
          updatedAt: now,
        };
        await assertNotDuplicate(memory, next, current.id);
        const updated = await memory.items.update({ record: next, expectedUpdatedAt: input.expectedUpdatedAt });
        if (!updated) throw new Error('MEMORY_UPDATE_CONFLICT');

        if (input.tags) {
          await replaceTags(memory, input.teamId, updated, input.tags, input.actorId, now);
        }

        const sourceRefs = await loadSourceRefs(memory, input.teamId, updated.id);
        await appendAudit(memory, {
          teamId: input.teamId,
          subjectKind: 'memory',
          subjectId: updated.id,
          eventType: 'memory-updated',
          actorId: input.actorId,
          scopeType: updated.scopeType,
          scopeRef: updated.scopeRef,
          sourceRefs,
          sourceRefsHash: hashSourceRefs(sourceRefs),
          contentHash: hashMemoryContent(updated.content),
          createdAt: now,
        });

        return loadView(memory, input.teamId, updated);
      });
    },

    async activateCandidate(input) {
      return transition(memoryStatusTransition('candidate', 'active', 'memory-activated', async (current, now) => ({
        ...current, status: 'active', approvedByUserId: input.actorId, updatedAt: now,
      })))(input);
    },

    async rejectCandidate(input) {
      return transition(memoryStatusTransition('candidate', 'rejected', 'memory-rejected', async (current, now) => ({
        ...current, status: 'rejected', updatedAt: now,
      })))(input);
    },

    async expireMemory(input) {
      return transition(memoryStatusTransition('active', 'expired', 'memory-expired', async (current, now) => ({
        ...current, status: 'expired', updatedAt: now,
      })))(input);
    },

    async deleteMemory(input) {
      return transition(memoryDeletionTransition(input))(input);
    },

    async supersedeMemory(input) {
      return unitOfWork.run(async (memory) => {
        const old = await loadItem(memory, input.teamId, input.memoryId);
        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: old.scopeType, scopeRef: old.scopeRef,
        });
        await assertSourceAuthorities({
          ...input,
          scopeType: old.scopeType,
          scopeRef: old.scopeRef,
        });
        const now = nextUpdatedAt(clock.now(), old.updatedAt);
        if (old.status !== 'active') throw new Error('MEMORY_INVALID_TRANSITION');

        const created: MemoryItemRecord = {
          schemaVersion: 1,
          id: ids.nextId(),
          teamId: input.teamId,
          kind: old.kind,
          status: 'active',
          scopeType: old.scopeType,
          scopeRef: old.scopeRef,
          content: input.content,
          summary: input.summary,
          createdByUserId: input.actorId,
          validFrom: now,
          approvedByUserId: input.actorId,
          createdAt: now,
          updatedAt: now,
        };
        await assertNotDuplicate(memory, created, old.id);
        await memory.items.create(created);

        const superseded = await memory.items.update({
          record: { ...old, status: 'superseded', supersededById: created.id, updatedAt: now },
          expectedUpdatedAt: old.updatedAt,
        });
        if (!superseded) throw new Error('MEMORY_UPDATE_CONFLICT');

        const sourceInputs = input.sourceRefs ?? [];
        for (const ref of sourceInputs) {
          await memory.sources.create(toSourceRecord(input.teamId, created.id, ref, now));
        }
        for (const tag of input.tags ?? []) {
          await memory.tags.create({ memoryId: created.id, teamId: input.teamId, tag, createdAt: now });
        }

        const sourceRefs = sourceInputs.map(toSourceRefDto);
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'memory', subjectId: created.id,
          eventType: 'memory-created', actorId: input.actorId,
          scopeType: created.scopeType, scopeRef: created.scopeRef,
          sourceRefs, sourceRefsHash: hashSourceRefs(sourceRefs),
          contentHash: hashMemoryContent(created.content), createdAt: now,
        });
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'memory', subjectId: superseded.id,
          eventType: 'memory-superseded', actorId: input.actorId,
          scopeType: superseded.scopeType, scopeRef: superseded.scopeRef,
          sourceRefs: await loadSourceRefs(memory, input.teamId, superseded.id),
          createdAt: now,
        });

        return { created: await loadView(memory, input.teamId, created) };
      });
    },

    async issueGrant(input) {
      return unitOfWork.run(async (memory) => {
        await permissions.assertGrantAuthority({
          teamId: input.teamId, actorId: input.issuedByUserId,
          sourceScopeType: input.sourceScopeType, sourceScopeRef: input.sourceScopeRef,
          targetAgentId: input.targetAgentId,
        });
        const now = clock.now();
        const grantId = input.grantId ?? ids.nextId();
        const current = await memory.grants.getCurrent({ teamId: input.teamId, id: grantId });
        if (current) throw new Error('MEMORY_GRANT_EXISTS');

        const grant: MemoryGrantRecord = {
          id: grantId,
          version: 1,
          teamId: input.teamId,
          sourceScopeType: input.sourceScopeType,
          sourceScopeRef: input.sourceScopeRef,
          targetAgentId: input.targetAgentId,
          authorizedContentKind: input.authorizedContentKind,
          authorizedRedactionLevel: input.authorizedRedactionLevel,
          status: 'active',
          issuedByUserId: input.issuedByUserId,
          issuedAt: now,
          expiresAt: input.expiresAt,
        };
        await memory.grants.create(grant);
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'grant', subjectId: grant.id,
          eventType: 'grant-issued', actorId: input.issuedByUserId,
          scopeType: input.sourceScopeType, scopeRef: input.sourceScopeRef,
          targetAgentId: input.targetAgentId,
          sourceRefs: [],
          redactionLevel: input.authorizedRedactionLevel,
          createdAt: now,
        });
        return grant;
      });
    },

    async revokeGrant(input) {
      return unitOfWork.run(async (memory) => {
        const now = clock.now();
        const current = await memory.grants.getCurrent({ teamId: input.teamId, id: input.grantId });
        if (!current) throw new Error('MEMORY_GRANT_NOT_FOUND');
        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: current.sourceScopeType, scopeRef: current.sourceScopeRef,
        });
        if (current.status !== 'active') throw new Error('MEMORY_GRANT_NOT_ACTIVE');

        // revokedAt 必须落在 [issuedAt, expiresAt] 内；对已过有效期的 active grant
        // 钳到 expiresAt，避免校验层拒绝。
        const revokedAt = Math.min(now, current.expiresAt);
        const revoked: MemoryGrantRecord = {
          ...current,
          version: current.version + 1,
          status: 'revoked',
          revokedAt,
        };
        await memory.grants.create(revoked);
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'grant', subjectId: revoked.id,
          eventType: 'grant-revoked', actorId: input.actorId,
          scopeType: current.sourceScopeType, scopeRef: current.sourceScopeRef,
          targetAgentId: current.targetAgentId,
          sourceRefs: [],
          redactionLevel: current.authorizedRedactionLevel,
          createdAt: now,
        });
        return revoked;
      });
    },
  };

  /**
   * 单状态→单目标状态的迁移工厂（activate/reject/expire 复用）。delete 允许两个源状态，
   * 单独构造。
   */
  function memoryStatusTransition(
    from: MemoryItemRecord['status'],
    to: MemoryItemRecord['status'],
    eventType: MemoryAuditEventRecord['eventType'],
    apply: (current: MemoryItemRecord, now: UnixMs) => Promise<MemoryItemRecord> | MemoryItemRecord,
  ) {
    return async (memory: MemoryRepositories, input: MemoryTargetInput): Promise<MemoryView> => {
      const current = await loadItem(memory, input.teamId, input.memoryId);
      await permissions.assertWriteAuthority({
        teamId: input.teamId, actorId: input.actorId,
        scopeType: current.scopeType, scopeRef: current.scopeRef,
      });
      const now = nextUpdatedAt(clock.now(), current.updatedAt);
      if (current.status !== from) throw new Error('MEMORY_INVALID_TRANSITION');

      const next = await apply(current, now);
      const updated = await memory.items.update({ record: next, expectedUpdatedAt: current.updatedAt });
      if (!updated) throw new Error('MEMORY_UPDATE_CONFLICT');

      await appendAudit(memory, {
        teamId: input.teamId, subjectKind: 'memory', subjectId: updated.id,
        eventType, actorId: input.actorId,
        scopeType: updated.scopeType, scopeRef: updated.scopeRef,
        sourceRefs: await loadSourceRefs(memory, input.teamId, updated.id),
        createdAt: now,
      });
      return loadView(memory, input.teamId, updated);
    };
  }

  function memoryDeletionTransition(input: MemoryTargetInput) {
    return async (memory: MemoryRepositories): Promise<MemoryView> => {
      const current = await loadItem(memory, input.teamId, input.memoryId);
      await permissions.assertWriteAuthority({
        teamId: input.teamId, actorId: input.actorId,
        scopeType: current.scopeType, scopeRef: current.scopeRef,
      });
      const now = nextUpdatedAt(clock.now(), current.updatedAt);
      if (current.status !== 'active' && current.status !== 'candidate') {
        throw new Error('MEMORY_INVALID_TRANSITION');
      }
      const deleted = await memory.items.update({
        record: { ...current, status: 'deleted', updatedAt: now },
        expectedUpdatedAt: current.updatedAt,
      });
      if (!deleted) throw new Error('MEMORY_UPDATE_CONFLICT');
      await appendAudit(memory, {
        teamId: input.teamId, subjectKind: 'memory', subjectId: deleted.id,
        eventType: 'memory-deleted', actorId: input.actorId,
        scopeType: deleted.scopeType, scopeRef: deleted.scopeRef,
        sourceRefs: await loadSourceRefs(memory, input.teamId, deleted.id),
        createdAt: now,
      });
      return loadView(memory, input.teamId, deleted);
    };
  }

  /** 把统一的 transition 闭包接到 unitOfWork + 命令入参上。 */
  function transition(
    run: (memory: MemoryRepositories, input: MemoryTargetInput) => Promise<MemoryView>,
  ) {
    return (input: MemoryTargetInput) => unitOfWork.run((memory) => run(memory, input));
  }

  async function assertNotDuplicate(
    memory: MemoryRepositories,
    input: Pick<MemoryItemRecord, 'teamId' | 'scopeType' | 'scopeRef' | 'kind' | 'content'>,
    excludedMemoryId?: ID,
  ): Promise<void> {
    const normalized = normalizeMemoryContent(input.content);
    const existing = await memory.items.listByScope({
      teamId: input.teamId, scopeType: input.scopeType, scopeRef: input.scopeRef,
    });
    const clash = existing.some((candidate) =>
      candidate.id !== excludedMemoryId
      && (candidate.status === 'active' || candidate.status === 'candidate')
      && candidate.kind === input.kind
      && normalizeMemoryContent(candidate.content) === normalized);
    if (clash) throw new Error('MEMORY_DUPLICATE_CONTENT');
  }

  async function assertSourceAuthorities(input: {
    readonly teamId: ID;
    readonly actorId: ID;
    readonly scopeType: MemoryScopeType;
    readonly scopeRef: ID;
    readonly sourceRefs?: readonly CollaborativeMemorySourceInput[];
  }): Promise<void> {
    for (const source of input.sourceRefs ?? []) {
      await permissions.assertSourceAuthority({
        teamId: input.teamId,
        actorId: input.actorId,
        sourceScopeType: source.sourceScopeType,
        sourceScopeRef: source.sourceScopeRef,
        sourceVisibility: source.sourceVisibility,
        targetScopeType: input.scopeType,
        targetScopeRef: input.scopeRef,
      });
    }
  }

  async function replaceTags(
    memory: MemoryRepositories,
    teamId: ID,
    item: MemoryItemRecord,
    nextTags: readonly string[],
    actorId: ID,
    now: UnixMs,
  ): Promise<void> {
    const currentRecords = await memory.tags.listByMemory({ teamId, memoryId: item.id });
    const currentTags = new Set(currentRecords.map((record) => record.tag));
    const nextSet = new Set(nextTags);
    for (const tag of currentTags) {
      if (!nextSet.has(tag)) {
        await memory.tags.delete({ teamId, memoryId: item.id, tag });
        await appendAudit(memory, {
          teamId, subjectKind: 'memory', subjectId: item.id,
          eventType: 'tag-unlinked', actorId,
          scopeType: item.scopeType, scopeRef: item.scopeRef,
          sourceRefs: [], createdAt: now,
        });
      }
    }
    for (const tag of nextSet) {
      if (!currentTags.has(tag)) {
        await memory.tags.create({ memoryId: item.id, teamId, tag, createdAt: now });
        await appendAudit(memory, {
          teamId, subjectKind: 'memory', subjectId: item.id,
          eventType: 'tag-linked', actorId,
          scopeType: item.scopeType, scopeRef: item.scopeRef,
          sourceRefs: [], createdAt: now,
        });
      }
    }
  }
}

function toSourceRefDto(
  record: Pick<MemorySourceRecord, 'sourceKind' | 'sourceId' | 'snapshotHash'>,
): MemorySourceRefDto {
  return {
    schemaVersion: 1,
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    snapshotHash: record.snapshotHash,
  };
}

function toSourceRecord(
  teamId: ID,
  memoryId: ID,
  ref: CollaborativeMemorySourceInput,
  createdAt: UnixMs,
): MemorySourceRecord {
  return {
    memoryId,
    teamId,
    sourceKind: ref.sourceKind,
    sourceId: ref.sourceId,
    snapshotHash: ref.snapshotHash,
    sourceScopeType: ref.sourceScopeType,
    sourceScopeRef: ref.sourceScopeRef,
    sourceVisibility: ref.sourceVisibility,
    createdAt,
  };
}

function normalizeMemoryContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

function nextUpdatedAt(now: UnixMs, currentUpdatedAt: UnixMs): UnixMs {
  return Math.max(now, currentUpdatedAt + 1);
}

function hashMemoryContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function hashSourceRefs(refs: readonly MemorySourceRefDto[]): string {
  const canonical = [...refs]
    .map((ref) => `${ref.sourceKind}:${ref.sourceId}:${ref.snapshotHash}`)
    .sort()
    .join('|');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

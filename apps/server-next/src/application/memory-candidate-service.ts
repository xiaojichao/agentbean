import type {
  ID,
  MemoryContentKind,
  MemoryKind,
  MemoryScopeType,
  MemorySourceRefDto,
  MemorySourceVisibility,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import {
  computeProjectionHash,
  evaluateCandidateTransition,
  hashMemoryContent,
  hashSourceRefs,
} from '../../../../packages/domain/src/index.js';
import type {
  MemoryAuditActorKind,
  MemoryAuditEventRecord,
  MemoryCandidateRecord,
  MemoryCandidateSourceRecord,
  MemoryItemRecord,
  MemoryRepositories,
  MemorySourceRecord,
} from './memory-repositories.js';
import type { MemoryUnitOfWork } from './memory-unit-of-work.js';

/**
 * Memory Candidate 生命周期 usecase 层（P3-10/11，issue #583）。
 *
 * 外部 Agent 的新结论以 candidate 进入，由用户/系统决定接受、拒绝或合并。本层只编排业务
 * 流程：提交权/决策权校验、projection hash 去重、来源冲突识别、状态机迁移、active Memory
 * 创建/取代、无正文审计。所有写操作在 `memoryUnitOfWork.run` 内完成，保证 candidate、来源、
 * active Memory 与审计原子更新或整体回滚。
 *
 * 安全边界（验收 #5）：外部 Agent 只能经 `proposeCandidate` 提交 candidate；accept/reject/merge
 * 必须经 `assertDecideAuthority`（仅用户/系统）。active Memory 写入只在 decide 路径内发生，
 * 外部 Agent 工具无法绕过 candidate 直写 active。
 */

export interface MemoryCandidatePermissions {
  assertProposeAuthority(input: {
    readonly teamId: ID;
    readonly actorId: ID;
    readonly scopeType: MemoryScopeType;
    readonly scopeRef: ID;
  }): Promise<void>;
  assertDecideAuthority(input: {
    readonly teamId: ID;
    readonly actorId: ID;
    readonly candidateId: ID;
  }): Promise<void>;
  assertWriteAuthority(input: {
    readonly teamId: ID;
    readonly actorId: ID;
    readonly scopeType: MemoryScopeType;
    readonly scopeRef: ID;
  }): Promise<void>;
  assertSourceAuthority(input: {
    readonly teamId: ID;
    readonly actorId: ID;
    readonly sourceScopeType: MemoryScopeType;
    readonly sourceScopeRef: ID;
    readonly sourceVisibility: Exclude<MemorySourceVisibility, 'local-only'>;
    readonly targetScopeType: MemoryScopeType;
    readonly targetScopeRef: ID;
  }): Promise<void>;
  isSourceAvailable(input: {
    readonly teamId: ID;
    readonly sourceKind: MemorySourceRefDto['sourceKind'];
    readonly sourceId: ID;
  }): Promise<boolean>;
}

export interface MemoryCandidateSourceInput extends MemorySourceRefDto {
  readonly sourceScopeType: MemoryScopeType;
  readonly sourceScopeRef: ID;
  readonly sourceVisibility: Exclude<MemorySourceVisibility, 'local-only'>;
}

export interface ProposeCandidateInput {
  readonly teamId: ID;
  readonly sourceAgentId: ID;
  readonly sourceInvocationId: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: ID;
  readonly contentKind: MemoryContentKind;
  readonly proposedContent: string;
  readonly proposedSummary?: string;
  readonly sourceRefs: readonly MemoryCandidateSourceInput[];
}

export interface DecideInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly candidateId: ID;
}

export interface AcceptCandidateInput extends DecideInput {
  readonly kind: MemoryKind;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly validUntil?: UnixMs;
}

export interface MergeCandidateInput extends DecideInput {
  readonly conflictMemoryId: ID;
}

export interface MemoryCandidateView {
  readonly candidate: MemoryCandidateRecord;
  readonly sources: readonly MemorySourceRefDto[];
}

export interface MemoryCandidateService {
  proposeCandidate(input: ProposeCandidateInput): Promise<MemoryCandidateView>;
  acceptCandidate(input: AcceptCandidateInput): Promise<MemoryCandidateView>;
  rejectCandidate(input: DecideInput): Promise<MemoryCandidateView>;
  mergeCandidate(input: MergeCandidateInput): Promise<MemoryCandidateView>;
}

export interface MemoryCandidateServiceDeps {
  readonly unitOfWork: MemoryUnitOfWork;
  readonly permissions: MemoryCandidatePermissions;
  readonly clock: { now(): UnixMs };
  readonly ids: { nextId(): ID };
}

const ACTOR_SYSTEM: MemoryAuditActorKind = 'system';
const ACTOR_USER: MemoryAuditActorKind = 'user';

export function createMemoryCandidateService(deps: MemoryCandidateServiceDeps): MemoryCandidateService {
  const { unitOfWork, permissions, clock, ids } = deps;

  function nextUpdatedAt(now: UnixMs, currentUpdatedAt: UnixMs): UnixMs {
    return Math.max(now, currentUpdatedAt + 1);
  }

  function sourceRefDto(record: MemoryCandidateSourceRecord): MemorySourceRefDto {
    return { schemaVersion: 1, sourceKind: record.sourceKind, sourceId: record.sourceId, snapshotHash: record.snapshotHash };
  }

  async function appendAudit(
    memory: MemoryRepositories,
    record: Omit<MemoryAuditEventRecord, 'id' | 'teamId' | 'actorKind' | 'createdAt'> & {
      readonly teamId: ID;
      readonly actorId?: ID;
      readonly actorKind: MemoryAuditActorKind;
      readonly createdAt: UnixMs;
    },
  ): Promise<void> {
    await memory.auditEvents.append({ id: ids.nextId(), ...record });
  }

  async function loadCandidate(memory: MemoryRepositories, teamId: ID, candidateId: ID): Promise<MemoryCandidateRecord> {
    const candidate = await memory.candidates.getById({ teamId, id: candidateId });
    if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
    return candidate;
  }

  /** 来源冲突检测（§6.1）：candidate 来源与现有 active Memory 来源重叠即冲突。 */
  async function detectConflicts(
    memory: MemoryRepositories,
    candidateSources: readonly MemoryCandidateSourceRecord[],
    teamId: ID,
    excludedMemoryId?: ID,
  ): Promise<ID[]> {
    const conflicts = new Set<ID>();
    for (const ref of candidateSources) {
      const linked = await memory.sources.listBySource({
        teamId, sourceKind: ref.sourceKind, sourceId: ref.sourceId,
      });
      for (const source of linked) {
        if (source.memoryId === excludedMemoryId) continue;
        const item = await memory.items.getById({ teamId, id: source.memoryId });
        if (item?.status === 'active') conflicts.add(item.id);
      }
    }
    return [...conflicts];
  }

  /** 从 candidate 创建一条 active Memory（items + sources + tags + memory-created audit）。 */
  async function createActiveFromCandidate(
    memory: MemoryRepositories,
    candidate: MemoryCandidateRecord,
    candidateSources: readonly MemoryCandidateSourceRecord[],
    details: {
      readonly actorId: ID;
      readonly kind: MemoryKind;
      readonly summary?: string;
      readonly tags?: readonly string[];
      readonly validUntil?: UnixMs;
      readonly now: UnixMs;
    },
  ): Promise<MemoryItemRecord> {
    const id = ids.nextId();
    const created: MemoryItemRecord = {
      schemaVersion: 1,
      id,
      teamId: candidate.teamId,
      kind: details.kind,
      status: 'active',
      scopeType: candidate.scopeType,
      scopeRef: candidate.scopeRef,
      content: candidate.proposedContent,
      summary: details.summary,
      createdByUserId: details.actorId,
      approvedByUserId: details.actorId,
      validFrom: details.now,
      validUntil: details.validUntil,
      createdAt: details.now,
      updatedAt: details.now,
    };
    await memory.items.create(created);
    for (const ref of candidateSources) {
      const source: MemorySourceRecord = {
        memoryId: id,
        teamId: candidate.teamId,
        sourceKind: ref.sourceKind,
        sourceId: ref.sourceId,
        snapshotHash: ref.snapshotHash,
        sourceScopeType: ref.sourceScopeType,
        sourceScopeRef: ref.sourceScopeRef,
        sourceVisibility: ref.sourceVisibility,
        createdAt: details.now,
      };
      await memory.sources.create(source);
    }
    for (const tag of details.tags ?? []) {
      await memory.tags.create({ memoryId: id, teamId: candidate.teamId, tag, createdAt: details.now });
    }
    const refs = candidateSources.map(sourceRefDto);
    await appendAudit(memory, {
      teamId: candidate.teamId, subjectKind: 'memory', subjectId: id, eventType: 'memory-created',
      actorKind: ACTOR_USER, actorId: details.actorId, scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
      sourceRefs: refs, sourceRefsHash: hashSourceRefs(refs), contentHash: hashMemoryContent(created.content),
      createdAt: details.now,
    });
    return created;
  }

  function advanceCandidate(
    current: MemoryCandidateRecord,
    status: MemoryCandidateRecord['status'],
    actorId: ID,
    now: UnixMs,
    acceptedMemoryId: ID | undefined,
    mergedIntoMemoryId: ID | undefined,
  ): MemoryCandidateRecord {
    return {
      ...current,
      status,
      decidedAt: now,
      decidedBy: actorId,
      acceptedMemoryId: acceptedMemoryId ?? current.acceptedMemoryId,
      mergedIntoMemoryId: mergedIntoMemoryId ?? current.mergedIntoMemoryId,
      updatedAt: nextUpdatedAt(now, current.updatedAt),
    };
  }

  async function loadView(memory: MemoryRepositories, candidate: MemoryCandidateRecord): Promise<MemoryCandidateView> {
    const sources = await memory.candidateSources.listByCandidate({ teamId: candidate.teamId, candidateId: candidate.id });
    return { candidate, sources: sources.map(sourceRefDto) };
  }

  return {
    async proposeCandidate(input) {
      return unitOfWork.run(async (memory) => {
        await permissions.assertProposeAuthority({
          teamId: input.teamId, actorId: input.sourceAgentId,
          scopeType: input.scopeType, scopeRef: input.scopeRef,
        });
        const projectionHash = computeProjectionHash({
          proposedContent: input.proposedContent, sourceRefs: input.sourceRefs,
          scopeType: input.scopeType, scopeRef: input.scopeRef, contentKind: input.contentKind,
        });
        // 验收 #2：完全重复幂等返回已有 candidate，不产生重复 active Memory。
        const existing = await memory.candidates.findByProjectionHash({ teamId: input.teamId, projectionHash });
        if (existing) return loadView(memory, existing);

        const now = clock.now();
        const candidateId = ids.nextId();
        const candidateSources: MemoryCandidateSourceRecord[] = input.sourceRefs.map((ref) => ({
          candidateId, teamId: input.teamId, sourceKind: ref.sourceKind, sourceId: ref.sourceId,
          snapshotHash: ref.snapshotHash, sourceScopeType: ref.sourceScopeType, sourceScopeRef: ref.sourceScopeRef,
          sourceVisibility: ref.sourceVisibility, createdAt: now,
        }));
        const conflictMemoryIds = await detectConflicts(memory, candidateSources, input.teamId);
        const status: MemoryCandidateRecord['status'] = conflictMemoryIds.length > 0 ? 'conflict' : 'candidate';
        const candidate: MemoryCandidateRecord = {
          schemaVersion: 1,
          id: candidateId,
          teamId: input.teamId,
          managementRunId: input.managementRunId,
          taskId: input.taskId,
          sourceAgentId: input.sourceAgentId,
          sourceInvocationId: input.sourceInvocationId,
          scopeType: input.scopeType,
          scopeRef: input.scopeRef,
          contentKind: input.contentKind,
          proposedContent: input.proposedContent,
          projectionHash,
          status,
          conflictMemoryIds,
          createdAt: now,
          updatedAt: now,
        };
        await memory.candidates.create(candidate);
        for (const ref of candidateSources) await memory.candidateSources.create(ref);
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'candidate', subjectId: candidateId, eventType: 'candidate-created',
          actorKind: ACTOR_SYSTEM, actorId: input.sourceAgentId, scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
          sourceRefs: candidateSources.map(sourceRefDto), createdAt: now,
        });
        return loadView(memory, candidate);
      });
    },

    async acceptCandidate(input) {
      return unitOfWork.run(async (memory) => {
        await permissions.assertDecideAuthority(input);
        const candidate = await loadCandidate(memory, input.teamId, input.candidateId);
        const candidateSources = await memory.candidateSources.listByCandidate({
          teamId: input.teamId, candidateId: candidate.id,
        });
        // 防来源失效后 accept：每个来源须仍可用。
        for (const ref of candidateSources) {
          if (!(await permissions.isSourceAvailable({
            teamId: input.teamId, sourceKind: ref.sourceKind, sourceId: ref.sourceId,
          }))) throw new Error('CANDIDATE_SOURCE_UNAVAILABLE');
        }
        // 防来源冲突被静默接受：accept 只用于无冲突场景。
        const conflicts = await detectConflicts(memory, candidateSources, input.teamId);
        if (conflicts.length > 0) throw new Error('CANDIDATE_HAS_CONFLICT');
        const transition = evaluateCandidateTransition(candidate.status, 'accepted');
        if (!transition.ok) throw new Error('CANDIDATE_INVALID_TRANSITION');

        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
        });
        for (const ref of candidateSources) {
          await permissions.assertSourceAuthority({
            teamId: input.teamId, actorId: input.actorId,
            sourceScopeType: ref.sourceScopeType, sourceScopeRef: ref.sourceScopeRef,
            sourceVisibility: ref.sourceVisibility,
            targetScopeType: candidate.scopeType, targetScopeRef: candidate.scopeRef,
          });
        }

        const now = clock.now();
        const created = await createActiveFromCandidate(memory, candidate, candidateSources, {
          actorId: input.actorId, kind: input.kind, summary: input.summary,
          tags: input.tags, validUntil: input.validUntil, now,
        });
        const decided = advanceCandidate(candidate, 'accepted', input.actorId, now, created.id, undefined);
        await memory.candidates.update({ record: decided, expectedUpdatedAt: candidate.updatedAt });
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'candidate', subjectId: candidate.id, eventType: 'candidate-decided',
          actorKind: ACTOR_USER, actorId: input.actorId, scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
          sourceRefs: candidateSources.map(sourceRefDto), createdAt: now,
        });
        return loadView(memory, decided);
      });
    },

    async rejectCandidate(input) {
      return unitOfWork.run(async (memory) => {
        await permissions.assertDecideAuthority(input);
        const candidate = await loadCandidate(memory, input.teamId, input.candidateId);
        const transition = evaluateCandidateTransition(candidate.status, 'rejected');
        if (!transition.ok) throw new Error('CANDIDATE_INVALID_TRANSITION');
        const now = clock.now();
        const candidateSources = await memory.candidateSources.listByCandidate({
          teamId: input.teamId, candidateId: candidate.id,
        });
        const decided = advanceCandidate(candidate, 'rejected', input.actorId, now, undefined, undefined);
        await memory.candidates.update({ record: decided, expectedUpdatedAt: candidate.updatedAt });
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'candidate', subjectId: candidate.id, eventType: 'candidate-decided',
          actorKind: ACTOR_USER, actorId: input.actorId, scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
          sourceRefs: candidateSources.map(sourceRefDto), createdAt: now,
        });
        return loadView(memory, decided);
      });
    },

    async mergeCandidate(input) {
      return unitOfWork.run(async (memory) => {
        await permissions.assertDecideAuthority(input);
        const candidate = await loadCandidate(memory, input.teamId, input.candidateId);
        // 防越权：merge 目标必须在该 candidate 的冲突集合内。
        if (!candidate.conflictMemoryIds.includes(input.conflictMemoryId)) {
          throw new Error('CANDIDATE_CONFLICT_TARGET_INVALID');
        }
        const transition = evaluateCandidateTransition(candidate.status, 'merged');
        if (!transition.ok) throw new Error('CANDIDATE_INVALID_TRANSITION');
        const candidateSources = await memory.candidateSources.listByCandidate({
          teamId: input.teamId, candidateId: candidate.id,
        });

        const old = await memory.items.getById({ teamId: input.teamId, id: input.conflictMemoryId });
        if (!old || old.status !== 'active') throw new Error('MEMORY_INVALID_TRANSITION');
        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
        });
        for (const ref of candidateSources) {
          await permissions.assertSourceAuthority({
            teamId: input.teamId, actorId: input.actorId,
            sourceScopeType: ref.sourceScopeType, sourceScopeRef: ref.sourceScopeRef,
            sourceVisibility: ref.sourceVisibility,
            targetScopeType: candidate.scopeType, targetScopeRef: candidate.scopeRef,
          });
        }

        const now = clock.now();
        const created = await createActiveFromCandidate(memory, candidate, candidateSources, {
          actorId: input.actorId, kind: old.kind, summary: old.summary, tags: [], validUntil: old.validUntil, now,
        });
        // 取代旧 active：旧→superseded + 反向引用（对标 supersedeMemory 双写）。
        const superseded = await memory.items.update({
          record: { ...old, status: 'superseded', supersededById: created.id, updatedAt: now },
          expectedUpdatedAt: old.updatedAt,
        });
        if (!superseded) throw new Error('MEMORY_UPDATE_CONFLICT');

        const decided = advanceCandidate(candidate, 'merged', input.actorId, now, undefined, created.id);
        await memory.candidates.update({ record: decided, expectedUpdatedAt: candidate.updatedAt });
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'candidate', subjectId: candidate.id, eventType: 'candidate-decided',
          actorKind: ACTOR_USER, actorId: input.actorId, scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
          sourceRefs: candidateSources.map(sourceRefDto), createdAt: now,
        });
        return loadView(memory, decided);
      });
    },
  };
}

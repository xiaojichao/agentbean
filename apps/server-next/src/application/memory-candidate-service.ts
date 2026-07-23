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
  assessCandidateScopeExpansion,
  computeProjectionHash,
  evaluateCandidateTransition,
  hashMemoryContent,
  hashSourceRefs,
  type ScopeExpansionAssessment,
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
  /** Server-authenticated user whose current visibility authorizes the cited sources. */
  readonly sourceRequesterUserId?: ID;
  readonly sourceInvocationId: ID;
  readonly targetAgentId: ID;
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
  /**
   * 冲突选择（issue #719 / ADR-0048）：候选与同 scope 现有 active Memory 来源冲突时，
   * 默认 accept 会被拒绝（须走 merge=取代）；显式传 `'coexist'` 表示选择「二者并存」——
   * 建新 active 且旧冲突项保持 active，二者共存。取代走 `mergeCandidate`，故此处仅 coexist。
   */
  readonly conflictResolution?: 'coexist';
  /**
   * 作用域扩大确认（issue #719 / ADR-0007）：候选把来源证据写入比原始 scope 更宽的受众时，
   * accept 必须显式确认。未确认抛 `CANDIDATE_SCOPE_EXPANSION_REQUIRES_CONFIRMATION`。
   */
  readonly confirmScopeExpansion?: boolean;
}

export interface MergeCandidateInput extends DecideInput {
  readonly conflictMemoryId: ID;
  /** 作用域扩大确认（同 AcceptCandidateInput）。merge 同样建新 active，扩大须确认。 */
  readonly confirmScopeExpansion?: boolean;
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

  function sourceRefDto(
    record: Pick<MemoryCandidateSourceRecord, 'sourceKind' | 'sourceId' | 'snapshotHash'>,
  ): MemorySourceRefDto {
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
    return [...conflicts].sort();
  }

  /**
   * 评估候选是否涉及 scope expansion（ADR-0007）：任一来源 scope 比候选目标 scope 更窄/不同即扩大。
   * 返回纯策略评估，由 accept/merge 按 `confirmScopeExpansion` 决定是否放行。
   */
  function assessCandidateExpansion(
    candidate: MemoryCandidateRecord,
    candidateSources: readonly MemoryCandidateSourceRecord[],
  ): ScopeExpansionAssessment {
    return assessCandidateScopeExpansion({
      sources: candidateSources.map((source) => ({
        sourceScopeType: source.sourceScopeType,
        sourceScopeRef: source.sourceScopeRef,
      })),
      targetScopeType: candidate.scopeType,
      targetScopeRef: candidate.scopeRef,
    });
  }

  /** scope expansion 门禁：扩大且未显式确认 → 抛错，强制人工确认（AC#4）。 */
  function assertScopeExpansionConfirmed(
    expansion: ScopeExpansionAssessment,
    confirmed: boolean | undefined,
  ): void {
    if (expansion.isExpansion && confirmed !== true) {
      throw new Error('CANDIDATE_SCOPE_EXPANSION_REQUIRES_CONFIRMATION');
    }
  }

  async function assertSourcesAvailable(
    candidateSources: readonly MemoryCandidateSourceRecord[],
    teamId: ID,
  ): Promise<void> {
    for (const ref of candidateSources) {
      if (!(await permissions.isSourceAvailable({
        teamId, sourceKind: ref.sourceKind, sourceId: ref.sourceId,
      }))) throw new Error('CANDIDATE_SOURCE_UNAVAILABLE');
    }
  }

  async function assertSourceAuthorities(
    candidateSources: readonly MemoryCandidateSourceRecord[],
    input: {
      readonly teamId: ID;
      readonly actorId: ID;
      readonly targetScopeType: MemoryScopeType;
      readonly targetScopeRef: ID;
    },
  ): Promise<void> {
    for (const ref of candidateSources) {
      await permissions.assertSourceAuthority({
        teamId: input.teamId, actorId: input.actorId,
        sourceScopeType: ref.sourceScopeType, sourceScopeRef: ref.sourceScopeRef,
        sourceVisibility: ref.sourceVisibility,
        targetScopeType: input.targetScopeType, targetScopeRef: input.targetScopeRef,
      });
    }
  }

  async function assertNotDuplicate(
    memory: MemoryRepositories,
    input: Pick<MemoryItemRecord, 'teamId' | 'scopeType' | 'scopeRef' | 'kind' | 'content'>,
    excludedMemoryId?: ID,
  ): Promise<void> {
    const normalized = input.content.trim().replace(/\s+/g, ' ').toLowerCase();
    const existing = await memory.items.listByScope({
      teamId: input.teamId, scopeType: input.scopeType, scopeRef: input.scopeRef,
    });
    const clash = existing.some((item) =>
      item.id !== excludedMemoryId
      && (item.status === 'active' || item.status === 'candidate')
      && item.kind === input.kind
      && item.content.trim().replace(/\s+/g, ' ').toLowerCase() === normalized);
    if (clash) throw new Error('MEMORY_DUPLICATE_CONTENT');
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
      readonly excludedMemoryId?: ID;
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
    await assertNotDuplicate(memory, created, details.excludedMemoryId);
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
        for (const ref of input.sourceRefs) {
          await permissions.assertSourceAuthority({
            teamId: input.teamId, actorId: input.sourceRequesterUserId ?? input.sourceAgentId,
            sourceScopeType: ref.sourceScopeType, sourceScopeRef: ref.sourceScopeRef,
            sourceVisibility: ref.sourceVisibility,
            targetScopeType: input.scopeType, targetScopeRef: input.scopeRef,
          });
          if (!(await permissions.isSourceAvailable({
            teamId: input.teamId, sourceKind: ref.sourceKind, sourceId: ref.sourceId,
          }))) throw new Error('CANDIDATE_SOURCE_UNAVAILABLE');
        }
        const projectionHash = computeProjectionHash({
          proposedContent: input.proposedContent, sourceRefs: input.sourceRefs,
          scopeType: input.scopeType, scopeRef: input.scopeRef,
          targetAgentId: input.targetAgentId, contentKind: input.contentKind,
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
          targetAgentId: input.targetAgentId,
          scopeType: input.scopeType,
          scopeRef: input.scopeRef,
          contentKind: input.contentKind,
          proposedContent: input.proposedContent,
          proposedSummary: input.proposedSummary,
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
          targetAgentId: candidate.targetAgentId,
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
        await assertSourcesAvailable(candidateSources, input.teamId);
        // AC#4：scope expansion 须显式确认（ADR-0007）。
        assertScopeExpansionConfirmed(
          assessCandidateExpansion(candidate, candidateSources),
          input.confirmScopeExpansion,
        );
        // AC#5：来源冲突选择（ADR-0048）。默认 accept 拒绝冲突（须走 merge=取代）；
        // 显式 conflictResolution='coexist' 选择「二者并存」——建新 active 且旧冲突项保持 active。
        // 审计可推导（AC#8，不加 migration）：coexist 由 candidate.conflictMemoryIds 非空 + status=accepted
        //   + 无 memory-superseded 事件区分于取代（取代=merged + memory-superseded）；扩 scope 确认由
        //   candidate 目标 scope vs 来源 scope + candidate-decided 事件可重建。均不记录正文。
        const conflicts = await detectConflicts(memory, candidateSources, input.teamId);
        if (conflicts.length > 0 && input.conflictResolution !== 'coexist') {
          throw new Error('CANDIDATE_HAS_CONFLICT');
        }
        const transition = evaluateCandidateTransition(candidate.status, 'accepted');
        if (!transition.ok) throw new Error('CANDIDATE_INVALID_TRANSITION');
        if (!memoryKindMatchesContentKind(input.kind, candidate.contentKind)) {
          throw new Error('CANDIDATE_CONTENT_KIND_MISMATCH');
        }

        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
        });
        await assertSourceAuthorities(candidateSources, {
          teamId: input.teamId, actorId: input.actorId,
          targetScopeType: candidate.scopeType, targetScopeRef: candidate.scopeRef,
        });

        const now = nextUpdatedAt(clock.now(), candidate.updatedAt);
        const created = await createActiveFromCandidate(memory, candidate, candidateSources, {
          actorId: input.actorId, kind: input.kind, summary: input.summary ?? candidate.proposedSummary,
          tags: input.tags, validUntil: input.validUntil, now,
        });
        const decided = advanceCandidate(candidate, 'accepted', input.actorId, now, created.id, undefined);
        const updated = await memory.candidates.update({ record: decided, expectedUpdatedAt: candidate.updatedAt });
        if (!updated) throw new Error('CANDIDATE_UPDATE_CONFLICT');
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'candidate', subjectId: candidate.id, eventType: 'candidate-decided',
          actorKind: ACTOR_USER, actorId: input.actorId, scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
          targetAgentId: candidate.targetAgentId,
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
        const now = nextUpdatedAt(clock.now(), candidate.updatedAt);
        const candidateSources = await memory.candidateSources.listByCandidate({
          teamId: input.teamId, candidateId: candidate.id,
        });
        const decided = advanceCandidate(candidate, 'rejected', input.actorId, now, undefined, undefined);
        const updated = await memory.candidates.update({ record: decided, expectedUpdatedAt: candidate.updatedAt });
        if (!updated) throw new Error('CANDIDATE_UPDATE_CONFLICT');
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'candidate', subjectId: candidate.id, eventType: 'candidate-decided',
          actorKind: ACTOR_USER, actorId: input.actorId, scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
          targetAgentId: candidate.targetAgentId,
          sourceRefs: candidateSources.map(sourceRefDto), createdAt: now,
        });
        return loadView(memory, decided);
      });
    },

    async mergeCandidate(input) {
      return unitOfWork.run(async (memory) => {
        await permissions.assertDecideAuthority(input);
        const candidate = await loadCandidate(memory, input.teamId, input.candidateId);
        // 防越权：merge 目标必须在该 candidate 的原始冲突集合内。
        if (!candidate.conflictMemoryIds.includes(input.conflictMemoryId)) {
          throw new Error('CANDIDATE_CONFLICT_TARGET_INVALID');
        }
        const transition = evaluateCandidateTransition(candidate.status, 'merged');
        if (!transition.ok) throw new Error('CANDIDATE_INVALID_TRANSITION');
        const candidateSources = await memory.candidateSources.listByCandidate({
          teamId: input.teamId, candidateId: candidate.id,
        });
        await assertSourcesAvailable(candidateSources, input.teamId);
        // AC#4：scope expansion 须显式确认（ADR-0007）。merge 同样在候选 scope 建新 active。
        assertScopeExpansionConfirmed(
          assessCandidateExpansion(candidate, candidateSources),
          input.confirmScopeExpansion,
        );
        const currentConflicts = await detectConflicts(memory, candidateSources, input.teamId);
        if (currentConflicts.length !== 1 || currentConflicts[0] !== input.conflictMemoryId) {
          throw new Error('CANDIDATE_CONFLICT_SET_CHANGED');
        }

        const old = await memory.items.getById({ teamId: input.teamId, id: input.conflictMemoryId });
        if (!old || old.status !== 'active') throw new Error('MEMORY_INVALID_TRANSITION');
        if (!memoryKindMatchesContentKind(old.kind, candidate.contentKind)) {
          throw new Error('CANDIDATE_CONTENT_KIND_MISMATCH');
        }
        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
        });
        await permissions.assertWriteAuthority({
          teamId: input.teamId, actorId: input.actorId,
          scopeType: old.scopeType, scopeRef: old.scopeRef,
        });
        await assertSourceAuthorities(candidateSources, {
          teamId: input.teamId, actorId: input.actorId,
          targetScopeType: candidate.scopeType, targetScopeRef: candidate.scopeRef,
        });

        const now = Math.max(clock.now(), candidate.updatedAt + 1, old.updatedAt + 1);
        const oldTags = await memory.tags.listByMemory({ teamId: input.teamId, memoryId: old.id });
        const created = await createActiveFromCandidate(memory, candidate, candidateSources, {
          actorId: input.actorId, kind: old.kind,
          summary: candidate.proposedSummary ?? old.summary,
          tags: oldTags.map((tag) => tag.tag), validUntil: old.validUntil, now,
          excludedMemoryId: old.id,
        });
        // 取代旧 active：旧→superseded + 反向引用（对标 supersedeMemory 双写）。
        const superseded = await memory.items.update({
          record: { ...old, status: 'superseded', supersededById: created.id, updatedAt: now },
          expectedUpdatedAt: old.updatedAt,
        });
        if (!superseded) throw new Error('MEMORY_UPDATE_CONFLICT');
        const supersededSourceRefs = (await memory.sources.listByMemory({
          teamId: input.teamId, memoryId: superseded.id,
        })).map(sourceRefDto);
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'memory', subjectId: superseded.id,
          eventType: 'memory-superseded', actorKind: ACTOR_USER, actorId: input.actorId,
          scopeType: superseded.scopeType, scopeRef: superseded.scopeRef,
          sourceRefs: supersededSourceRefs, sourceRefsHash: hashSourceRefs(supersededSourceRefs),
          createdAt: now,
        });

        const decided = advanceCandidate(candidate, 'merged', input.actorId, now, undefined, created.id);
        const updated = await memory.candidates.update({ record: decided, expectedUpdatedAt: candidate.updatedAt });
        if (!updated) throw new Error('CANDIDATE_UPDATE_CONFLICT');
        await appendAudit(memory, {
          teamId: input.teamId, subjectKind: 'candidate', subjectId: candidate.id, eventType: 'candidate-decided',
          actorKind: ACTOR_USER, actorId: input.actorId, scopeType: candidate.scopeType, scopeRef: candidate.scopeRef,
          targetAgentId: candidate.targetAgentId,
          sourceRefs: candidateSources.map(sourceRefDto), createdAt: now,
        });
        return loadView(memory, decided);
      });
    },
  };
}

function memoryKindMatchesContentKind(kind: MemoryKind, contentKind: MemoryContentKind): boolean {
  if (contentKind === 'fact') return kind === 'semantic';
  if (contentKind === 'summary') return kind === 'episodic' || kind === 'artifact-summary';
  if (contentKind === 'procedure') return kind === 'procedural';
  return kind === contentKind;
}

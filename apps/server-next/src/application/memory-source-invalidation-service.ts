import type { ID, MemorySourceKind, UnixMs } from '../../../../packages/contracts/src/index.js';
import type {
  MemoryAuditActorKind,
  MemoryRepositories,
} from './memory-repositories.js';
import type { MemoryUnitOfWork } from './memory-unit-of-work.js';

/**
 * 来源失效处理（spec §16.4）。当 message / task 等来源记录被删除时，作为授权删除之后的
 * 反应式级联，把因此失去全部来源的 active/candidate memory 迁移到 `expired`，并写入
 * `system` 级审计。
 *
 * 设计约束：
 * - 这是删除级联，不是用户直接写入，因此不做 per-memory 权限重检（删除本身已校验
 *   isMember / 作者）；`teamId` 天然隔离，无跨 Team 泄漏。
 * - `memory_sources` 行是不可变的 provenance 记录（PR#577 冻结，无 delete），不反映"当前
 *   可用性"。本批来源直接视为不可用，其余来源通过 `isSourceAvailable` 回查当前事实源，保证
 *   跨多次删除后最后一个可用来源消失时也能主动过期。读取侧仍须用 `evaluateMemoryInjection`
 *   的 allSourcesAvailable 做最终 fail-closed 闸门。
 */

const ACTOR_SYSTEM: MemoryAuditActorKind = 'system';

export interface InvalidateSourcesInput {
  readonly teamId: ID;
  readonly sourceKind: MemorySourceKind;
  readonly sourceIds: readonly ID[];
  /** 触发删除的 actor，仅用于审计溯源（actorKind 仍为 system）。 */
  readonly actorId?: ID;
}

export interface MemorySourceInvalidationResult {
  readonly expiredMemoryIds: readonly ID[];
  readonly rejectedCandidateIds: readonly ID[];
}

export interface MemorySourceInvalidationDeps {
  readonly unitOfWork: MemoryUnitOfWork;
  readonly clock: { now(): UnixMs };
  readonly ids: { nextId(): ID };
  readonly isSourceAvailable: (input: {
    readonly teamId: ID;
    readonly sourceKind: MemorySourceKind;
    readonly sourceId: ID;
  }) => Promise<boolean>;
}

export interface MemorySourceInvalidationService {
  invalidateSources(input: InvalidateSourcesInput): Promise<MemorySourceInvalidationResult>;
}

export function createMemorySourceInvalidationService(
  deps: MemorySourceInvalidationDeps,
): MemorySourceInvalidationService {
  const { unitOfWork, clock, ids, isSourceAvailable } = deps;

  return {
    async invalidateSources(input) {
      return unitOfWork.run(async (memory) => {
        const invalidated = new Set(input.sourceIds);
        const affected = new Set<ID>();
        for (const sourceId of input.sourceIds) {
          const rows = await memory.sources.listBySource({
            teamId: input.teamId, sourceKind: input.sourceKind, sourceId,
          });
          for (const row of rows) affected.add(row.memoryId);
        }

        // Candidate 的决策要求每个来源仍可用。任一直接来源进入本批失效后，未决 Candidate
        // 已不可能安全 accept/merge；立即由 system 拒绝，避免重启后的 review snapshot 或
        // 幂等恢复重新把它暴露成待处理项。
        const affectedCandidateIds = new Set<ID>();
        for (const sourceId of input.sourceIds) {
          const rows = await memory.candidateSources.listBySource({
            teamId: input.teamId, sourceKind: input.sourceKind, sourceId,
          });
          for (const row of rows) affectedCandidateIds.add(row.candidateId);
        }
        const rejectedCandidates: ID[] = [];
        for (const candidateId of [...affectedCandidateIds].sort()) {
          const candidate = await memory.candidates.getById({ teamId: input.teamId, id: candidateId });
          if (!candidate || (candidate.status !== 'candidate' && candidate.status !== 'conflict')) continue;
          const sources = await memory.candidateSources.listByCandidate({
            teamId: input.teamId, candidateId,
          });
          const updatedAt = Math.max(clock.now(), candidate.updatedAt + 1);
          const updated = await memory.candidates.update({
            record: {
              ...candidate,
              status: 'rejected',
              decidedAt: updatedAt,
              decidedBy: 'system',
              updatedAt,
            },
            expectedUpdatedAt: candidate.updatedAt,
          });
          if (!updated) continue;
          await memory.auditEvents.append({
            id: ids.nextId(),
            teamId: input.teamId,
            subjectKind: 'candidate',
            subjectId: candidateId,
            eventType: 'candidate-decided',
            actorKind: ACTOR_SYSTEM,
            actorId: input.actorId,
            targetAgentId: candidate.targetAgentId,
            scopeType: candidate.scopeType,
            scopeRef: candidate.scopeRef,
            sourceRefs: sources.map((source) => ({
              schemaVersion: 1 as const,
              sourceKind: source.sourceKind,
              sourceId: source.sourceId,
              snapshotHash: source.snapshotHash,
            })),
            createdAt: updatedAt,
          });
          rejectedCandidates.push(candidateId);
        }

        const expired: ID[] = [];
        for (const memoryId of affected) {
          const item = await memory.items.getById({ teamId: input.teamId, id: memoryId });
          if (!item) continue;
          // 仅 active/candidate 可迁移；rejected/expired/superseded/deleted 已终态，跳过。
          if (item.status !== 'active' && item.status !== 'candidate') continue;

          const sources = await memory.sources.listByMemory({ teamId: input.teamId, memoryId });
          if (sources.length === 0) continue;
          // 本批来源已经失效；其余来源回查事实源，避免分次删除后旧 provenance 行永久挡住过期。
          const availability = await Promise.all(sources.map((source) =>
            source.sourceKind === input.sourceKind && invalidated.has(source.sourceId)
              ? false
              : isSourceAvailable({
                  teamId: input.teamId,
                  sourceKind: source.sourceKind,
                  sourceId: source.sourceId,
                }),
          ));
          if (availability.some(Boolean)) continue;

          const updatedAt = Math.max(clock.now(), item.updatedAt + 1);
          const updated = await memory.items.update({
            record: { ...item, status: 'expired', updatedAt },
            expectedUpdatedAt: item.updatedAt,
          });
          if (!updated) continue; // 并发改动：跳过，读取侧懒检查兜底。

          await memory.auditEvents.append({
            id: ids.nextId(),
            teamId: input.teamId,
            subjectKind: 'memory',
            subjectId: memoryId,
            eventType: 'memory-expired',
            actorKind: ACTOR_SYSTEM,
            actorId: input.actorId,
            scopeType: item.scopeType,
            scopeRef: item.scopeRef,
            sourceRefs: sources.map((source) => ({
              schemaVersion: 1 as const,
              sourceKind: source.sourceKind,
              sourceId: source.sourceId,
              snapshotHash: source.snapshotHash,
            })),
            createdAt: updatedAt,
          });
          expired.push(memoryId);
        }
        return { expiredMemoryIds: expired, rejectedCandidateIds: rejectedCandidates };
      });
    },
  };
}

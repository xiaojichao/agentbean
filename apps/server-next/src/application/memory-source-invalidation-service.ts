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
 *   可用性"。故本服务只能在**本批失效了某 memory 的全部来源**时主动过期；跨多次调用的
 *   部分失效不主动过期，交给读取侧懒检查（`evaluateMemoryInjection` 的 allSourcesAvailable，
 *   P3-05/13）兜底——那才是 §16.4「没有任何可用 source 则不得注入」的真正闸门。
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
}

export interface MemorySourceInvalidationDeps {
  readonly unitOfWork: MemoryUnitOfWork;
  readonly clock: { now(): UnixMs };
  readonly ids: { nextId(): ID };
}

export interface MemorySourceInvalidationService {
  invalidateSources(input: InvalidateSourcesInput): Promise<MemorySourceInvalidationResult>;
}

export function createMemorySourceInvalidationService(
  deps: MemorySourceInvalidationDeps,
): MemorySourceInvalidationService {
  const { unitOfWork, clock, ids } = deps;

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

        const expired: ID[] = [];
        for (const memoryId of affected) {
          const item = await memory.items.getById({ teamId: input.teamId, id: memoryId });
          if (!item) continue;
          // 仅 active/candidate 可迁移；rejected/expired/superseded/deleted 已终态，跳过。
          if (item.status !== 'active' && item.status !== 'candidate') continue;

          const sources = await memory.sources.listByMemory({ teamId: input.teamId, memoryId });
          if (sources.length === 0) continue;
          // 仅当本批失效了该 memory 的全部来源时才主动过期；还有任何来源（含跨 kind）则保留。
          const allCleared = sources.every(
            (source) => source.sourceKind === input.sourceKind && invalidated.has(source.sourceId),
          );
          if (!allCleared) continue;

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
        return { expiredMemoryIds: expired };
      });
    },
  };
}

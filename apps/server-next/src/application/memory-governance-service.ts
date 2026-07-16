import type {
  MemoryGovernanceCandidateDto,
  MemoryGovernanceCapsuleDto,
  MemoryGovernanceInvocationDto,
  MemoryGovernanceItemDto,
  MemoryGovernanceSnapshotDto,
  MemorySourceRefDto,
} from '../../../../packages/contracts/src/index.js';
import type { ServerNextRepositories } from './repositories.js';
import type { MemoryCandidateSourceRecord, MemorySourceRecord } from './memory-repositories.js';
import { canReadMemoryScope, isServerMemorySourceAvailable } from './server-memory-permissions.js';

export interface MemoryGovernanceService {
  getSnapshot(input: { teamId: string; userId: string }): Promise<MemoryGovernanceSnapshotDto>;
}

export function createMemoryGovernanceService(input: {
  repositories: ServerNextRepositories;
  clock: { now(): number };
}): MemoryGovernanceService {
  const { repositories, clock } = input;

  return {
    async getSnapshot(request) {
      const role = await repositories.teams.getMemberRole(request.teamId, request.userId);
      if (!role) throw new Error('MEMORY_PERMISSION_DENIED');
      const now = clock.now();
      const [allItems, allGrants, allCandidates, allCapsules] = await Promise.all([
        repositories.memory.items.listByTeam({ teamId: request.teamId }),
        repositories.memory.grants.listCurrentByTeam({ teamId: request.teamId }),
        repositories.memory.candidates.listByTeam({ teamId: request.teamId }),
        repositories.memory.capsuleRefs.listByTeam({ teamId: request.teamId }),
      ]);

      const visibleItems = [] as MemoryGovernanceItemDto[];
      for (const item of allItems) {
        if (!await canReadMemoryScope(repositories, {
          teamId: request.teamId,
          requesterUserId: request.userId,
          scopeType: item.scopeType,
          scopeRef: item.scopeRef,
        })) continue;
        const [tags, sources] = await Promise.all([
          repositories.memory.tags.listByMemory({ teamId: request.teamId, memoryId: item.id }),
          repositories.memory.sources.listByMemory({ teamId: request.teamId, memoryId: item.id }),
        ]);
        visibleItems.push({
          ...item,
          tags: tags.map((tag) => tag.tag),
          sourceRefs: sources.map(toSourceRef),
          sourceState: await sourceState(sources, now),
        });
      }

      const visibleCandidates = [] as MemoryGovernanceCandidateDto[];
      for (const candidate of allCandidates) {
        if (!await canReadMemoryScope(repositories, {
          teamId: request.teamId,
          requesterUserId: request.userId,
          scopeType: candidate.scopeType,
          scopeRef: candidate.scopeRef,
        })) continue;
        const sources = await repositories.memory.candidateSources.listByCandidate({
          teamId: request.teamId,
          candidateId: candidate.id,
        });
        visibleCandidates.push({
          schemaVersion: 1,
          id: candidate.id,
          teamId: candidate.teamId,
          managementRunId: candidate.managementRunId,
          taskId: candidate.taskId,
          sourceAgentId: candidate.sourceAgentId,
          sourceInvocationId: candidate.sourceInvocationId,
          targetAgentId: candidate.targetAgentId,
          sourceRefs: sources.map(toSourceRef),
          contentKind: candidate.contentKind,
          proposedContent: candidate.proposedContent,
          proposedSummary: candidate.proposedSummary,
          projectionHash: candidate.projectionHash,
          status: candidate.status,
          conflictMemoryIds: candidate.conflictMemoryIds,
          scopeType: candidate.scopeType,
          scopeRef: candidate.scopeRef,
          acceptedMemoryId: candidate.acceptedMemoryId,
          mergedIntoMemoryId: candidate.mergedIntoMemoryId,
          createdAt: candidate.createdAt,
          decidedAt: candidate.decidedAt,
          updatedAt: candidate.updatedAt,
          sourceState: await candidateSourceState(sources, now),
        });
      }

      const capsules = [] as MemoryGovernanceCapsuleDto[];
      for (const capsule of allCapsules) {
        const manifests = await repositories.memory.capsuleItems.listByCapsule({
          teamId: request.teamId,
          capsuleId: capsule.id,
        });
        const visible = await Promise.all(manifests.map((manifest) => canReadMemoryScope(repositories, {
          teamId: request.teamId,
          requesterUserId: request.userId,
          scopeType: manifest.scopeType,
          scopeRef: manifest.scopeRef,
        })));
        if (visible.some((allowed) => !allowed)) continue;
        capsules.push({
          schemaVersion: 1,
          id: capsule.id,
          teamId: capsule.teamId,
          managementRunId: capsule.managementRunId,
          taskId: capsule.taskId,
          targetAgentId: capsule.targetAgentId,
          contentHash: capsule.contentHash,
          authorizationDecisionId: capsule.authorizationDecisionId,
          expiresAt: capsule.expiresAt,
          state: capsule.deniedAt !== undefined ? 'revoked' : capsule.expiresAt <= now ? 'expired' : 'active',
          deniedAt: capsule.deniedAt,
          items: manifests.map((manifest) => ({
            memoryId: manifest.memoryId,
            position: manifest.position,
            scopeType: manifest.scopeType,
            scopeRef: manifest.scopeRef,
            contentKind: manifest.contentKind,
            redactionLevel: manifest.redactionLevel,
            authorization: manifest.authorization,
            expiresAt: manifest.expiresAt,
          })),
        });
      }

      const runIds = new Set([
        ...visibleCandidates.map((candidate) => candidate.managementRunId),
        ...capsules.map((capsule) => capsule.managementRunId),
      ]);
      const invocations = [] as MemoryGovernanceInvocationDto[];
      for (const runId of runIds) {
        const records = await repositories.management.invocations.listByRun(runId);
        for (const invocation of records) {
          if (invocation.intent.teamId !== request.teamId) continue;
          invocations.push({
            id: invocation.id,
            managementRunId: invocation.managementRunId,
            taskId: invocation.intent.taskContext?.taskId,
            targetAgentId: invocation.intent.targetAgentId,
            capsuleRef: invocation.intent.memoryCapsuleRef,
            createdAt: invocation.createdAt,
          });
        }
      }

      const grants = [];
      for (const grant of allGrants) {
        if (!await canReadMemoryScope(repositories, {
          teamId: request.teamId,
          requesterUserId: request.userId,
          scopeType: grant.sourceScopeType,
          scopeRef: grant.sourceScopeRef,
        })) continue;
        grants.push({ ...grant, status: grant.status === 'active' && grant.expiresAt <= now ? 'expired' as const : grant.status });
      }

      return {
        schemaVersion: 1,
        teamId: request.teamId,
        canManage: true,
        memories: visibleItems,
        grants,
        candidates: visibleCandidates,
        capsules,
        invocations: invocations.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)),
        refreshedAt: now,
      };
    },
  };

  async function sourceState(sources: readonly MemorySourceRecord[], now: number) {
    for (const source of sources) {
      if (!await isServerMemorySourceAvailable(repositories, source.teamId, source, now)) {
        return 'source-invalid' as const;
      }
    }
    return 'valid' as const;
  }

  async function candidateSourceState(sources: readonly MemoryCandidateSourceRecord[], now: number) {
    return sourceState(sources.map((source) => ({ ...source, memoryId: 'candidate-source-probe' })), now);
  }
}

function toSourceRef(source: Pick<MemorySourceRecord, 'sourceKind' | 'sourceId' | 'snapshotHash'>): MemorySourceRefDto {
  return { schemaVersion: 1, sourceKind: source.sourceKind, sourceId: source.sourceId, snapshotHash: source.snapshotHash };
}

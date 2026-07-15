import type { ID, MemoryScopeType, UnixMs } from '../../../../packages/contracts/src/index.js';
import {
  evaluateMemoryInjection,
  rankMemories,
  type MemoryRankingReason,
} from '../../../../packages/domain/src/index.js';
import type {
  MemoryGrantRecord,
  MemoryItemRecord,
  MemoryRepositories,
  MemorySourceRecord,
} from './memory-repositories.js';

export type MemoryScopeVisibility = 'visible' | 'explicit-grant' | 'hidden';

export interface MemorySearchPermissions {
  canSearchTeam(input: {
    readonly teamId: ID;
    readonly targetAgentId: ID;
  }): Promise<boolean>;
  evaluateScopeVisibility(input: {
    readonly teamId: ID;
    readonly targetAgentId: ID;
    readonly memoryId: ID;
    readonly scopeType: MemoryScopeType;
    readonly scopeRef: ID;
    readonly source?: MemorySourceRecord;
  }): Promise<MemoryScopeVisibility>;
  isSourceAvailable(input: {
    readonly teamId: ID;
    readonly targetAgentId: ID;
    readonly source: MemorySourceRecord;
  }): Promise<boolean>;
}

export interface CollaborativeMemorySearchServiceDeps {
  readonly repositories: MemoryRepositories;
  readonly permissions: MemorySearchPermissions;
}

export interface SearchCollaborativeMemoriesInput {
  readonly teamId: ID;
  readonly targetAgentId: ID;
  readonly taskId?: ID;
  readonly channelId?: ID;
  readonly userId?: ID;
  readonly prompt: string;
  readonly now: UnixMs;
  readonly limit: number;
  readonly expectedGrantVersions?: readonly { readonly id: ID; readonly version: number }[];
}

export type MemorySearchExclusionReason =
  | 'MEMORY_NOT_ACTIVE'
  | 'MEMORY_EXPIRED'
  | 'MEMORY_SCOPE_NOT_VISIBLE'
  | 'MEMORY_SOURCE_UNAVAILABLE'
  | 'MEMORY_GRANT_UNAVAILABLE'
  | 'MEMORY_GRANT_VERSION_STALE';

export interface CollaborativeMemorySearchMatch {
  readonly item: MemoryItemRecord;
  readonly sources: readonly MemorySourceRecord[];
  readonly tags: readonly string[];
  readonly accessMode: 'scope-policy' | 'explicit-grant';
  readonly grants: readonly MemoryGrantRecord[];
  readonly score: number;
  readonly reasons: readonly MemoryRankingReason[];
}

export interface CollaborativeMemorySearchResult {
  readonly matches: readonly CollaborativeMemorySearchMatch[];
  readonly excluded: readonly { readonly memoryId: ID; readonly reason: MemorySearchExclusionReason }[];
}

type AccessDecision =
  | { readonly allowed: true; readonly grant?: MemoryGrantRecord }
  | { readonly allowed: false; readonly reason: MemorySearchExclusionReason };

/** Hard authorization/source gates complete before any relevance score is calculated. */
export function createCollaborativeMemorySearchService(deps: CollaborativeMemorySearchServiceDeps) {
  return {
    async search(input: SearchCollaborativeMemoriesInput): Promise<CollaborativeMemorySearchResult> {
      if (!await deps.permissions.canSearchTeam({
        teamId: input.teamId,
        targetAgentId: input.targetAgentId,
      })) return { matches: [], excluded: [] };

      const currentGrants = await deps.repositories.grants.listCurrentForTarget({
        teamId: input.teamId,
        targetAgentId: input.targetAgentId,
      });
      const scopes = queryScopes(input, currentGrants);
      const itemLists = await Promise.all(scopes.map((scope) => deps.repositories.items.listByScope({
        teamId: input.teamId,
        ...scope,
      })));
      const candidates = [...new Map(itemLists.flat().map((item) => [item.id, item])).values()]
        .sort((left, right) => left.id.localeCompare(right.id));
      const eligible: Array<Omit<CollaborativeMemorySearchMatch, 'score' | 'reasons'>> = [];
      const excluded: Array<{ memoryId: ID; reason: MemorySearchExclusionReason }> = [];

      for (const item of candidates) {
        const baseDecision = evaluateMemoryInjection({
          status: item.status,
          validUntil: item.validUntil,
          now: input.now,
          scopeVisible: true,
          allSourcesAvailable: true,
        });
        if (!baseDecision.allowed) {
          excluded.push({ memoryId: item.id, reason: baseDecision.reason });
          continue;
        }

        const itemAccess = await resolveAccess(deps, input, item, item.scopeType, item.scopeRef, currentGrants);
        if (!itemAccess.allowed) {
          excluded.push({ memoryId: item.id, reason: itemAccess.reason });
          continue;
        }

        const sources = await deps.repositories.sources.listByMemory({ teamId: input.teamId, memoryId: item.id });
        const grants: MemoryGrantRecord[] = itemAccess.grant ? [itemAccess.grant] : [];
        let sourceFailure: MemorySearchExclusionReason | undefined;
        for (const source of sources) {
          if (!await deps.permissions.isSourceAvailable({
            teamId: input.teamId, targetAgentId: input.targetAgentId, source,
          })) {
            sourceFailure = 'MEMORY_SOURCE_UNAVAILABLE';
            break;
          }
          const access = await resolveAccess(
            deps, input, item, source.sourceScopeType, source.sourceScopeRef, currentGrants, source,
          );
          if (!access.allowed) {
            sourceFailure = access.reason;
            break;
          }
          const accessGrant = access.grant;
          if (accessGrant && !grants.some((grant) => grant.id === accessGrant.id)) grants.push(accessGrant);
        }
        if (sourceFailure) {
          excluded.push({ memoryId: item.id, reason: sourceFailure });
          continue;
        }

        const tags = await deps.repositories.tags.listByMemory({ teamId: input.teamId, memoryId: item.id });
        eligible.push({
          item,
          sources,
          tags: tags.map((tag) => tag.tag),
          accessMode: grants.length > 0 ? 'explicit-grant' : 'scope-policy',
          grants,
        });
      }

      const ranked = rankMemories(eligible.map((entry) => entry.item), input);
      const byId = new Map(eligible.map((entry) => [entry.item.id, entry]));
      return {
        matches: ranked.slice(0, normalizeLimit(input.limit)).map((rankedItem) => ({
          ...byId.get(rankedItem.candidate.id)!,
          score: rankedItem.score,
          reasons: rankedItem.reasons,
        })),
        excluded,
      };
    },
  };
}

async function resolveAccess(
  deps: CollaborativeMemorySearchServiceDeps,
  input: SearchCollaborativeMemoriesInput,
  item: MemoryItemRecord,
  scopeType: MemoryScopeType,
  scopeRef: ID,
  currentGrants: readonly MemoryGrantRecord[],
  source?: MemorySourceRecord,
): Promise<AccessDecision> {
  const visibility = await deps.permissions.evaluateScopeVisibility({
    teamId: input.teamId,
    targetAgentId: input.targetAgentId,
    memoryId: item.id,
    scopeType,
    scopeRef,
    source,
  });
  if (visibility === 'visible') return { allowed: true };
  if (visibility === 'hidden') return { allowed: false, reason: 'MEMORY_SCOPE_NOT_VISIBLE' };

  const matching = currentGrants.filter((grant) => grant.sourceScopeType === scopeType
    && grant.sourceScopeRef === scopeRef && grant.status === 'active' && grant.expiresAt > input.now);
  if (matching.length === 0) return { allowed: false, reason: 'MEMORY_GRANT_UNAVAILABLE' };
  const expected = input.expectedGrantVersions === undefined
    ? undefined
    : new Map(input.expectedGrantVersions.map((grant) => [grant.id, grant.version]));
  const grant = expected === undefined
    ? matching[0]
    : matching.find((candidate) => expected.get(candidate.id) === candidate.version);
  if (!grant) return { allowed: false, reason: 'MEMORY_GRANT_VERSION_STALE' };
  return { allowed: true, grant };
}

function queryScopes(
  input: SearchCollaborativeMemoriesInput,
  grants: readonly MemoryGrantRecord[],
): Array<{ scopeType: MemoryScopeType; scopeRef: ID }> {
  const scopes: Array<{ scopeType: MemoryScopeType; scopeRef: ID }> = [
    { scopeType: 'team', scopeRef: input.teamId },
    { scopeType: 'agent', scopeRef: input.targetAgentId },
  ];
  if (input.taskId) scopes.push({ scopeType: 'task', scopeRef: input.taskId });
  if (input.channelId) {
    scopes.push({ scopeType: 'channel', scopeRef: input.channelId });
    scopes.push({ scopeType: 'dm', scopeRef: input.channelId });
  }
  if (input.userId) scopes.push({ scopeType: 'user', scopeRef: input.userId });
  for (const grant of grants) {
    scopes.push({ scopeType: grant.sourceScopeType, scopeRef: grant.sourceScopeRef });
  }
  return [...new Map(scopes.map((scope) => [`${scope.scopeType}:${scope.scopeRef}`, scope])).values()];
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), 100);
}

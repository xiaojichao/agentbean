import type {
  ID,
  MemoryContentKind,
  MemoryScopeType,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
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
    readonly requesterUserId: ID;
    readonly targetAgentId: ID;
  }): Promise<boolean>;
  evaluateScopeVisibility(input: {
    readonly teamId: ID;
    readonly requesterUserId: ID;
    readonly targetAgentId: ID;
    readonly memoryId: ID;
    readonly scopeType: MemoryScopeType;
    readonly scopeRef: ID;
    readonly source?: MemorySourceRecord;
  }): Promise<MemoryScopeVisibility>;
  isSourceAvailable(input: {
    readonly teamId: ID;
    readonly requesterUserId: ID;
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
  readonly requesterUserId: ID;
  readonly targetAgentId: ID;
  readonly taskId?: ID;
  readonly channelId?: ID;
  readonly userId?: ID;
  readonly prompt: string;
  readonly now: UnixMs;
  readonly limit: number;
  /** Optional hard gate applied before relevance ranking and limit truncation. */
  readonly accessMode?: CollaborativeMemoryAccessMode;
  readonly expectedGrantVersions?: readonly { readonly id: ID; readonly version: number }[];
}

export type CollaborativeMemoryAccessMode = 'scope-policy' | 'explicit-grant';

export type MemorySearchExclusionReason =
  | 'MEMORY_NOT_ACTIVE'
  | 'MEMORY_EXPIRED'
  | 'MEMORY_SOURCE_UNAVAILABLE';

export interface CollaborativeMemorySearchMatch {
  readonly item: MemoryItemRecord;
  readonly sources: readonly MemorySourceRecord[];
  readonly tags: readonly string[];
  readonly accessMode: CollaborativeMemoryAccessMode;
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
  | { readonly allowed: false };

/** Hard authorization/source gates complete before any relevance score is calculated. */
export function createCollaborativeMemorySearchService(deps: CollaborativeMemorySearchServiceDeps) {
  return {
    async search(input: SearchCollaborativeMemoriesInput): Promise<CollaborativeMemorySearchResult> {
      if (!await deps.permissions.canSearchTeam({
        teamId: input.teamId,
        requesterUserId: input.requesterUserId,
        targetAgentId: input.targetAgentId,
      })) return { matches: [], excluded: [] };

      const currentGrants = await deps.repositories.grants.listCurrentForTarget({
        teamId: input.teamId,
        targetAgentId: input.targetAgentId,
      });
      const liveGrants = currentGrants.filter((grant) => grant.status === 'active'
        && grant.issuedAt <= input.now && grant.expiresAt > input.now);
      const scopes = queryScopes(input, liveGrants);
      const itemLists = await Promise.all(scopes.map((scope) => deps.repositories.items.listByScope({
        teamId: input.teamId,
        ...scope,
      })));
      const candidates = [...new Map(itemLists.flat().map((item) => [item.id, item])).values()]
        .sort((left, right) => left.id.localeCompare(right.id));
      const eligible: Array<Omit<CollaborativeMemorySearchMatch, 'score' | 'reasons'>> = [];
      const excluded: Array<{ memoryId: ID; reason: MemorySearchExclusionReason }> = [];

      for (const item of candidates) {
        const itemAccess = await resolveAccess(deps, input, item, item.scopeType, item.scopeRef, liveGrants);
        if (!itemAccess.allowed) continue;

        const sources = await deps.repositories.sources.listByMemory({ teamId: input.teamId, memoryId: item.id });
        const grants: MemoryGrantRecord[] = itemAccess.grant ? [itemAccess.grant] : [];
        let authorized = true;
        let sourceUnavailable = false;
        for (const source of sources) {
          const access = await resolveAccess(
            deps, input, item, source.sourceScopeType, source.sourceScopeRef, liveGrants, source,
          );
          if (!access.allowed) {
            authorized = false;
            break;
          }
          if (!await deps.permissions.isSourceAvailable({
            teamId: input.teamId,
            requesterUserId: input.requesterUserId,
            targetAgentId: input.targetAgentId,
            source,
          })) {
            sourceUnavailable = true;
            break;
          }
          const accessGrant = access.grant;
          if (accessGrant && !grants.some((grant) => grant.id === accessGrant.id)) grants.push(accessGrant);
        }
        if (!authorized) continue;
        if (sourceUnavailable) {
          excluded.push({ memoryId: item.id, reason: 'MEMORY_SOURCE_UNAVAILABLE' });
          continue;
        }

        const baseDecision = evaluateMemoryInjection({
          status: item.status,
          validUntil: item.validUntil,
          now: input.now,
          scopeVisible: true,
          allSourcesAvailable: true,
        });
        if (!baseDecision.allowed) {
          const reason = statusExclusionReason(baseDecision.reason);
          if (reason) excluded.push({ memoryId: item.id, reason });
          continue;
        }

        const projectedItem = projectAuthorizedItem(item, grants);
        if (!projectedItem) continue;

        const tags = await deps.repositories.tags.listByMemory({ teamId: input.teamId, memoryId: item.id });
        eligible.push({
          item: projectedItem,
          sources,
          tags: tags.map((tag) => tag.tag),
          accessMode: grants.length > 0 ? 'explicit-grant' : 'scope-policy',
          grants,
        });
      }

      const rankable = input.accessMode === undefined
        ? eligible
        : eligible.filter((entry) => entry.accessMode === input.accessMode);
      const ranked = rankMemories(rankable.map((entry) => entry.item), input);
      const byId = new Map(rankable.map((entry) => [entry.item.id, entry]));
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
    requesterUserId: input.requesterUserId,
    targetAgentId: input.targetAgentId,
    memoryId: item.id,
    scopeType,
    scopeRef,
    source,
  });
  if (visibility === 'visible') return { allowed: true };
  if (visibility === 'hidden') return { allowed: false };

  const matching = currentGrants.filter((grant) => grant.sourceScopeType === scopeType
    && grant.sourceScopeRef === scopeRef);
  if (matching.length === 0) return { allowed: false };
  const expected = input.expectedGrantVersions === undefined
    ? undefined
    : new Map(input.expectedGrantVersions.map((grant) => [grant.id, grant.version]));
  const grant = expected === undefined
    ? matching[0]
    : matching.find((candidate) => expected.get(candidate.id) === candidate.version);
  if (!grant) return { allowed: false };
  return { allowed: true, grant };
}

function projectAuthorizedItem(
  item: MemoryItemRecord,
  grants: readonly MemoryGrantRecord[],
): MemoryItemRecord | null {
  if (grants.length === 0) return item;
  if (grants.some((grant) => grant.authorizedRedactionLevel === 'sensitive-removed')) return null;

  const contentKind = memoryContentKind(item);
  if (grants.some((grant) => grant.authorizedContentKind !== 'summary'
    && grant.authorizedContentKind !== contentKind)) return null;
  const summaryOnly = grants.some((grant) => grant.authorizedContentKind === 'summary'
    || grant.authorizedRedactionLevel === 'summary-only');
  if (!summaryOnly) return item;

  const summary = item.summary?.trim();
  return summary ? { ...item, content: summary, summary } : null;
}

function memoryContentKind(item: MemoryItemRecord): MemoryContentKind {
  if (item.kind === 'decision') return 'decision';
  if (item.kind === 'preference') return 'preference';
  if (item.kind === 'procedural') return 'procedure';
  if (item.kind === 'artifact-summary') return 'summary';
  return 'fact';
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

function statusExclusionReason(reason: string): MemorySearchExclusionReason | undefined {
  if (reason === 'MEMORY_NOT_ACTIVE' || reason === 'MEMORY_EXPIRED') return reason;
  return undefined;
}

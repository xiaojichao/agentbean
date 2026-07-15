import type { MemoryKind, MemoryScopeType } from '@agentbean/contracts';

import { splitSearchTerms } from './search.js';

export interface MemoryRankingCandidate {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: string;
  readonly content: string;
  readonly summary?: string;
  readonly updatedAt: number;
}

export interface MemoryRankingContext {
  readonly teamId: string;
  readonly targetAgentId: string;
  readonly taskId?: string;
  readonly channelId?: string;
  readonly userId?: string;
  readonly prompt: string;
}

export type MemoryRankingReasonCode =
  | 'TASK_SCOPE_MATCH'
  | 'CHANNEL_SCOPE_MATCH'
  | 'TARGET_AGENT_SCOPE_MATCH'
  | 'USER_SCOPE_MATCH'
  | 'TEAM_SCOPE_MATCH'
  | 'MEMORY_KIND_PRIORITY'
  | 'PROMPT_TERM_MATCH';

export interface MemoryRankingReason {
  readonly code: MemoryRankingReasonCode;
  readonly score: number;
  readonly detail?: string;
}

export interface RankedMemory<T extends MemoryRankingCandidate = MemoryRankingCandidate> {
  readonly candidate: T;
  readonly score: number;
  readonly reasons: readonly MemoryRankingReason[];
}

const KIND_SCORES: Readonly<Partial<Record<MemoryKind, number>>> = {
  decision: 60,
  procedural: 50,
  preference: 50,
};

export function scoreMemoryRelevance(
  candidate: MemoryRankingCandidate,
  context: MemoryRankingContext,
): Pick<RankedMemory, 'score' | 'reasons'> {
  const reasons: MemoryRankingReason[] = [];

  if (candidate.scopeType === 'task' && candidate.scopeRef === context.taskId) {
    reasons.push({ code: 'TASK_SCOPE_MATCH', score: 400 });
  } else if (
    (candidate.scopeType === 'channel' || candidate.scopeType === 'dm')
    && candidate.scopeRef === context.channelId
  ) {
    reasons.push({ code: 'CHANNEL_SCOPE_MATCH', score: 300 });
  } else if (candidate.scopeType === 'agent' && candidate.scopeRef === context.targetAgentId) {
    reasons.push({ code: 'TARGET_AGENT_SCOPE_MATCH', score: 200 });
  } else if (candidate.scopeType === 'user' && candidate.scopeRef === context.userId) {
    reasons.push({ code: 'USER_SCOPE_MATCH', score: 150 });
  } else if (candidate.scopeType === 'team' && candidate.scopeRef === context.teamId) {
    reasons.push({ code: 'TEAM_SCOPE_MATCH', score: 100 });
  }

  const kindScore = KIND_SCORES[candidate.kind] ?? 0;
  if (kindScore > 0) reasons.push({ code: 'MEMORY_KIND_PRIORITY', score: kindScore, detail: candidate.kind });

  const terms = splitSearchTerms(context.prompt);
  if (terms.length > 0) {
    const haystack = `${candidate.summary ?? ''}\n${candidate.content}`.toLowerCase();
    const matched = terms.filter((term) => haystack.includes(term)).length;
    if (matched > 0) {
      reasons.push({ code: 'PROMPT_TERM_MATCH', score: matched * 20, detail: `${matched}/${terms.length}` });
    }
  }

  return {
    score: reasons.reduce((total, reason) => total + reason.score, 0),
    reasons,
  };
}

export function rankMemories<T extends MemoryRankingCandidate>(
  candidates: readonly T[],
  context: MemoryRankingContext,
): RankedMemory<T>[] {
  return candidates
    .map((candidate) => ({ candidate, ...scoreMemoryRelevance(candidate, context) }))
    .sort((left, right) => right.score - left.score
      || right.candidate.updatedAt - left.candidate.updatedAt
      || left.candidate.id.localeCompare(right.candidate.id));
}

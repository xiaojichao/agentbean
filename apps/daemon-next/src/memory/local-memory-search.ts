import type { LocalMemoryStore } from './local-memory-store.js';
import type { LocalMemoryItem } from './types.js';
import { workspaceCwdHash } from './workspace-identity.js';
import { sanitizeProfileId } from '../profile-paths.js';

export interface ListLocalMemoriesForDispatchInput {
  readonly store: LocalMemoryStore;
  readonly profileId: string;
  readonly cwd?: string;
  readonly agentId?: string;
  readonly prompt: string;
  readonly limit?: number;
  readonly tokenBudget?: number;
  readonly now?: number;
}

export function listLocalMemoriesForDispatch(
  input: ListLocalMemoriesForDispatchInput,
): readonly LocalMemoryItem[] {
  const now = input.now ?? Date.now();
  const cwdHash = input.cwd ? workspaceCwdHash(input.cwd) : undefined;
  const terms = splitTerms(input.prompt);
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  let remainingTokens = Math.min(8_000, Math.max(1, input.tokenBudget ?? 1_600));
  const ranked = input.store.listActive(now)
    .filter((item) => item.profileId === sanitizeProfileId(input.profileId))
    .filter((item) => isVisible(item, cwdHash, input.agentId))
    .map((item) => ({ item, score: score(item, terms, cwdHash, now) }))
    .sort((left, right) => right.score - left.score
      || right.item.updatedAt - left.item.updatedAt
      || left.item.id.localeCompare(right.item.id));
  const selected: LocalMemoryItem[] = [];
  for (const { item } of ranked) {
    if (selected.length >= limit) break;
    const cost = estimateTokens(item.summary ?? item.content);
    if (cost > remainingTokens) continue;
    remainingTokens -= cost;
    selected.push(item);
  }
  return selected;
}

function isVisible(item: LocalMemoryItem, cwdHash: string | undefined, agentId: string | undefined): boolean {
  if (item.scopeType === 'local-workspace') return Boolean(cwdHash && item.cwdHash === cwdHash);
  if (item.scopeType === 'local-agent') return Boolean(agentId && item.agentId === agentId);
  return item.scopeType === 'local-profile';
}

function score(item: LocalMemoryItem, terms: readonly string[], cwdHash: string | undefined, now: number): number {
  const scopeScore = item.scopeType === 'local-workspace' ? 3_000
    : item.scopeType === 'local-agent' ? 2_000 : 1_000;
  const kindScore = item.kind === 'procedural' ? 40
    : item.kind === 'preference' || item.kind === 'decision' ? 35 : 10;
  const sourceScore = item.sourceKind === 'manual' ? 30
    : item.sourceKind === 'scan' ? 20
      : item.sourceKind === 'workspace_run' ? 10 : 5;
  const haystack = `${item.summary ?? ''}\n${item.content}\n${item.structured?.tags?.join(' ') ?? ''}`.toLowerCase();
  const termScore = terms.reduce((total, term) => total + (haystack.includes(term) ? 25 : 0), 0);
  const workspaceBonus = cwdHash && item.cwdHash === cwdHash ? 50 : 0;
  const ageDays = Math.max(0, Math.floor((now - item.updatedAt) / 86_400_000));
  return scopeScore + kindScore + sourceScore + termScore + workspaceBonus + Math.max(0, 30 - ageDays);
}

function splitTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))].slice(0, 20);
}

function estimateTokens(value: string): number {
  const nonAscii = value.match(/[^\x00-\x7f]/g)?.length ?? 0;
  return Math.max(1, nonAscii + Math.ceil((value.length - nonAscii) / 4));
}

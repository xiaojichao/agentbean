export interface SearchableMessage {
  body: string;
  createdAt: number;
}

/**
 * Split a free-text query into normalized search terms (lowercased, whitespace-split, non-empty).
 * Multi-word queries require every term to be present (AND semantics).
 */
export function splitSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

export function messageMatchesAllTerms(body: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const lower = body.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

/**
 * Score a message against search terms. Higher is more relevant.
 * - Phrase match (terms contiguous, in order) gets a large bonus.
 * - Each term gets a word-boundary bonus and an earlier-position bonus.
 * Returns -1 if any term is missing (caller should pre-filter, but this is defensive).
 */
export function scoreMessageSearch(message: SearchableMessage, terms: string[]): number {
  const lower = message.body.toLowerCase();
  let score = 0;
  if (terms.length > 1 && lower.includes(terms.join(' '))) {
    score += 1000;
  }
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx < 0) {
      return -1;
    }
    const preceding = idx > 0 ? (lower[idx - 1] ?? '') : '';
    const atWordBoundary = idx === 0 || !/\w/.test(preceding);
    if (atWordBoundary) {
      score += 50;
    }
    // Earlier match position ranks higher (diminishing returns).
    score += Math.max(0, 30 - Math.floor(idx / 10));
  }
  return score;
}

/**
 * Rank messages by relevance to the query: keep only messages containing every term,
 * sort by relevance score (phrase > word-boundary > earlier position), break ties by
 * recency (newer first), and return the top `limit`.
 */
export function rankMessageSearch<T extends SearchableMessage>(messages: T[], query: string, limit: number): T[] {
  const terms = splitSearchTerms(query);
  if (terms.length === 0) {
    return [];
  }
  return messages
    .filter((message) => messageMatchesAllTerms(message.body, terms))
    .map((message) => ({ message, score: scoreMessageSearch(message, terms) }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.message.createdAt - left.message.createdAt;
    })
    .slice(0, limit)
    .map((entry) => entry.message);
}

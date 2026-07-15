import { describe, expect, test } from 'vitest';

import {
  rankMemories,
  scoreMemoryRelevance,
  type MemoryRankingCandidate,
} from '../src/index.js';

const candidate = (overrides: Partial<MemoryRankingCandidate> = {}): MemoryRankingCandidate => ({
  id: 'memory-1',
  kind: 'semantic',
  scopeType: 'team',
  scopeRef: 'team-1',
  content: 'Use Node 24 for native modules',
  updatedAt: 100,
  ...overrides,
});

describe('Phase 3 Memory deterministic ranking', () => {
  test('orders exact Task, Channel and target Agent scopes before Team scope', () => {
    const ranked = rankMemories([
      candidate({ id: 'team', scopeType: 'team', scopeRef: 'team-1' }),
      candidate({ id: 'agent', scopeType: 'agent', scopeRef: 'agent-1' }),
      candidate({ id: 'channel', scopeType: 'channel', scopeRef: 'channel-1' }),
      candidate({ id: 'task', scopeType: 'task', scopeRef: 'task-1' }),
    ], {
      teamId: 'team-1',
      taskId: 'task-1',
      channelId: 'channel-1',
      targetAgentId: 'agent-1',
      prompt: '',
    });

    expect(ranked.map((entry) => entry.candidate.id)).toEqual(['task', 'channel', 'agent', 'team']);
    expect(ranked[0]?.reasons).toContainEqual({ code: 'TASK_SCOPE_MATCH', score: 400 });
  });

  test('uses prompt terms as a bonus, not a hard filter', () => {
    const scored = scoreMemoryRelevance(candidate(), {
      teamId: 'team-1', targetAgentId: 'agent-1', prompt: 'node missing',
    });

    expect(scored.reasons).toContainEqual({ code: 'PROMPT_TERM_MATCH', score: 20, detail: '1/2' });
    expect(scored.score).toBeGreaterThan(0);
  });

  test('breaks equal scores by updatedAt descending then id ascending', () => {
    const ranked = rankMemories([
      candidate({ id: 'z', updatedAt: 100 }),
      candidate({ id: 'b', updatedAt: 200 }),
      candidate({ id: 'a', updatedAt: 200 }),
    ], { teamId: 'team-1', targetAgentId: 'agent-1', prompt: '' });

    expect(ranked.map((entry) => entry.candidate.id)).toEqual(['a', 'b', 'z']);
  });
});

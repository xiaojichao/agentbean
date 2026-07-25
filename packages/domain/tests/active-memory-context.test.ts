import { describe, expect, test } from 'vitest';

import type {
  ActiveMemoryCandidate,
  // 通过 index 间接验证类型可构造
} from '../src/active-memory-context.js';
import {
  assembleActiveMemoryContext,
  buildAttribution,
  candidateToContextItem,
  computeActiveMemoryContextHash,
} from '../src/index.js';

import type { ActiveMemoryProvenanceDto } from '@agentbean/contracts';

function makeCandidate(
  id: string,
  over: Partial<ActiveMemoryCandidate> = {},
): ActiveMemoryCandidate {
  const provenance: ActiveMemoryProvenanceDto = over.provenance ?? {
    source: 'team_formal_memory',
    memoryId: id,
    formalKind: 'decision',
  };
  return {
    id,
    kind: 'decision',
    scopeType: 'team',
    content: `content-${id}`,
    status: 'active',
    provenance,
    selectionReason: 'current_team_policy',
    scopeVisible: true,
    allSourcesAvailable: true,
    relevanceScore: 0,
    ...over,
  };
}

describe('Active Memory Context assembly (issue #720)', () => {
  const NOW = 1_700_000_000_000;

  describe('hard gates (AC#2 每次校验 / AC#3 默认不可见)', () => {
    test('status !== active → excluded MEMORY_NOT_ACTIVE (未批准 Candidate 不可见)', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [makeCandidate('c1', { status: 'candidate' })],
      });
      expect(result.context.items).toHaveLength(0);
      expect(result.excluded).toEqual([
        { id: 'c1', source: 'team_formal_memory', reason: 'MEMORY_NOT_ACTIVE' },
      ]);
    });

    test('validUntil <= now → excluded MEMORY_EXPIRED', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [makeCandidate('c1', { validUntil: NOW - 1 })],
      });
      expect(result.excluded[0].reason).toBe('MEMORY_EXPIRED');
      expect(result.context.items).toHaveLength(0);
    });

    test('scopeVisible=false → excluded MEMORY_SCOPE_NOT_VISIBLE (跨 Team/频道不可见)', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [makeCandidate('c1', { scopeVisible: false })],
      });
      expect(result.excluded[0].reason).toBe('MEMORY_SCOPE_NOT_VISIBLE');
    });

    test('allSourcesAvailable=false → excluded MEMORY_SOURCE_UNAVAILABLE', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [makeCandidate('c1', { allSourcesAvailable: false })],
      });
      expect(result.excluded[0].reason).toBe('MEMORY_SOURCE_UNAVAILABLE');
    });

    test('excluded 带 source（从 provenance.source 提取，可观测）', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [
          makeCandidate('c1', {
            status: 'candidate',
            provenance: { source: 'channel_formal_memory', memoryId: 'c1', formalKind: 'rule' },
          }),
        ],
      });
      expect(result.excluded[0].source).toBe('channel_formal_memory');
    });
  });

  describe('ranking + truncation (AC#1 少量)', () => {
    test('按 relevanceScore 降序选取，截断到 limit', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 2,
        candidates: [
          makeCandidate('low', { relevanceScore: 10 }),
          makeCandidate('high', { relevanceScore: 500 }),
          makeCandidate('mid', { relevanceScore: 200 }),
        ],
      });
      expect(result.context.items.map((i) => i.id)).toEqual(['high', 'mid']);
      expect(result.context.items).toHaveLength(2);
    });

    test('limit 大于候选数时全部入选', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 10,
        candidates: [makeCandidate('a'), makeCandidate('b')],
      });
      expect(result.context.items).toHaveLength(2);
    });
  });

  describe('idempotency (AC#7 重放可重复)', () => {
    test('相同候选不同顺序 → 相同 contextHash', () => {
      const base = [makeCandidate('a', { relevanceScore: 100 }), makeCandidate('b', { relevanceScore: 100 })];
      const r1 = assembleActiveMemoryContext({ now: NOW, limit: 5, candidates: base });
      const r2 = assembleActiveMemoryContext({ now: NOW, limit: 5, candidates: [...base].reverse() });
      expect(r1.context.contextHash).toBe(r2.context.contextHash);
    });

    test('相同输入 → 相同 attribution.contextHash 与 context.contextHash 对齐', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [makeCandidate('a'), makeCandidate('b')],
      });
      expect(result.attribution.contextHash).toBe(result.context.contextHash);
    });

    test('空候选 → 确定性 hash（重放稳定）', () => {
      const r1 = assembleActiveMemoryContext({ now: NOW, limit: 5, candidates: [] });
      const r2 = assembleActiveMemoryContext({ now: NOW, limit: 5, candidates: [] });
      expect(r1.context.contextHash).toBe(r2.context.contextHash);
      expect(r1.context.items).toHaveLength(0);
    });
  });

  describe('attribution (AC#5 只存 ID/来源/理由，不存正文)', () => {
    test('entries 含 id+source+selectionReason，无 content 字段', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [makeCandidate('a'), makeCandidate('b')],
      });
      for (const entry of result.attribution.entries) {
        expect(entry).toEqual(
          expect.objectContaining({ id: expect.any(String), source: expect.any(String), selectionReason: expect.any(String) }),
        );
        expect((entry as { content?: unknown }).content).toBeUndefined();
      }
    });

    test('context.items.content 不进 attribution', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [makeCandidate('a', { content: 'SECRET-CONTENT' })],
      });
      const serialized = JSON.stringify(result.attribution);
      expect(serialized).not.toContain('SECRET-CONTENT');
    });
  });

  describe('forward-compatible reserved source (experience_pack)', () => {
    test('experience_pack provenance 的候选走正常门禁，不被特殊拒绝', () => {
      const result = assembleActiveMemoryContext({
        now: NOW,
        limit: 5,
        candidates: [
          makeCandidate('pack1', {
            provenance: { source: 'experience_pack', packId: 'pack1' },
            selectionReason: 'linked_experience_pack',
          }),
        ],
      });
      // active + 可见 + 来源可用 → 应入选（前向兼容，切片 E 建模后 resolver 才产出）
      expect(result.context.items.map((i) => i.id)).toEqual(['pack1']);
      expect(result.excluded).toHaveLength(0);
    });
  });

  describe('helpers', () => {
    test('computeActiveMemoryContextHash 顺序无关', () => {
      const a = candidateToContextItem(makeCandidate('a'));
      const b = candidateToContextItem(makeCandidate('b'));
      expect(computeActiveMemoryContextHash([a, b])).toBe(computeActiveMemoryContextHash([b, a]));
    });

    test('buildAttribution entries 投影 source', () => {
      const item = candidateToContextItem(makeCandidate('a'));
      const attr = buildAttribution([item], 'hash-x');
      expect(attr.entries[0].source).toBe('team_formal_memory');
      expect(attr.contextHash).toBe('hash-x');
    });
  });
});

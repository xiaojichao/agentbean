import { describe, expect, test } from 'vitest';

import {
  AGENT_MEMORY_PROJECTION_ERROR,
  evaluateProjectionPublishWindow,
  evaluateTeamAgentMemoryOptIn,
  parseAgentMemoryProjectionContent,
} from '../src/agent-memory-projection-policy.js';

describe('parseAgentMemoryProjectionContent', () => {
  test('accepts minimal valid content (fact kind, content only)', () => {
    const result = parseAgentMemoryProjectionContent({ kind: 'fact', content: 'Agent reviews PRs on weekdays.' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.kind).toBe('fact');
      expect(result.content.content).toBe('Agent reviews PRs on weekdays.');
      expect(result.content.summary).toBeUndefined();
      expect(result.content.tags).toEqual([]);
      expect(result.content.sourceRefs).toEqual([]);
      expect(result.content.validUntil).toBeNull();
    }
  });

  test('accepts all four formal kinds', () => {
    for (const kind of ['fact', 'decision', 'rule', 'preference'] as const) {
      const result = parseAgentMemoryProjectionContent({ kind, content: 'c' });
      expect(result.ok).toBe(true);
    }
  });

  test('rejects non-formal kind (AC#1: projection content is product-typed)', () => {
    const result = parseAgentMemoryProjectionContent({ kind: 'episodic', content: 'c' });
    expect(result).toEqual({ ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_KIND, message: expect.any(String) });
  });

  test('rejects missing kind', () => {
    const result = parseAgentMemoryProjectionContent({ content: 'c' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_MEMORY_PROJECTION_ERROR.INVALID_KIND);
  });

  test('rejects empty / whitespace-only / non-string content', () => {
    expect(parseAgentMemoryProjectionContent({ kind: 'fact', content: '' }).ok).toBe(false);
    expect(parseAgentMemoryProjectionContent({ kind: 'fact', content: '   ' }).ok).toBe(false);
    expect(parseAgentMemoryProjectionContent({ kind: 'fact', content: 42 }).ok).toBe(false);
  });

  test('rejects over-long content and summary', () => {
    const tooLong = parseAgentMemoryProjectionContent({ kind: 'fact', content: 'x'.repeat(20000) });
    expect(tooLong.ok).toBe(false);
    const longSummary = parseAgentMemoryProjectionContent({ kind: 'fact', content: 'ok', summary: 'y'.repeat(2000) });
    expect(longSummary.ok).toBe(false);
  });

  test('sanitizes and validates tags (lowercase, dedupe, a-z0-9-)', () => {
    const result = parseAgentMemoryProjectionContent({
      kind: 'rule', content: 'c', tags: ['Code-Review', 'code-review', 'lint', 'a-b'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 合法 tag 折叠为小写并去重（'Code-Review' 与 'code-review' 合并）
      expect(result.content.tags).toEqual(['code-review', 'lint', 'a-b']);
    }
  });

  test('rejects tag array with any invalid entry (fail-closed: space / uppercase-only / leading-trailing-double dash)', () => {
    // fail-closed：任一非法 tag 整条拒绝，不静默过滤或截断（与 memory_tags DB CHECK 一致）
    // 注意：'UPPER' 会被 normalize 成 'upper'（大小写不敏感），属合法输入，故不在此列。
    const cases = ['has space', '-leading', 'trailing-', 'double--dash', 'un der', 'spec!al'];
    for (const bad of cases) {
      const result = parseAgentMemoryProjectionContent({ kind: 'fact', content: 'c', tags: ['ok', bad] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(AGENT_MEMORY_PROJECTION_ERROR.INVALID_TAG);
    }
  });

  test('accepts well-formed sourceRefs', () => {
    const result = parseAgentMemoryProjectionContent({
      kind: 'decision', content: 'c',
      sourceRefs: [{ schemaVersion: 1, sourceKind: 'manual', sourceId: 'm1', snapshotHash: 'sha256:x' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.sourceRefs).toHaveLength(1);
  });

  test('rejects malformed sourceRefs (fail-closed)', () => {
    const result = parseAgentMemoryProjectionContent({
      kind: 'decision', content: 'c',
      sourceRefs: [{ sourceKind: 'manual', sourceId: 'm1' /* missing snapshotHash */ }] as never,
    });
    expect(result.ok).toBe(false);
  });

  test('rejects validUntil not after validFrom', () => {
    const result = parseAgentMemoryProjectionContent({
      kind: 'fact', content: 'c', validFrom: 1000, validUntil: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_MEMORY_PROJECTION_ERROR.INVALID_VALIDITY);
  });

  test('validUntil null means long-lived', () => {
    const result = parseAgentMemoryProjectionContent({ kind: 'fact', content: 'c', validUntil: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.validUntil).toBeNull();
  });
});

describe('evaluateProjectionPublishWindow', () => {
  test('accepts when validUntil is null (long-lived)', () => {
    expect(evaluateProjectionPublishWindow({ validFrom: 100, validUntil: null, now: 500 }).ok).toBe(true);
  });

  test('accepts when validUntil is in the future', () => {
    expect(evaluateProjectionPublishWindow({ validFrom: 100, validUntil: 1000, now: 500 }).ok).toBe(true);
  });

  test('rejects when validUntil already expired at publish time', () => {
    const result = evaluateProjectionPublishWindow({ validFrom: 100, validUntil: 400, now: 500 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_MEMORY_PROJECTION_ERROR.INVALID_VALIDITY);
  });

  test('rejects when validUntil equals now (boundary, already expired)', () => {
    expect(evaluateProjectionPublishWindow({ validFrom: 100, validUntil: 500, now: 500 }).ok).toBe(false);
  });
});

describe('evaluateTeamAgentMemoryOptIn (AC#3/AC#5/AC#7 fail-closed)', () => {
  test('no opt-in record → not consumable (default opted-out)', () => {
    const result = evaluateTeamAgentMemoryOptIn({ activeProjectionId: 'p1', optIn: null });
    expect(result.consumable).toBe(false);
  });

  test('opt-in enabled and projectionId matches active → consumable', () => {
    const result = evaluateTeamAgentMemoryOptIn({
      activeProjectionId: 'p1',
      optIn: { projectionId: 'p1', enabled: true },
    });
    expect(result.consumable).toBe(true);
  });

  test('opt-in disabled → not consumable', () => {
    const result = evaluateTeamAgentMemoryOptIn({
      activeProjectionId: 'p1',
      optIn: { projectionId: 'p1', enabled: false },
    });
    expect(result.consumable).toBe(false);
  });

  test('opt-in projectionId mismatch (revision fence broken) → not consumable (AC#7)', () => {
    // projection superseded by new active p2, but optIn still fences p1 → fail-closed
    const result = evaluateTeamAgentMemoryOptIn({
      activeProjectionId: 'p2',
      optIn: { projectionId: 'p1', enabled: true },
    });
    expect(result.consumable).toBe(false);
  });

  test('no active projection → not consumable even if opt-in exists', () => {
    const result = evaluateTeamAgentMemoryOptIn({
      activeProjectionId: null,
      optIn: { projectionId: 'p1', enabled: true },
    });
    expect(result.consumable).toBe(false);
  });
});

import { describe, expect, test } from 'vitest';

import type { MemoryCandidateStatus, MemorySourceRefDto } from '@agentbean/contracts';

import { computeProjectionHash, evaluateCandidateTransition } from '../src/index.js';

describe('Phase 3 Memory Candidate policy', () => {
  describe('evaluateCandidateTransition', () => {
    const VALID: ReadonlyArray<[MemoryCandidateStatus, MemoryCandidateStatus]> = [
      ['candidate', 'accepted'],
      ['candidate', 'rejected'],
      ['candidate', 'merged'],
      ['candidate', 'conflict'],
      ['conflict', 'accepted'],
      ['conflict', 'rejected'],
      ['conflict', 'merged'],
    ];
    const INVALID: ReadonlyArray<[MemoryCandidateStatus, MemoryCandidateStatus]> = [
      // 终态不可迁出
      ['accepted', 'rejected'],
      ['rejected', 'accepted'],
      ['merged', 'accepted'],
      ['accepted', 'candidate'],
      // 自迁
      ['candidate', 'candidate'],
      ['conflict', 'conflict'],
      ['merged', 'merged'],
      // conflict 不可回退为 candidate
      ['conflict', 'candidate'],
    ];

    test.each(VALID)('allows %s → %s', (from, to) => {
      expect(evaluateCandidateTransition(from, to)).toEqual({ ok: true });
    });

    test.each(INVALID)('rejects %s → %s', (from, to) => {
      expect(evaluateCandidateTransition(from, to)).toEqual({
        ok: false,
        reason: 'CANDIDATE_INVALID_TRANSITION',
      });
    });
  });

  describe('computeProjectionHash', () => {
    const ref = (id: string, kind: MemorySourceRefDto['sourceKind'] = 'message'): MemorySourceRefDto => ({
      schemaVersion: 1,
      sourceKind: kind,
      sourceId: id,
      snapshotHash: 'h1',
    });

    const base = {
      proposedContent: '使用 node-pty spawn 子进程',
      sourceRefs: [ref('m1')],
      scopeType: 'task' as const,
      scopeRef: 'task-1',
      targetAgentId: 'target-agent-1',
      contentKind: 'decision' as const,
    };

    test('identical inputs produce identical projection hash', () => {
      expect(computeProjectionHash(base)).toBe(computeProjectionHash({ ...base }));
    });

    test('different proposedContent changes the hash', () => {
      expect(computeProjectionHash(base)).not.toBe(
        computeProjectionHash({ ...base, proposedContent: '使用 pty.js' }),
      );
    });

    test('different sourceRef id changes the hash', () => {
      expect(computeProjectionHash(base)).not.toBe(
        computeProjectionHash({ ...base, sourceRefs: [ref('m2')] }),
      );
    });

    test('sourceRefs order does not change the hash', () => {
      const refs = [ref('m1'), ref('t1', 'task')];
      const reordered = [refs[1], refs[0]];
      expect(computeProjectionHash({ ...base, sourceRefs: refs })).toBe(
        computeProjectionHash({ ...base, sourceRefs: reordered }),
      );
    });

    test('different scope or contentKind changes the hash', () => {
      expect(computeProjectionHash(base)).not.toBe(
        computeProjectionHash({ ...base, scopeRef: 'task-2' }),
      );
      expect(computeProjectionHash(base)).not.toBe(
        computeProjectionHash({ ...base, contentKind: 'fact' as const }),
      );
      expect(computeProjectionHash(base)).not.toBe(
        computeProjectionHash({ ...base, targetAgentId: 'target-agent-2' }),
      );
    });
  });
});

import { describe, expect, test } from 'vitest';
import {
  PROMOTION_HIGH_RISK_ACTIONS,
  canonicalizePromotionObjectiveSnapshot,
  classifyPromotionOutcome,
  evaluatePromotionAuthorization,
  evaluatePromotionConvergence,
  evaluatePromotionFreshness,
} from '../src/promotion-gate-policy.js';
import type { PromotionObjectiveSnapshotV1 } from '@agentbean/contracts';

const snap = (over: Partial<PromotionObjectiveSnapshotV1> = {}): PromotionObjectiveSnapshotV1 => ({
  schemaVersion: 1,
  objective: '整理 Q3 需求文档',
  scope: 'team-docs 频道只读引用',
  riskLevel: 'low',
  ...over,
});

describe('canonicalizePromotionObjectiveSnapshot', () => {
  test('same content yields same canonical regardless of key order', () => {
    const a = canonicalizePromotionObjectiveSnapshot(snap());
    const b = canonicalizePromotionObjectiveSnapshot({
      riskLevel: 'low',
      scope: 'team-docs 频道只读引用',
      schemaVersion: 1,
      objective: '整理 Q3 需求文档',
    });
    expect(a).toBe(b);
  });
  test('different objective yields different canonical', () => {
    expect(canonicalizePromotionObjectiveSnapshot(snap())).not.toBe(
      canonicalizePromotionObjectiveSnapshot(snap({ objective: '另一个目标' })),
    );
  });
  test('dataSnapshot presence vs absence differs', () => {
    expect(canonicalizePromotionObjectiveSnapshot(snap())).not.toBe(
      canonicalizePromotionObjectiveSnapshot(snap({ dataSnapshot: 'sha:abc' })),
    );
  });
});

describe('evaluatePromotionConvergence', () => {
  test('no existing relation → create', () => {
    expect(evaluatePromotionConvergence({
      sourceLineageKey: 'team-1:msg-1',
      requestedSnapshot: snap(),
    })).toEqual({ kind: 'create' });
  });
  test('same lineage + same snapshot → converged (idempotent, returns same Task, #894 §6)', () => {
    expect(evaluatePromotionConvergence({
      sourceLineageKey: 'team-1:msg-1',
      requestedSnapshot: snap(),
      existing: { lineageKey: 'team-1:msg-1', taskId: 'task-1', snapshot: snap() },
    })).toEqual({ kind: 'converged', existingTaskId: 'task-1' });
  });
  test('same lineage + different snapshot → conflict (no side effects, #894 §6)', () => {
    const decision = evaluatePromotionConvergence({
      sourceLineageKey: 'team-1:msg-1',
      requestedSnapshot: snap({ objective: '新目标' }),
      existing: { lineageKey: 'team-1:msg-1', taskId: 'task-1', snapshot: snap() },
    });
    expect(decision.kind).toBe('conflict');
  });
  test('different lineage does not converge to existing (lineage is the convergence key)', () => {
    expect(evaluatePromotionConvergence({
      sourceLineageKey: 'team-1:msg-2',
      requestedSnapshot: snap(),
      existing: { lineageKey: 'team-1:msg-1', taskId: 'task-1', snapshot: snap() },
    })).toEqual({ kind: 'create' });
  });
});

describe('evaluatePromotionAuthorization', () => {
  test('human-structured trigger without high-risk actions → allowed', () => {
    expect(evaluatePromotionAuthorization({ triggerKind: 'human-structured' }))
      .toEqual({ allowed: true });
  });
  test('non-human trigger is denied (NL / @Agent / DM / Thread owner cannot call this gate, #894 §1)', () => {
    // 非 human-structured 的 trigger（自然语言、@Agent 等）不能通过 envelope 校验进入；本函数作为
    // 二次防御，对任何非登记 trigger kind 一律拒绝。
    const decision = evaluatePromotionAuthorization({
      triggerKind: 'natural-language' as never,
    });
    expect('denied' in decision).toBe(true);
  });
  test('promotion must not authorize high-risk actions (delete/publish/payment/data-export/production-change, #894 §8)', () => {
    for (const action of PROMOTION_HIGH_RISK_ACTIONS) {
      const decision = evaluatePromotionAuthorization({
        triggerKind: 'human-structured',
        requestedActions: [action],
      });
      expect('denied' in decision).toBe(true);
    }
  });
  test('orchestration-only actions remain allowed (create-task / start-orchestration)', () => {
    expect(evaluatePromotionAuthorization({
      triggerKind: 'human-structured',
      requestedActions: ['create-task', 'start-orchestration'],
    })).toEqual({ allowed: true });
  });
});

describe('evaluatePromotionFreshness', () => {
  test('no revision info → ok (human trigger respected within bounds, #894 §7)', () => {
    expect(evaluatePromotionFreshness({})).toEqual({ ok: true });
  });
  test('matching revision → ok', () => {
    expect(evaluatePromotionFreshness({ requestedSourceRevision: 3, currentSourceRevision: 3 }))
      .toEqual({ ok: true });
  });
  test('requested revision 无法由当前来源验证 → hold', () => {
    expect(evaluatePromotionFreshness({ requestedSourceRevision: 3 }))
      .toEqual({ hold: true, reason: 'source-revision-unavailable' });
  });
  test('source explicitly changed → hold (stale token cannot cross revision, #894 §5)', () => {
    const decision = evaluatePromotionFreshness({ sourceChanged: true });
    expect('hold' in decision).toBe(true);
  });
  test('requested revision behind current → hold', () => {
    const decision = evaluatePromotionFreshness({ requestedSourceRevision: 2, currentSourceRevision: 3 });
    expect('hold' in decision).toBe(true);
  });
});

describe('classifyPromotionOutcome', () => {
  const authzOk = { allowed: true } as const;
  const freshOk = { ok: true } as const;
  const create = { kind: 'create' } as const;
  const converged = { kind: 'converged', existingTaskId: 'task-1' } as const;

  test('authorization denied → rejected (checked first, #900 §18)', () => {
    expect(classifyPromotionOutcome({
      authorization: { denied: true, reason: 'not-human-trigger' },
      freshness: freshOk,
      convergence: create,
    }).outcome).toBe('rejected');
  });
  test('freshness hold → freshness_hold (no Task created)', () => {
    expect(classifyPromotionOutcome({
      authorization: authzOk,
      freshness: { hold: true, reason: 'source-edited' },
      convergence: create,
    }).outcome).toBe('freshness_hold');
  });
  test('convergence conflict → conflict (no side effects)', () => {
    expect(classifyPromotionOutcome({
      authorization: authzOk,
      freshness: freshOk,
      convergence: { kind: 'conflict', reason: 'different-snapshot' },
    }).outcome).toBe('conflict');
  });
  test('create → applied (new root Task)', () => {
    expect(classifyPromotionOutcome({
      authorization: authzOk,
      freshness: freshOk,
      convergence: create,
    }).outcome).toBe('applied');
  });
  test('converged → replayed (idempotent, returns same Task)', () => {
    const result = classifyPromotionOutcome({
      authorization: authzOk,
      freshness: freshOk,
      convergence: converged,
    });
    expect(result.outcome).toBe('replayed');
    if (result.outcome === 'replayed') expect(result.existingTaskId).toBe('task-1');
  });
});

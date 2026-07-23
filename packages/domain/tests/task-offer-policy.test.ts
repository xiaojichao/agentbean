import { describe, expect, test } from 'vitest';

import type { TaskOfferStatus } from '@agentbean/contracts';

import {
  evaluateOfferAcceptance,
  evaluateOfferDecline,
  evaluateOfferValidity,
  isValidOfferStatusTransition,
  type OfferValidity,
} from '../src/task-offer-policy.js';
import type { TaskClaimAcquireInput, TaskClaimLeaseRecord } from '../src/task-claim-policy.js';

// ---- helpers ----

const NOW = 1_000_000;
const TTL = 60_000;

function validOfferValidity(): OfferValidity {
  return { acceptable: true };
}

function invalidOfferValidity(): OfferValidity {
  return { acceptable: false, reason: 'expired' };
}

/** 构造一个合法的初始 acquire 输入（无 current lease）。 */
function initialAcquire(agentId = 'agent-a'): TaskClaimAcquireInput {
  return {
    taskId: 'task-1',
    taskRevision: 3,
    taskAttempt: 1,
    agentId,
    leaseTokenHash: 'hash-a',
    leaseFingerprint: 'fingerprint-a',
    ancestorAgentIds: [],
    now: NOW,
    ttlMs: TTL,
  };
}

/** 复刻 task-claim-policy grantedLease 的产出，用于构造并发/重开场景的 current lease。 */
function leaseRecord(over: Partial<TaskClaimLeaseRecord> = {}): TaskClaimLeaseRecord {
  return {
    taskId: 'task-1',
    taskRevision: 3,
    taskAttempt: 1,
    agentId: 'agent-a',
    leaseTokenHash: 'hash-a',
    leaseFingerprint: 'fingerprint-a',
    fencingToken: 1,
    acquiredAt: NOW,
    renewedAt: NOW,
    expiresAt: NOW + TTL,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// evaluateOfferValidity —— AC#1（字段固定）/ AC#5（失效不产 Lease 的前置判定）
// ---------------------------------------------------------------------------

describe('evaluateOfferValidity', () => {
  test('open + 未过期 + task/manifest revision 一致 → acceptable', () => {
    expect(
      evaluateOfferValidity({
        status: 'open',
        offerExpiresAt: NOW + 15_000,
        offerTaskRevision: 3,
        offerManifestRevision: 2,
        now: NOW,
        currentTaskRevision: 3,
        currentManifestRevision: 2,
      }),
    ).toEqual({ acceptable: true });
  });

  test('超过 offerExpiresAt → expired（AC#5）', () => {
    const r = evaluateOfferValidity({
      status: 'open',
      offerExpiresAt: NOW,
      offerTaskRevision: 3,
      offerManifestRevision: 2,
      now: NOW,
      currentTaskRevision: 3,
      currentManifestRevision: 2,
    });
    expect(r).toEqual({ acceptable: false, reason: 'expired' });
  });

  test('task 产生新 revision → task_revision_changed（AC#1/#709 fence）', () => {
    const r = evaluateOfferValidity({
      status: 'open',
      offerExpiresAt: NOW + 15_000,
      offerTaskRevision: 3,
      offerManifestRevision: 2,
      now: NOW,
      currentTaskRevision: 4,
      currentManifestRevision: 2,
    });
    expect(r).toEqual({ acceptable: false, reason: 'task_revision_changed' });
  });

  test('agent active manifest 被新 revision 取代 → manifest_superseded（AC#6 fence）', () => {
    const r = evaluateOfferValidity({
      status: 'open',
      offerExpiresAt: NOW + 15_000,
      offerTaskRevision: 3,
      offerManifestRevision: 2,
      now: NOW,
      currentTaskRevision: 3,
      currentManifestRevision: 3,
    });
    expect(r).toEqual({ acceptable: false, reason: 'manifest_superseded' });
  });

  test('status 非 open（已终态）→ not_open（AC#3 ACK 不复活终态）', () => {
    for (const status of ['accepted', 'rejected', 'expired', 'invalidated', 'overtaken'] as TaskOfferStatus[]) {
      const r = evaluateOfferValidity({
        status,
        offerExpiresAt: NOW + 15_000,
        offerTaskRevision: 3,
        offerManifestRevision: 2,
        now: NOW,
        currentTaskRevision: 3,
        currentManifestRevision: 2,
      });
      expect(r).toEqual({ acceptable: false, reason: 'not_open' });
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateOfferAcceptance —— AC#2 accepted / AC#4 原子 / AC#5 / AC#6 单赢家+fencing
// ---------------------------------------------------------------------------

describe('evaluateOfferAcceptance', () => {
  test('accepted + 有效 + qualified + 无 current → claim_granted，fencing=1（AC#4）', () => {
    const decision = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity: validOfferValidity(),
      acquire: initialAcquire(),
    });
    expect(decision.kind).toBe('claim_granted');
    if (decision.kind !== 'claim_granted') return;
    expect(decision.newStatus).toBe('accepted');
    expect(decision.lease.fencingToken).toBe(1);
    expect(decision.lease.taskId).toBe('task-1');
  });

  test('accepted + 有效 + qualified + 他人持有 active claim → overtaken，不产 Lease（AC#6 败者）', () => {
    const decision = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity: validOfferValidity(),
      acquire: {
        ...initialAcquire('agent-b'),
        // 他人 agent-a 持有 active lease（不同 token hash → 非重复）
        current: leaseRecord({ agentId: 'agent-a', leaseTokenHash: 'hash-other', leaseFingerprint: 'fp-other' }),
      },
    });
    expect(decision).toEqual({ kind: 'overtaken', reason: 'active_claim_held' });
  });

  test('并发接受：第一个获得 fencing=1；旧 lease 释放后重开 fencing=2（单调，AC#6）', () => {
    // 第一个 agent 接受（无 current）→ fencing=1
    const first = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity: validOfferValidity(),
      acquire: initialAcquire('agent-a'),
    });
    expect(first.kind).toBe('claim_granted');
    if (first.kind !== 'claim_granted') return;
    expect(first.lease.fencingToken).toBe(1);

    // 该 lease 在 NOW+5 释放；另一 agent 在 NOW+10 接受 → fencing=2（严格大于）
    const second = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity: validOfferValidity(),
      acquire: {
        ...initialAcquire('agent-b'),
        leaseTokenHash: 'hash-b',
        leaseFingerprint: 'fp-b',
        now: NOW + 10,
        current: { ...first.lease, agentId: 'agent-a', releasedAt: NOW + 5 },
      },
    });
    expect(second.kind).toBe('claim_granted');
    if (second.kind !== 'claim_granted') return;
    expect(second.lease.fencingToken).toBe(2);
    expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
  });

  test('accepted 但 Offer 已失效 → not_accepted(offer_invalid)，不产 Lease（AC#5）', () => {
    const decision = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity: invalidOfferValidity(),
      acquire: initialAcquire(),
    });
    expect(decision.kind).toBe('not_accepted');
    if (decision.kind !== 'not_accepted') return;
    expect(decision.reason).toBe('offer_invalid');
  });

  test('accepted 但 Agent 不 qualified → not_accepted(agent_not_qualified)，不产 Lease（AC#4 守卫）', () => {
    for (const state of ['not_qualified', 'unknown'] as const) {
      const decision = evaluateOfferAcceptance({
        eligibility: { state },
        validity: validOfferValidity(),
        acquire: initialAcquire(),
      });
      expect(decision.kind).toBe('not_accepted');
      if (decision.kind === 'not_accepted') expect(decision.reason).toBe('agent_not_qualified');
    }
  });

  test('accepted 但 acquire 被既有原子策略拒绝（如 ancestor loop）→ not_accepted(claim_rejected)', () => {
    const decision = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity: validOfferValidity(),
      acquire: { ...initialAcquire(), ancestorAgentIds: ['agent-a'] },
    });
    expect(decision.kind).toBe('not_accepted');
    if (decision.kind === 'not_accepted') {
      expect(decision.reason).toBe('claim_rejected');
      expect(decision.acquireRejection).toBe('ancestor-agent-loop');
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateOfferDecline —— AC#2 三类非 accepted / AC#5 全部不产 Lease
// ---------------------------------------------------------------------------

describe('evaluateOfferDecline', () => {
  test('rejected / needs_info / counter_proposed 有效响应 → response_recorded，producesLease=false（AC#5）', () => {
    for (const kind of ['rejected', 'needs_info', 'counter_proposed'] as const) {
      const decision = evaluateOfferDecline({ kind, validity: validOfferValidity() });
      expect(decision).toEqual({ kind: 'response_recorded', newStatus: kind, producesLease: false });
    }
  });

  test('对已失效 Offer 的非 accepted 响应 → not_accepted(offer_invalid)，不记录为终态响应', () => {
    const decision = evaluateOfferDecline({ kind: 'rejected', validity: invalidOfferValidity() });
    expect(decision).toEqual({ kind: 'not_accepted', reason: 'offer_invalid' });
  });

  test('hardSpecified 的 Offer 仍可被 rejected —— 显式 @Agent 不强迫接受（AC#8）', () => {
    // hardSpecified 是 Offer 元数据，不影响 decline 判定：被点名 Agent 仍可拒绝。
    const decision = evaluateOfferDecline({ kind: 'rejected', validity: validOfferValidity() });
    expect(decision.kind).toBe('response_recorded');
    if (decision.kind === 'response_recorded') expect(decision.newStatus).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// isValidOfferStatusTransition —— AC#3（ACK 永不产生状态转移/Claim）
// ---------------------------------------------------------------------------

describe('isValidOfferStatusTransition', () => {
  test('open → 任意响应/失效终态 合法', () => {
    const targets: TaskOfferStatus[] = [
      'accepted', 'rejected', 'needs_info', 'counter_proposed', 'expired', 'invalidated', 'overtaken',
    ];
    for (const to of targets) {
      expect(isValidOfferStatusTransition('open', to)).toBe(true);
    }
  });

  test('ACK = open → open（无操作）合法，但不进入任何 Claim/终态（AC#3）', () => {
    expect(isValidOfferStatusTransition('open', 'open')).toBe(true);
  });

  test('终态 → 非自身 非法（终态不可复活，AC#3/AC#5）', () => {
    const terminals: TaskOfferStatus[] = [
      'accepted', 'rejected', 'needs_info', 'counter_proposed', 'expired', 'invalidated', 'overtaken',
    ];
    for (const from of terminals) {
      for (const to of terminals) {
        if (from === to) continue;
        expect(isValidOfferStatusTransition(from, to)).toBe(false);
      }
      // 终态 → open 也非法（不能从终态退回开放）
      expect(isValidOfferStatusTransition(from, 'open')).toBe(false);
    }
  });

  test('终态 → 自身 合法（幂等重放，AC#11 幂等）', () => {
    const terminals: TaskOfferStatus[] = ['accepted', 'rejected', 'expired', 'invalidated', 'overtaken'];
    for (const s of terminals) {
      expect(isValidOfferStatusTransition(s, s)).toBe(true);
    }
  });
});

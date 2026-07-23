import { describe, expect, test } from 'vitest';

import type {
  AgentExposureManifestStatus,
  ClaimRelinquishmentCause,
  AuthorityRevocationCause,
} from '@agentbean/contracts';

import {
  evaluateClaimRelinquishment,
  evaluateAuthorityRevocation,
  evaluateManifestUsabilityForCommitment,
} from '../src/claim-relinquishment-policy.js';
import {
  evaluateTaskClaimAcquire,
  evaluateTaskClaimRelease,
  inspectTaskClaim,
  authorizeTaskClaimWrite,
  type TaskClaimAcquireInput,
  type TaskClaimAuthorizationProof,
  type TaskClaimLeaseRecord,
} from '../src/task-claim-policy.js';
import { evaluateOfferAcceptance } from '../src/task-offer-policy.js';

// ---- helpers ----

const NOW = 1_000_000;
const TTL = 60_000;

/** 复刻 task-claim-policy grantedLease 的产出：一个合法的 active lease（agent-a 持有）。 */
function activeLease(over: Partial<TaskClaimLeaseRecord> = {}): TaskClaimLeaseRecord {
  return {
    taskId: 'task-1',
    taskRevision: 3,
    taskAttempt: 1,
    agentId: 'agent-a',
    leaseTokenHash: 'hash-a',
    leaseFingerprint: 'fp-a',
    fencingToken: 1,
    acquiredAt: NOW,
    renewedAt: NOW,
    expiresAt: NOW + TTL,
    ...over,
  };
}

/** 匹配 activeLease 的有效 proof（agent-a 当前 authority）。 */
function validProof(over: Partial<TaskClaimAuthorizationProof> = {}): TaskClaimAuthorizationProof {
  return {
    taskId: 'task-1',
    taskRevision: 3,
    taskAttempt: 1,
    agentId: 'agent-a',
    presentedLeaseTokenHash: 'hash-a',
    fencingToken: 1,
    ...over,
  };
}

/** 无 current 的初始 acquire 输入（用于穿透测试重新认领）。 */
function initialAcquire(agentId = 'agent-a', tokenHash = 'hash-a'): TaskClaimAcquireInput {
  return {
    taskId: 'task-1',
    taskRevision: 3,
    taskAttempt: 1,
    agentId,
    leaseTokenHash: tokenHash,
    leaseFingerprint: `fp-${tokenHash}`,
    ancestorAgentIds: [],
    now: NOW,
    ttlMs: TTL,
  };
}

const RELINQUISH_CAUSES: readonly ClaimRelinquishmentCause[] = [
  'agent_voluntary',
  'task_unfeasible',
  'agent_unavailable',
  'context_changed',
];

const REVOCATION_CAUSES: readonly AuthorityRevocationCause[] = [
  'permission_revoked',
  'membership_revoked',
  'safety_override',
  'manifest_revoked',
];

// ---------------------------------------------------------------------------
// evaluateClaimRelinquishment —— AC#5（显式交回）/ AC#6（fencing 单调 + 旧 authority fail-closed）
// ---------------------------------------------------------------------------

describe('evaluateClaimRelinquishment', () => {
  test('active lease + 有效 proof + cause → relinquished，releasedAt=now，cause/detail 回显（AC#5）', () => {
    for (const cause of RELINQUISH_CAUSES) {
      const decision = evaluateClaimRelinquishment({
        lease: activeLease(),
        proof: validProof(),
        now: NOW + 5_000,
        cause,
        detail: 'cannot reach network',
      });
      expect(decision.kind).toBe('relinquished');
      if (decision.kind !== 'relinquished') return;
      expect(decision.lease.releasedAt).toBe(NOW + 5_000);
      expect(decision.lease.releasedAt).toBeLessThan(decision.lease.expiresAt);
      expect(decision.cause).toBe(cause);
      expect(decision.detail).toBe('cannot reach network');
    }
  });

  test('已 released 的 lease → already_relinquished（幂等，AC#6）', () => {
    const decision = evaluateClaimRelinquishment({
      lease: activeLease({ releasedAt: NOW + 1_000 }),
      proof: validProof(),
      now: NOW + 2_000,
      cause: 'agent_voluntary',
    });
    expect(decision.kind).toBe('already_relinquished');
    if (decision.kind === 'already_relinquished') {
      expect(decision.lease.releasedAt).toBe(NOW + 1_000); // 不改写
    }
  });

  test('已过期 lease（未 released，now>=expiresAt）→ no_active_claim，绝不写 releasedAt（V3 修复）', () => {
    const lease = activeLease(); // expiresAt = NOW + TTL
    const decision = evaluateClaimRelinquishment({
      lease,
      proof: validProof(),
      now: NOW + TTL, // 恰好过期
      cause: 'agent_voluntary',
    });
    expect(decision).toEqual({ kind: 'no_active_claim' });
    // 关键：原 lease 未被破坏性修改（没有写一个违反 releasedAt<expiresAt 的 releasedAt）
    expect(lease.releasedAt).toBeUndefined();
    expect(inspectTaskClaim(lease, NOW + TTL).kind).toBe('expired');
  });

  test('无效/损坏 lease（releasedAt>=expiresAt）→ no_active_claim，不尝试修复（AC#6）', () => {
    const decision = evaluateClaimRelinquishment({
      // releasedAt 违反 < expiresAt → inspectTaskClaim 判定 invalid
      lease: activeLease({ releasedAt: NOW + TTL + 10 }),
      proof: validProof(),
      now: NOW + 5_000,
      cause: 'agent_voluntary',
    });
    expect(decision).toEqual({ kind: 'no_active_claim' });
  });

  test('无 lease → no_active_claim', () => {
    const decision = evaluateClaimRelinquishment({
      proof: validProof(),
      now: NOW,
      cause: 'agent_voluntary',
    });
    expect(decision).toEqual({ kind: 'no_active_claim' });
  });

  test('active lease + stale proof（各字段变异）→ rejected，对应 TaskClaimAuthorizationFailure（fail-closed，AC#6）', () => {
    const base = { lease: activeLease(), now: NOW + 5_000, cause: 'agent_voluntary' as const };
    const cases: Array<{ name: string; over: Partial<TaskClaimAuthorizationProof>; reason: string }> = [
      { name: 'agent 不匹配', over: { agentId: 'agent-b' }, reason: 'agent-mismatch' },
      { name: 'lease token 不匹配', over: { presentedLeaseTokenHash: 'hash-other' }, reason: 'lease-token-mismatch' },
      { name: 'stale fencing token', over: { fencingToken: 0 }, reason: 'stale-fencing-token' },
      { name: 'future fencing token', over: { fencingToken: 2 }, reason: 'future-fencing-token' },
      { name: 'stale task revision', over: { taskRevision: 2 }, reason: 'stale-task-revision' },
      { name: 'future task attempt', over: { taskAttempt: 2 }, reason: 'future-task-attempt' },
    ];
    for (const c of cases) {
      const decision = evaluateClaimRelinquishment({ ...base, proof: validProof(c.over) });
      expect(decision.kind).toBe('rejected');
      if (decision.kind === 'rejected') expect(decision.reason).toBe(c.reason);
    }
  });

  test('active lease + now 回退（clock-regressed）→ no_active_claim（不操作，fail-closed）', () => {
    // inspectTaskClaim 把 clock-regressed（now<acquiredAt）归为 invalid；本模块 invalid → no_active_claim，
    // 绝不写 releasedAt。与 V3 一致的 fail-closed：时钟异常时 lease 状态不可信，不操作比 rejected 更安全。
    const lease = activeLease(); // acquiredAt = NOW
    const decision = evaluateClaimRelinquishment({
      lease,
      proof: validProof(),
      now: NOW - 1, // 回退到 acquiredAt 之前
      cause: 'agent_voluntary',
    });
    expect(decision).toEqual({ kind: 'no_active_claim' });
    expect(lease.releasedAt).toBeUndefined();
  });

  test('穿透：relinquish 后重新认领同一 task → fencingToken+1（单调，AC#6）', () => {
    const relinquished = evaluateClaimRelinquishment({
      lease: activeLease(),
      proof: validProof(),
      now: NOW + 5_000,
      cause: 'task_unfeasible',
    });
    expect(relinquished.kind).toBe('relinquished');
    if (relinquished.kind !== 'relinquished') return;

    // agent-b 在 NOW+10 用新 token 重新认领（current = 刚释放的 lease）
    const reacquired = evaluateTaskClaimAcquire({
      ...initialAcquire('agent-b', 'hash-b'),
      now: NOW + 10_000,
      current: relinquished.lease,
    });
    expect(reacquired.kind).toBe('granted');
    if (reacquired.kind !== 'granted') return;
    expect(reacquired.lease.fencingToken).toBe(2);
    expect(reacquired.lease.fencingToken).toBeGreaterThan(relinquished.lease.fencingToken);
  });
});

// ---------------------------------------------------------------------------
// evaluateAuthorityRevocation —— AC#4（安全撤销优先于旧承诺）/ AC#6（旧 authority fail-closed）
// ---------------------------------------------------------------------------

describe('evaluateAuthorityRevocation', () => {
  test('active lease + cause → revoked，releasedAt=now，不需 Agent proof（AC#4）', () => {
    for (const cause of REVOCATION_CAUSES) {
      const decision = evaluateAuthorityRevocation({
        lease: activeLease(),
        now: NOW + 5_000,
        cause,
        detail: 'admin revocation',
      });
      expect(decision.kind).toBe('revoked');
      if (decision.kind !== 'revoked') return;
      expect(decision.lease.releasedAt).toBe(NOW + 5_000);
      expect(decision.lease.releasedAt).toBeLessThan(decision.lease.expiresAt);
      expect(decision.cause).toBe(cause);
      expect(decision.detail).toBe('admin revocation');
    }
  });

  test('revoked 后 Agent 用旧 proof 写入 → authorizeTaskClaimWrite 返回 claim-released（fail-closed，AC#4/AC#6）', () => {
    const decision = evaluateAuthorityRevocation({
      lease: activeLease(),
      now: NOW + 5_000,
      cause: 'permission_revoked',
    });
    expect(decision.kind).toBe('revoked');
    if (decision.kind !== 'revoked') return;

    // agent-a 持有原 proof（fencingToken=1），试图继续写入已被撤销的 claim
    const write = authorizeTaskClaimWrite({
      lease: decision.lease,
      proof: validProof(),
      now: NOW + 6_000,
    });
    expect(write.kind).toBe('rejected');
    if (write.kind === 'rejected') expect(write.reason).toBe('claim-released');
  });

  test('已过期 lease → already_terminal:expired，releasedAt 保持 undefined（V1 修复）', () => {
    const lease = activeLease(); // expiresAt = NOW + TTL
    const decision = evaluateAuthorityRevocation({
      lease,
      now: NOW + TTL, // 过期
      cause: 'safety_override',
    });
    expect(decision.kind).toBe('already_terminal');
    if (decision.kind === 'already_terminal') {
      expect(decision.status).toBe('expired');
      expect(decision.lease.releasedAt).toBeUndefined(); // 关键：未破坏性写入
    }
    // 过期 lease 仍可被重新认领（未卡死）
    const reacquired = evaluateTaskClaimAcquire({
      ...initialAcquire('agent-b', 'hash-b'),
      now: NOW + TTL + 1,
      current: lease,
    });
    expect(reacquired.kind).toBe('granted');
  });

  test('已 released lease → already_terminal:released（幂等）', () => {
    const decision = evaluateAuthorityRevocation({
      lease: activeLease({ releasedAt: NOW + 1_000 }),
      now: NOW + 2_000,
      cause: 'membership_revoked',
    });
    expect(decision.kind).toBe('already_terminal');
    if (decision.kind === 'already_terminal') expect(decision.status).toBe('released');
  });

  test('无效 lease → already_terminal:invalid，不写 releasedAt 到损坏数据上', () => {
    const decision = evaluateAuthorityRevocation({
      lease: activeLease({ releasedAt: NOW + TTL + 10 }), // invalid
      now: NOW + 5_000,
      cause: 'safety_override',
    });
    expect(decision.kind).toBe('already_terminal');
    if (decision.kind === 'already_terminal') expect(decision.status).toBe('invalid');
  });

  test('无 lease → no_active_claim', () => {
    const decision = evaluateAuthorityRevocation({
      now: NOW,
      cause: 'permission_revoked',
    });
    expect(decision).toEqual({ kind: 'no_active_claim' });
  });

  test('穿透：revoked 后经 evaluateOfferAcceptance（qualified）重新认领 → fencing+1（AC#6）', () => {
    const revoked = evaluateAuthorityRevocation({
      lease: activeLease(),
      now: NOW + 5_000,
      cause: 'permission_revoked',
    });
    expect(revoked.kind).toBe('revoked');
    if (revoked.kind !== 'revoked') return;

    // agent-b 合格地接受新 Offer，基于已 revoked 的 current 重新认领
    const acceptance = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity: { acceptable: true },
      acquire: {
        ...initialAcquire('agent-b', 'hash-b'),
        now: NOW + 10_000,
        current: revoked.lease,
      },
    });
    expect(acceptance.kind).toBe('claim_granted');
    if (acceptance.kind !== 'claim_granted') return;
    expect(acceptance.lease.fencingToken).toBe(2);
  });

  test('黄金缺口（V2 结构性）：裸 evaluateTaskClaimAcquire 用新 token 能 reopened 已 revoked lease——证明重新获取门禁须由接线层资格守卫封闭', () => {
    const revoked = evaluateAuthorityRevocation({
      lease: activeLease(),
      now: NOW + 5_000,
      cause: 'permission_revoked',
    });
    expect(revoked.kind).toBe('revoked');
    if (revoked.kind !== 'revoked') return;

    // 被撤销的 agent-a 用全新 token 走裸 acquire（绕过 evaluateOfferAcceptance 的 qualified 门控）
    const reacquired = evaluateTaskClaimAcquire({
      ...initialAcquire('agent-a', 'hash-new'),
      now: NOW + 6_000,
      current: revoked.lease,
    });
    // 结构性缺口：domain 层 reopened-released 对任意 agentId 放行——这是已知限制，
    // 必须由接线层（资格传播 / 不为被撤销 agent 调用裸 acquire）封闭，domain 无法在不破坏
    // AC#3（validateProof 不读 manifest）的前提下封闭。
    expect(reacquired.kind).toBe('granted');
    if (reacquired.kind === 'granted') expect(reacquired.lease.fencingToken).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// evaluateManifestUsabilityForCommitment —— AC#2（过期/撤回/被取代 Manifest 不能用于新承诺）
// ---------------------------------------------------------------------------

describe('evaluateManifestUsabilityForCommitment', () => {
  test('active + validUntil=null → usable', () => {
    expect(
      evaluateManifestUsabilityForCommitment({ status: 'active', validUntil: null, now: NOW }),
    ).toEqual({ usable: true });
  });

  test('active + validUntil>now → usable', () => {
    expect(
      evaluateManifestUsabilityForCommitment({ status: 'active', validUntil: NOW + 10_000, now: NOW }),
    ).toEqual({ usable: true });
  });

  test('active + validUntil<=now → 不可用:expired（边界对齐 evaluatePublishWindow，AC#2）', () => {
    expect(
      evaluateManifestUsabilityForCommitment({ status: 'active', validUntil: NOW, now: NOW }),
    ).toEqual({ usable: false, reason: 'expired' });
    expect(
      evaluateManifestUsabilityForCommitment({ status: 'active', validUntil: NOW - 1, now: NOW }),
    ).toEqual({ usable: false, reason: 'expired' });
  });

  test('active + validUntil 非 safe int → 不可用:expired（fail-closed，防脏 as 输入）', () => {
    expect(
      evaluateManifestUsabilityForCommitment({ status: 'active', validUntil: NaN, now: NOW }),
    ).toEqual({ usable: false, reason: 'expired' });
    expect(
      evaluateManifestUsabilityForCommitment({ status: 'active', validUntil: -1, now: NOW }),
    ).toEqual({ usable: false, reason: 'expired' });
  });

  test('非 active 状态 → 不可用，reason 对应 status（AC#2）', () => {
    const nonActive: Array<{ status: AgentExposureManifestStatus; reason: string }> = [
      { status: 'draft', reason: 'draft' },
      { status: 'superseded', reason: 'superseded' },
      { status: 'expired', reason: 'expired' },
      { status: 'revoked', reason: 'revoked' },
    ];
    for (const c of nonActive) {
      expect(
        evaluateManifestUsabilityForCommitment({ status: c.status, validUntil: null, now: NOW }),
      ).toEqual({ usable: false, reason: c.reason });
    }
  });
});

// ---------------------------------------------------------------------------
// AC#3 不变量：Manifest revision 变化不自动取消已接受 Claim
// （根源：validateProof 不读 manifest revision）
// ---------------------------------------------------------------------------

describe('AC#3 不变量：manifest revision 变化不取消已接受 claim', () => {
  test('active lease 仅改变 manifest revision → inspectTaskClaim 仍 active、authorizeTaskClaimWrite 仍成功', () => {
    const lease = activeLease();
    const proof = validProof();

    // manifest revision 是 Offer 阶段 fence（#712 evaluateOfferValidity），
    // 但 claim 一旦成立，其 proof 校验（validateProof）只看 task 字段，不读 manifest。
    // 模拟：accept 后 manifest 从 revision 2 → 3。claim 不应受影响。
    expect(inspectTaskClaim(lease, NOW + 5_000).kind).toBe('active');
    const write = authorizeTaskClaimWrite({ lease, proof, now: NOW + 5_000 });
    expect(write.kind).toBe('authorized');

    // 同一 proof 续约/释放仍有效（manifest 变化不阻断 agent 的既有 authority）
    const release = evaluateTaskClaimRelease({ lease, proof, now: NOW + 6_000 });
    expect(release.kind).toBe('released');
  });
});

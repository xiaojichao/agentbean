import { describe, expect, test } from 'vitest';

import {
  evaluateExperiencePackApproval,
  evaluateExperiencePackConfirmation,
  evaluateExperiencePackRecommendation,
  evaluateExperiencePackRevocation,
  evaluateExperiencePackSourceValidity,
  evaluateExperiencePackWithdrawal,
  validateExperiencePackDraft,
  type EvaluateExperiencePackApprovalInput,
  type EvaluateExperiencePackConfirmationInput,
  type EvaluateExperiencePackRecommendationInput,
  type EvaluateExperiencePackRevocationInput,
  type EvaluateExperiencePackSourceValidityInput,
  type EvaluateExperiencePackWithdrawalInput,
} from '../src/experience-pack-policy.js';

// ── 辅助工厂函数 ──────────────────────────────────────────────────────────────

function draftPack(over: Partial<EvaluateExperiencePackApprovalInput['pack']> = {}) {
  return { status: 'draft' as const, teamId: 'team-1', ...over };
}

function approvedPack(over: Partial<EvaluateExperiencePackApprovalInput['pack']> = {}) {
  return { status: 'approved' as const, teamId: 'team-1', ...over };
}

function sourceInvalidPack() {
  return { status: 'source_invalid' as const, teamId: 'team-1' };
}

function withdrawnPack() {
  return { status: 'withdrawn' as const, teamId: 'team-1' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// validateExperiencePackDraft
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateExperiencePackDraft', () => {
  test('AC#1: valid draft — title filled and source channel archived', () => {
    const result = validateExperiencePackDraft({
      title: 'My Pack',
      sourceChannelArchived: true,
    });
    expect(result.kind).toBe('valid');
  });

  test('AC#1: rejects empty title', () => {
    expect(validateExperiencePackDraft({ title: '', sourceChannelArchived: true }))
      .toEqual({ kind: 'error', reason: 'title_empty' });
    expect(validateExperiencePackDraft({ title: '   ', sourceChannelArchived: true }))
      .toEqual({ kind: 'error', reason: 'title_empty' });
  });

  test('AC#1: rejects unarchived source channel', () => {
    expect(validateExperiencePackDraft({ title: 'Pack', sourceChannelArchived: false }))
      .toEqual({ kind: 'error', reason: 'source_channel_not_archived' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateExperiencePackApproval（AC#3：第一次确认）
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateExperiencePackApproval', () => {
  function makeInput(over: Partial<EvaluateExperiencePackApprovalInput> = {}): EvaluateExperiencePackApprovalInput {
    return {
      pack: draftPack(),
      actorId: 'user-1',
      canManageTeam: true,
      ...over,
    };
  }

  test('AC#3: draft → approved by team admin', () => {
    const result = evaluateExperiencePackApproval(makeInput());
    expect(result.kind).toBe('approved');
  });

  test('AC#3: rejects non-draft status', () => {
    expect(evaluateExperiencePackApproval(makeInput({ pack: approvedPack() })))
      .toEqual({ kind: 'error', reason: 'not_draft' });
    expect(evaluateExperiencePackApproval(makeInput({ pack: sourceInvalidPack() })))
      .toEqual({ kind: 'error', reason: 'not_draft' });
    expect(evaluateExperiencePackApproval(makeInput({ pack: withdrawnPack() })))
      .toEqual({ kind: 'error', reason: 'not_draft' });
  });

  test('AC#3: rejects non-admin actor', () => {
    expect(evaluateExperiencePackApproval(makeInput({ canManageTeam: false })))
      .toEqual({ kind: 'error', reason: 'forbidden' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateExperiencePackSourceValidity（AC#6：来源失效）
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateExperiencePackSourceValidity', () => {
  function makeInput(over: Partial<EvaluateExperiencePackSourceValidityInput> = {}): EvaluateExperiencePackSourceValidityInput {
    return {
      pack: approvedPack(),
      actorId: 'user-1',
      canManageTeam: true,
      reason: 'Source channel deleted',
      ...over,
    };
  }

  test('AC#6: approved → source_invalid with reason', () => {
    const result = evaluateExperiencePackSourceValidity(makeInput());
    expect(result.kind).toBe('source_invalidated');
  });

  test('AC#6: rejects non-approved status', () => {
    expect(evaluateExperiencePackSourceValidity(makeInput({ pack: draftPack() })))
      .toEqual({ kind: 'error', reason: 'not_approved' });
    expect(evaluateExperiencePackSourceValidity(makeInput({ pack: sourceInvalidPack() })))
      .toEqual({ kind: 'error', reason: 'not_approved' });
    expect(evaluateExperiencePackSourceValidity(makeInput({ pack: withdrawnPack() })))
      .toEqual({ kind: 'error', reason: 'not_approved' });
  });

  test('AC#6: rejects empty reason', () => {
    expect(evaluateExperiencePackSourceValidity(makeInput({ reason: '' })))
      .toEqual({ kind: 'error', reason: 'reason_empty' });
    expect(evaluateExperiencePackSourceValidity(makeInput({ reason: '   ' })))
      .toEqual({ kind: 'error', reason: 'reason_empty' });
  });

  test('AC#6: rejects non-admin actor', () => {
    expect(evaluateExperiencePackSourceValidity(makeInput({ canManageTeam: false })))
      .toEqual({ kind: 'error', reason: 'forbidden' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateExperiencePackWithdrawal（AC#7：撤回）
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateExperiencePackWithdrawal', () => {
  function makeInput(over: Partial<EvaluateExperiencePackWithdrawalInput> = {}): EvaluateExperiencePackWithdrawalInput {
    return {
      pack: approvedPack(),
      actorId: 'user-1',
      canManageTeam: true,
      ...over,
    };
  }

  test('AC#7: approved → withdrawn', () => {
    const result = evaluateExperiencePackWithdrawal(makeInput());
    expect(result.kind).toBe('withdrawn');
  });

  test('AC#7: source_invalid → withdrawn', () => {
    const result = evaluateExperiencePackWithdrawal(makeInput({ pack: sourceInvalidPack() }));
    expect(result.kind).toBe('withdrawn');
  });

  test('AC#7: rejects draft (not withdrawable)', () => {
    expect(evaluateExperiencePackWithdrawal(makeInput({ pack: draftPack() })))
      .toEqual({ kind: 'error', reason: 'not_withdrawable' });
  });

  test('AC#7: rejects already withdrawn', () => {
    expect(evaluateExperiencePackWithdrawal(makeInput({ pack: withdrawnPack() })))
      .toEqual({ kind: 'error', reason: 'not_withdrawable' });
  });

  test('AC#7: rejects non-admin actor', () => {
    expect(evaluateExperiencePackWithdrawal(makeInput({ canManageTeam: false })))
      .toEqual({ kind: 'error', reason: 'forbidden' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateExperiencePackRecommendation（#723：推荐门控）
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateExperiencePackRecommendation', () => {
  function makeInput(over: Partial<EvaluateExperiencePackRecommendationInput> = {}): EvaluateExperiencePackRecommendationInput {
    return {
      pack: approvedPack(),
      channel: { teamId: 'team-1', archivedAt: null },
      actorId: 'user-1',
      ...over,
    };
  }

  test('approved pack recommendable to active channel in same team', () => {
    const result = evaluateExperiencePackRecommendation(makeInput());
    expect(result.kind).toBe('recommendable');
  });

  test('rejects non-approved pack', () => {
    expect(evaluateExperiencePackRecommendation(makeInput({ pack: draftPack() })))
      .toEqual({ kind: 'error', reason: 'pack_not_approved' });
    expect(evaluateExperiencePackRecommendation(makeInput({ pack: sourceInvalidPack() })))
      .toEqual({ kind: 'error', reason: 'pack_not_approved' });
    expect(evaluateExperiencePackRecommendation(makeInput({ pack: withdrawnPack() })))
      .toEqual({ kind: 'error', reason: 'pack_not_approved' });
  });

  test('rejects archived channel', () => {
    expect(evaluateExperiencePackRecommendation(makeInput({
      channel: { teamId: 'team-1', archivedAt: 1234 },
    }))).toEqual({ kind: 'error', reason: 'channel_archived' });
  });

  test('rejects cross-team recommendation', () => {
    expect(evaluateExperiencePackRecommendation(makeInput({
      pack: approvedPack({ teamId: 'team-2' }),
      channel: { teamId: 'team-1', archivedAt: null },
    }))).toEqual({ kind: 'error', reason: 'cross_team' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateExperiencePackConfirmation（#723：确认门控）
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateExperiencePackConfirmation', () => {
  function makeInput(over: Partial<EvaluateExperiencePackConfirmationInput> = {}): EvaluateExperiencePackConfirmationInput {
    return {
      attachment: { status: 'pending' },
      actorId: 'user-1',
      isChannelMember: true,
      ...over,
    };
  }

  test('pending + channel member → confirmed', () => {
    const result = evaluateExperiencePackConfirmation(makeInput());
    expect(result.kind).toBe('confirmed');
  });

  test('rejects non-pending attachment', () => {
    expect(evaluateExperiencePackConfirmation(makeInput({
      attachment: { status: 'attached' },
    }))).toEqual({ kind: 'error', reason: 'not_pending' });
    expect(evaluateExperiencePackConfirmation(makeInput({
      attachment: { status: 'revoked' },
    }))).toEqual({ kind: 'error', reason: 'not_pending' });
  });

  test('rejects non-channel-member', () => {
    expect(evaluateExperiencePackConfirmation(makeInput({ isChannelMember: false })))
      .toEqual({ kind: 'error', reason: 'not_channel_member' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateExperiencePackRevocation（#723：撤销门控）
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateExperiencePackRevocation', () => {
  function makeInput(over: Partial<EvaluateExperiencePackRevocationInput> = {}): EvaluateExperiencePackRevocationInput {
    return {
      attachment: { status: 'attached' },
      actorId: 'user-1',
      canRevoke: true,
      ...over,
    };
  }

  test('attached → revoked by authorized user', () => {
    const result = evaluateExperiencePackRevocation(makeInput());
    expect(result.kind).toBe('revocable');
  });

  test('pending → revoked by authorized user', () => {
    const result = evaluateExperiencePackRevocation(makeInput({
      attachment: { status: 'pending' },
    }));
    expect(result.kind).toBe('revocable');
  });

  test('rejects already revoked attachment', () => {
    expect(evaluateExperiencePackRevocation(makeInput({
      attachment: { status: 'revoked' },
    }))).toEqual({ kind: 'error', reason: 'not_revokable' });
  });

  test('rejects unauthorized actor', () => {
    expect(evaluateExperiencePackRevocation(makeInput({ canRevoke: false })))
      .toEqual({ kind: 'error', reason: 'forbidden' });
  });
});

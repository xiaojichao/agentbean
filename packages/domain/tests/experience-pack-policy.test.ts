import { describe, expect, test } from 'vitest';

import {
  evaluateExperiencePackApproval,
  evaluateExperiencePackAttachment,
  evaluateExperiencePackSourceValidity,
  evaluateExperiencePackWithdrawal,
  validateExperiencePackDraft,
  type EvaluateExperiencePackApprovalInput,
  type EvaluateExperiencePackAttachmentInput,
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
// evaluateExperiencePackAttachment（ADR 0006：频道关联门控）
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateExperiencePackAttachment', () => {
  function makeInput(over: Partial<EvaluateExperiencePackAttachmentInput> = {}): EvaluateExperiencePackAttachmentInput {
    return {
      pack: approvedPack(),
      channel: { teamId: 'team-1', archivedAt: null },
      actorId: 'user-1',
      canManageChannel: true,
      ...over,
    };
  }

  test('approved pack attachable to active channel in same team', () => {
    const result = evaluateExperiencePackAttachment(makeInput());
    expect(result.kind).toBe('attachable');
  });

  test('rejects non-approved pack', () => {
    expect(evaluateExperiencePackAttachment(makeInput({ pack: draftPack() })))
      .toEqual({ kind: 'error', reason: 'pack_not_approved' });
    expect(evaluateExperiencePackAttachment(makeInput({ pack: sourceInvalidPack() })))
      .toEqual({ kind: 'error', reason: 'pack_not_approved' });
    expect(evaluateExperiencePackAttachment(makeInput({ pack: withdrawnPack() })))
      .toEqual({ kind: 'error', reason: 'pack_not_approved' });
  });

  test('rejects archived channel', () => {
    expect(evaluateExperiencePackAttachment(makeInput({
      channel: { teamId: 'team-1', archivedAt: 1234 },
    }))).toEqual({ kind: 'error', reason: 'channel_archived' });
  });

  test('rejects cross-team attachment', () => {
    expect(evaluateExperiencePackAttachment(makeInput({
      pack: approvedPack({ teamId: 'team-2' }),
      channel: { teamId: 'team-1', archivedAt: null },
    }))).toEqual({ kind: 'error', reason: 'cross_team' });
  });

  test('rejects non-admin actor', () => {
    expect(evaluateExperiencePackAttachment(makeInput({ canManageChannel: false })))
      .toEqual({ kind: 'error', reason: 'forbidden' });
  });
});

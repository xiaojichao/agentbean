import type { AttachmentStatus, ExperiencePackStatus } from '@agentbean/contracts';

/**
 * Experience Pack 生命周期策略（issue #722 + #723）。
 *
 * 纯函数，无 I/O——遵循 `channel-archive-policy.ts` 模式。所有状态迁移在此集中校验；
 * server 侧在调用 repository 之前调本模块做门控。
 *
 * Pack 生命周期：draft → approved → source_invalid | withdrawn
 * Attachment 生命周期：pending → attached → revoked（#723）
 * - pending：PI 或用户推荐，等待目标频道成员确认
 * - attached：频道成员确认后生效，进入 Active Memory Context
 * - revoked：用户撤销，保留审计记录
 */

/** 合法的 Pack 单步状态迁移。 */
const VALID_TRANSITIONS: Record<ExperiencePackStatus, readonly ExperiencePackStatus[]> = {
  draft: ['approved'],
  approved: ['source_invalid', 'withdrawn'],
  source_invalid: ['withdrawn'],
  withdrawn: [],
};

/** 合法的 Attachment 单步状态迁移（#723）。 */
const ATTACHMENT_TRANSITIONS: Record<AttachmentStatus, readonly AttachmentStatus[]> = {
  pending: ['attached', 'revoked'],
  attached: ['revoked'],
  revoked: ['pending'], // revive：已撤销的可被重新推荐
};

// ── 校验输入 ──────────────────────────────────────────────────────────────────

export interface ValidateExperiencePackDraftInput {
  readonly title: string;
  /** 来源频道是否已归档（AC#1：归档后才可提 draft）。 */
  readonly sourceChannelArchived: boolean;
}

export interface ValidateExperiencePackDraftResult {
  readonly kind: 'valid';
}

export interface ValidateExperiencePackDraftError {
  readonly kind: 'error';
  readonly reason: 'title_empty' | 'source_channel_not_archived';
}

export type ValidateExperiencePackDraftOutput =
  | ValidateExperiencePackDraftResult
  | ValidateExperiencePackDraftError;

/** AC#1：校验 draft 必填字段与来源频道归档前提。 */
export function validateExperiencePackDraft(
  input: ValidateExperiencePackDraftInput,
): ValidateExperiencePackDraftOutput {
  if (!input.title || input.title.trim().length === 0) {
    return { kind: 'error', reason: 'title_empty' };
  }
  if (!input.sourceChannelArchived) {
    return { kind: 'error', reason: 'source_channel_not_archived' };
  }
  return { kind: 'valid' };
}

// ── 审批门控（draft → approved，第一次确认）───────────────────────────────────

export interface EvaluateExperiencePackApprovalInput {
  readonly pack: {
    readonly status: ExperiencePackStatus;
    readonly teamId: string;
  };
  readonly actorId: string;
  /** actor 是否是 Team Owner/Admin（AC#3：审批权限）。 */
  readonly canManageTeam: boolean;
}

export interface EvaluateExperiencePackApprovalSuccess {
  readonly kind: 'approved';
}

export interface EvaluateExperiencePackApprovalError {
  readonly kind: 'error';
  readonly reason: 'not_draft' | 'forbidden';
}

export type EvaluateExperiencePackApprovalOutput =
  | EvaluateExperiencePackApprovalSuccess
  | EvaluateExperiencePackApprovalError;

/** AC#3：draft → approved 状态迁移门控（第一次确认）。 */
export function evaluateExperiencePackApproval(
  input: EvaluateExperiencePackApprovalInput,
): EvaluateExperiencePackApprovalOutput {
  if (!VALID_TRANSITIONS[input.pack.status].includes('approved')) {
    return { kind: 'error', reason: 'not_draft' };
  }
  if (!input.canManageTeam) {
    return { kind: 'error', reason: 'forbidden' };
  }
  return { kind: 'approved' };
}

// ── 来源失效门控（approved → source_invalid）─────────────────────────────────

export interface EvaluateExperiencePackSourceValidityInput {
  readonly pack: {
    readonly status: ExperiencePackStatus;
    readonly teamId: string;
  };
  readonly actorId: string;
  readonly canManageTeam: boolean;
  /** 失效原因（AC#6：审计保留）。 */
  readonly reason: string;
}

export interface EvaluateExperiencePackSourceValiditySuccess {
  readonly kind: 'source_invalidated';
}

export interface EvaluateExperiencePackSourceValidityError {
  readonly kind: 'error';
  readonly reason: 'not_approved' | 'forbidden' | 'reason_empty';
}

export type EvaluateExperiencePackSourceValidityOutput =
  | EvaluateExperiencePackSourceValiditySuccess
  | EvaluateExperiencePackSourceValidityError;

/** AC#6：approved → source_invalid 状态迁移门控。 */
export function evaluateExperiencePackSourceValidity(
  input: EvaluateExperiencePackSourceValidityInput,
): EvaluateExperiencePackSourceValidityOutput {
  if (!VALID_TRANSITIONS[input.pack.status].includes('source_invalid')) {
    return { kind: 'error', reason: 'not_approved' };
  }
  if (!input.canManageTeam) {
    return { kind: 'error', reason: 'forbidden' };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return { kind: 'error', reason: 'reason_empty' };
  }
  return { kind: 'source_invalidated' };
}

// ── 撤回门控（approved | source_invalid → withdrawn）─────────────────────────

export interface EvaluateExperiencePackWithdrawalInput {
  readonly pack: {
    readonly status: ExperiencePackStatus;
    readonly teamId: string;
  };
  readonly actorId: string;
  readonly canManageTeam: boolean;
}

export interface EvaluateExperiencePackWithdrawalSuccess {
  readonly kind: 'withdrawn';
}

export interface EvaluateExperiencePackWithdrawalError {
  readonly kind: 'error';
  readonly reason: 'not_withdrawable' | 'forbidden';
}

export type EvaluateExperiencePackWithdrawalOutput =
  | EvaluateExperiencePackWithdrawalSuccess
  | EvaluateExperiencePackWithdrawalError;

/** AC#7：approved | source_invalid → withdrawn 状态迁移门控。 */
export function evaluateExperiencePackWithdrawal(
  input: EvaluateExperiencePackWithdrawalInput,
): EvaluateExperiencePackWithdrawalOutput {
  const allowed = VALID_TRANSITIONS[input.pack.status];
  if (!allowed.includes('withdrawn')) {
    return { kind: 'error', reason: 'not_withdrawable' };
  }
  if (!input.canManageTeam) {
    return { kind: 'error', reason: 'forbidden' };
  }
  return { kind: 'withdrawn' };
}

// ── 频道推荐门控（#723：PI 推荐 approved Pack 到目标频道）───────────────────────

export interface EvaluateExperiencePackRecommendationInput {
  readonly pack: {
    readonly status: ExperiencePackStatus;
    readonly teamId: string;
  };
  readonly channel: {
    readonly teamId: string;
    readonly archivedAt: number | null;
  };
  readonly actorId: string;
}

export interface EvaluateExperiencePackRecommendationSuccess {
  readonly kind: 'recommendable';
}

export interface EvaluateExperiencePackRecommendationError {
  readonly kind: 'error';
  readonly reason:
    | 'pack_not_approved'
    | 'channel_archived'
    | 'cross_team';
}

export type EvaluateExperiencePackRecommendationOutput =
  | EvaluateExperiencePackRecommendationSuccess
  | EvaluateExperiencePackRecommendationError;

/**
 * 频道推荐门控（#723：第一次确认后 PI 可推荐）。
 * - Pack 必须已批准
 * - 目标频道不能跨 Team
 * - 目标频道不能已归档
 * - 不再要求 admin 权限（PI 也可推荐）
 */
export function evaluateExperiencePackRecommendation(
  input: EvaluateExperiencePackRecommendationInput,
): EvaluateExperiencePackRecommendationOutput {
  if (input.pack.status !== 'approved') {
    return { kind: 'error', reason: 'pack_not_approved' };
  }
  if (input.pack.teamId !== input.channel.teamId) {
    return { kind: 'error', reason: 'cross_team' };
  }
  if (input.channel.archivedAt != null) {
    return { kind: 'error', reason: 'channel_archived' };
  }
  return { kind: 'recommendable' };
}

// ── 确认门控（#723：pending → attached）─────────────────────────────────────────

export interface EvaluateExperiencePackConfirmationInput {
  readonly attachment: {
    readonly status: AttachmentStatus;
  };
  readonly actorId: string;
  readonly isChannelMember: boolean;
}

export interface EvaluateExperiencePackConfirmationSuccess {
  readonly kind: 'confirmed';
}

export interface EvaluateExperiencePackConfirmationError {
  readonly kind: 'error';
  readonly reason: 'not_pending' | 'not_channel_member';
}

export type EvaluateExperiencePackConfirmationOutput =
  | EvaluateExperiencePackConfirmationSuccess
  | EvaluateExperiencePackConfirmationError;

/** #723：pending → attached 状态迁移门控（频道成员确认）。 */
export function evaluateExperiencePackConfirmation(
  input: EvaluateExperiencePackConfirmationInput,
): EvaluateExperiencePackConfirmationOutput {
  if (!ATTACHMENT_TRANSITIONS[input.attachment.status].includes('attached')) {
    return { kind: 'error', reason: 'not_pending' };
  }
  if (!input.isChannelMember) {
    return { kind: 'error', reason: 'not_channel_member' };
  }
  return { kind: 'confirmed' };
}

// ── 撤销门控（#723：attached | pending → revoked）───────────────────────────────

export interface EvaluateExperiencePackRevocationInput {
  readonly attachment: {
    readonly status: AttachmentStatus;
  };
  readonly actorId: string;
  /** 频道成员或 Team Admin 均可撤销。 */
  readonly canRevoke: boolean;
}

export interface EvaluateExperiencePackRevocationSuccess {
  readonly kind: 'revocable';
}

export interface EvaluateExperiencePackRevocationError {
  readonly kind: 'error';
  readonly reason: 'not_revokable' | 'forbidden';
}

export type EvaluateExperiencePackRevocationOutput =
  | EvaluateExperiencePackRevocationSuccess
  | EvaluateExperiencePackRevocationError;

/** #723：attached | pending → revoked 状态迁移门控。 */
export function evaluateExperiencePackRevocation(
  input: EvaluateExperiencePackRevocationInput,
): EvaluateExperiencePackRevocationOutput {
  if (!ATTACHMENT_TRANSITIONS[input.attachment.status].includes('revoked')) {
    return { kind: 'error', reason: 'not_revokable' };
  }
  if (!input.canRevoke) {
    return { kind: 'error', reason: 'forbidden' };
  }
  return { kind: 'revocable' };
}

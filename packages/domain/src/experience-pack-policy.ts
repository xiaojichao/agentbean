import type { ExperiencePackStatus } from '@agentbean/contracts';

/**
 * Experience Pack 生命周期策略（issue #722）。
 *
 * 纯函数，无 I/O——遵循 `channel-archive-policy.ts` 模式。所有状态迁移在此集中校验；
 * server 侧在调用 repository 之前调本模块做门控。
 *
 * 生命周期：draft → approved → source_invalid | withdrawn
 * - draft → approved：用户第一次确认（AC#3）
 * - approved → source_invalid：来源删除/权限撤销/被证错误（AC#6）
 * - approved|source_invalid → withdrawn：用户撤回（AC#7）
 */

/** 合法的单步状态迁移。 */
const VALID_TRANSITIONS: Record<ExperiencePackStatus, readonly ExperiencePackStatus[]> = {
  draft: ['approved'],
  approved: ['source_invalid', 'withdrawn'],
  source_invalid: ['withdrawn'],
  withdrawn: [],
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
  readonly reason: 'not_draft' | 'forbidden' | 'team_mismatch';
}

export type EvaluateExperiencePackApprovalOutput =
  | EvaluateExperiencePackApprovalSuccess
  | EvaluateExperiencePackApprovalError;

/** AC#3：draft → approved 状态迁移门控（第一次确认）。 */
export function evaluateExperiencePackApproval(
  input: EvaluateExperiencePackApprovalInput,
): EvaluateExperiencePackApprovalOutput {
  if (input.pack.status !== 'draft') {
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
  if (input.pack.status !== 'approved') {
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

// ── 频道关联门控（第二次确认的前置校验）───────────────────────────────────────

export interface EvaluateExperiencePackAttachmentInput {
  readonly pack: {
    readonly status: ExperiencePackStatus;
    readonly teamId: string;
  };
  readonly channel: {
    readonly teamId: string;
    readonly archivedAt: number | null;
  };
  readonly actorId: string;
  /** actor 是否有权管理目标频道。 */
  readonly canManageChannel: boolean;
}

export interface EvaluateExperiencePackAttachmentSuccess {
  readonly kind: 'attachable';
}

export interface EvaluateExperiencePackAttachmentError {
  readonly kind: 'error';
  readonly reason:
    | 'pack_not_approved'
    | 'channel_archived'
    | 'cross_team'
    | 'forbidden';
}

export type EvaluateExperiencePackAttachmentOutput =
  | EvaluateExperiencePackAttachmentSuccess
  | EvaluateExperiencePackAttachmentError;

/**
 * 频道关联门控（第二次确认的前置校验，ADR 0006）。
 * - Pack 必须已批准
 * - 目标频道不能是跨 Team
 * - 目标频道不能已归档
 * - actor 必须有频道管理权限
 */
export function evaluateExperiencePackAttachment(
  input: EvaluateExperiencePackAttachmentInput,
): EvaluateExperiencePackAttachmentOutput {
  if (input.pack.status !== 'approved') {
    return { kind: 'error', reason: 'pack_not_approved' };
  }
  if (input.pack.teamId !== input.channel.teamId) {
    return { kind: 'error', reason: 'cross_team' };
  }
  if (input.channel.archivedAt != null) {
    return { kind: 'error', reason: 'channel_archived' };
  }
  if (!input.canManageChannel) {
    return { kind: 'error', reason: 'forbidden' };
  }
  return { kind: 'attachable' };
}

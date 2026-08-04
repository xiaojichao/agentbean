import type { ChannelArchivePreflightItemDto, ChannelArchiveWorkKind } from '@agentbean/contracts';

export interface ArchiveConfirmationTokenPayload {
  channelId: string;
  channelRevision: number;
  userId: string;
  teamId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ArchivePreflightWorkItem {
  kind: ChannelArchiveWorkKind;
  id: string;
  title?: string;
  status: string;
}

export interface ArchivePreflightSummary {
  tasks: number;
  invocations: number;
  claims: number;
  leases: number;
  offers: number;
  pendingReviews: number;
  /** #1066：尚未收敛为 OutputPackage 的 committed 交付数。 */
  pendingDeliveries: number;
}

export interface EvaluateArchivePreflightInput {
  channel: {
    id: string;
    revision: number;
    archivedAt: number | null;
  };
  userId: string;
  teamId: string;
  now: number;
  tokenExpiresInMs: number;
  sign: (payload: string) => string;
  works: {
    tasks: readonly { id: string; title?: string; status: string }[];
    invocations: readonly { id: string; title?: string; status: string }[];
    claims: readonly { id: string; title?: string; status: string }[];
    leases: readonly { id: string; title?: string; status: string }[];
    offers: readonly { id: string; title?: string; status: string }[];
    pendingReviews: readonly { id: string; title?: string; status: string }[];
    /** #1066：package 级待审核 delivery（reviews 表 pending 且绑定 package）。 */
    pendingReviewDeliveries: readonly { id: string; title?: string; status: string }[];
    /** #1066：publish 已 committed 但尚未形成 OutputPackage 的交付（pendingDeliveries 差集）。 */
    pendingDeliveries: readonly { id: string; title?: string; status: string }[];
  };
}

export interface EvaluateArchivePreflightResult {
  kind: 'preflight';
  channelId: string;
  channelRevision: number;
  confirmationToken: string;
  expiresAt: number;
  summary: ArchivePreflightSummary;
  items: ChannelArchivePreflightItemDto[];
}

export interface EvaluateArchivePreflightError {
  kind: 'error';
  reason: 'already_archived' | 'forbidden';
}

export type EvaluateArchivePreflightOutput =
  | EvaluateArchivePreflightResult
  | EvaluateArchivePreflightError;

export function evaluateArchivePreflight(
  input: EvaluateArchivePreflightInput,
): EvaluateArchivePreflightOutput {
  if (input.channel.archivedAt != null) {
    return { kind: 'error', reason: 'already_archived' };
  }

  const items: ChannelArchivePreflightItemDto[] = [
    ...input.works.tasks.map((task) => ({ kind: 'task' as const, id: task.id, title: task.title, status: task.status })),
    ...input.works.invocations.map((invocation) => ({
      kind: 'invocation' as const,
      id: invocation.id,
      title: invocation.title,
      status: invocation.status,
    })),
    ...input.works.claims.map((claim) => ({ kind: 'claim' as const, id: claim.id, title: claim.title, status: claim.status })),
    ...input.works.leases.map((lease) => ({ kind: 'lease' as const, id: lease.id, title: lease.title, status: lease.status })),
    ...input.works.offers.map((offer) => ({ kind: 'offer' as const, id: offer.id, title: offer.title, status: offer.status })),
    ...input.works.pendingReviews.map((review) => ({
      kind: 'pending_review' as const,
      id: review.id,
      title: review.title,
      status: review.status,
    })),
    ...input.works.pendingReviewDeliveries.map((review) => ({
      kind: 'pending_review_delivery' as const,
      id: review.id,
      title: review.title,
      status: review.status,
    })),
    ...input.works.pendingDeliveries.map((delivery) => ({
      kind: 'pending_delivery' as const,
      id: delivery.id,
      title: delivery.title,
      status: delivery.status,
    })),
  ];

  const expiresAt = input.now + input.tokenExpiresInMs;
  const payload: ArchiveConfirmationTokenPayload = {
    channelId: input.channel.id,
    channelRevision: input.channel.revision,
    userId: input.userId,
    teamId: input.teamId,
    issuedAt: input.now,
    expiresAt,
  };
  const token = `${base64UrlEncode(JSON.stringify(payload))}.${input.sign(base64UrlEncode(JSON.stringify(payload)))}`;

  return {
    kind: 'preflight',
    channelId: input.channel.id,
    channelRevision: input.channel.revision,
    confirmationToken: token,
    expiresAt,
    summary: {
      tasks: input.works.tasks.length,
      invocations: input.works.invocations.length,
      claims: input.works.claims.length,
      leases: input.works.leases.length,
      offers: input.works.offers.length,
      pendingReviews: input.works.pendingReviews.length,
      pendingDeliveries: input.works.pendingDeliveries.length,
    },
    items,
  };
}

export interface VerifyArchiveConfirmationTokenInput {
  token: string;
  verifySignature: (payload: string, signature: string) => boolean;
}

export interface VerifiedArchiveToken {
  kind: 'verified';
  payload: ArchiveConfirmationTokenPayload;
}

export interface InvalidArchiveToken {
  kind: 'invalid';
  reason: 'malformed' | 'signature_mismatch';
}

export type VerifyArchiveConfirmationTokenOutput =
  | VerifiedArchiveToken
  | InvalidArchiveToken;

export function verifyArchiveConfirmationToken(
  input: VerifyArchiveConfirmationTokenInput,
): VerifyArchiveConfirmationTokenOutput {
  const parts = input.token.split('.');
  if (parts.length !== 2) {
    return { kind: 'invalid', reason: 'malformed' };
  }

  const [payloadBase64, signature] = parts;
  if (!payloadBase64 || !signature) {
    return { kind: 'invalid', reason: 'malformed' };
  }

  if (!input.verifySignature(payloadBase64, signature)) {
    return { kind: 'invalid', reason: 'signature_mismatch' };
  }

  let payloadJson: string;
  try {
    payloadJson = base64UrlDecode(payloadBase64);
  } catch {
    return { kind: 'invalid', reason: 'malformed' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { kind: 'invalid', reason: 'malformed' };
  }

  if (!isArchiveConfirmationTokenPayload(payload)) {
    return { kind: 'invalid', reason: 'malformed' };
  }

  return { kind: 'verified', payload };
}

export interface EvaluateArchiveConfirmationInput {
  channel: {
    id: string;
    revision: number;
    archivedAt: number | null;
  };
  userId: string;
  teamId: string;
  now: number;
  token: string;
  verifySignature: (payload: string, signature: string) => boolean;
  canArchive: boolean;
}

export interface EvaluateArchiveConfirmationSuccess {
  kind: 'confirmed';
  payload: ArchiveConfirmationTokenPayload;
}

export interface EvaluateArchiveConfirmationError {
  kind: 'error';
  reason:
    | 'invalid_token'
    | 'token_expired'
    | 'channel_revision_changed'
    | 'already_archived'
    | 'forbidden'
    | 'user_mismatch'
    | 'team_mismatch'
    | 'channel_mismatch';
}

export type EvaluateArchiveConfirmationOutput =
  | EvaluateArchiveConfirmationSuccess
  | EvaluateArchiveConfirmationError;

export function evaluateArchiveConfirmation(
  input: EvaluateArchiveConfirmationInput,
): EvaluateArchiveConfirmationOutput {
  if (input.channel.archivedAt != null) {
    return { kind: 'error', reason: 'already_archived' };
  }

  if (!input.canArchive) {
    return { kind: 'error', reason: 'forbidden' };
  }

  const verified = verifyArchiveConfirmationToken({
    token: input.token,
    verifySignature: input.verifySignature,
  });

  if (verified.kind === 'invalid') {
    return { kind: 'error', reason: 'invalid_token' };
  }

  const payload = verified.payload;

  if (payload.expiresAt <= input.now) {
    return { kind: 'error', reason: 'token_expired' };
  }

  if (payload.channelId !== input.channel.id) {
    return { kind: 'error', reason: 'channel_mismatch' };
  }

  if (payload.teamId !== input.teamId) {
    return { kind: 'error', reason: 'team_mismatch' };
  }

  if (payload.userId !== input.userId) {
    return { kind: 'error', reason: 'user_mismatch' };
  }

  if (payload.channelRevision !== input.channel.revision) {
    return { kind: 'error', reason: 'channel_revision_changed' };
  }

  return { kind: 'confirmed', payload };
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, 'base64').toString('utf-8');
}

function isArchiveConfirmationTokenPayload(value: unknown): value is ArchiveConfirmationTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.channelId === 'string' &&
    typeof v.channelRevision === 'number' &&
    typeof v.userId === 'string' &&
    typeof v.teamId === 'string' &&
    typeof v.issuedAt === 'number' &&
    typeof v.expiresAt === 'number'
  );
}

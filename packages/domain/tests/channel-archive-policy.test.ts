import { describe, expect, test } from 'vitest';

import {
  evaluateArchiveConfirmation,
  evaluateArchivePreflight,
  verifyArchiveConfirmationToken,
  type EvaluateArchivePreflightInput,
} from '../src/channel-archive-policy.js';

const NOW = 1_000_000;
const TTL = 600_000;

function sign(payload: string): string {
  return `sig:${payload}`;
}

function verify(payload: string, signature: string): boolean {
  return signature === `sig:${payload}`;
}

function makePreflightInput(over: Partial<EvaluateArchivePreflightInput> = {}): EvaluateArchivePreflightInput {
  return {
    channel: { id: 'channel-1', revision: 5, archivedAt: null },
    userId: 'user-1',
    teamId: 'team-1',
    now: NOW,
    tokenExpiresInMs: TTL,
    sign,
    works: {
      tasks: [],
      invocations: [],
      claims: [],
      leases: [],
      offers: [],
      pendingReviews: [],
      pendingReviewDeliveries: [],
      pendingDeliveries: [],
    },
    ...over,
  };
}

describe('evaluateArchivePreflight', () => {
  test('returns preflight with empty summary when no active work', () => {
    const result = evaluateArchivePreflight(makePreflightInput());

    expect(result.kind).toBe('preflight');
    if (result.kind !== 'preflight') return;

    expect(result.channelId).toBe('channel-1');
    expect(result.channelRevision).toBe(5);
    expect(result.expiresAt).toBe(NOW + TTL);
    expect(result.summary).toEqual({
      tasks: 0,
      invocations: 0,
      claims: 0,
      leases: 0,
      offers: 0,
      pendingReviews: 0,
      pendingDeliveries: 0,
    });
    expect(result.items).toEqual([]);
    expect(result.confirmationToken).toBeTruthy();
  });

  test('aggregates all active work kinds', () => {
    const result = evaluateArchivePreflight(
      makePreflightInput({
        works: {
          tasks: [{ id: 'task-1', title: 'Task 1', status: 'in_progress' }],
          invocations: [{ id: 'inv-1', status: 'running' }],
          claims: [{ id: 'claim-1', status: 'active' }],
          leases: [{ id: 'lease-1', status: 'active' }],
          offers: [{ id: 'offer-1', status: 'open' }],
          pendingReviews: [{ id: 'task-2', title: 'Task 2', status: 'in_review' }],
          // #1066：package 级待审核 delivery 与未收敛 projection 一并列入 gate。
          pendingReviewDeliveries: [{ id: 'package-1', title: 'package package-1', status: 'pending' }],
          pendingDeliveries: [{ id: 'publish-1', title: 'publish publish-1', status: 'committed' }],
        },
      }),
    );

    expect(result.kind).toBe('preflight');
    if (result.kind !== 'preflight') return;

    expect(result.summary).toEqual({
      tasks: 1,
      invocations: 1,
      claims: 1,
      leases: 1,
      offers: 1,
      pendingReviews: 1,
      pendingDeliveries: 1,
    });
    expect(result.items.map((item) => item.kind).sort()).toEqual([
      'claim',
      'invocation',
      'lease',
      'offer',
      'pending_delivery',
      'pending_review',
      'pending_review_delivery',
      'task',
    ]);
  });

  test('rejects archived channel', () => {
    const result = evaluateArchivePreflight(
      makePreflightInput({ channel: { id: 'channel-1', revision: 5, archivedAt: NOW - 1 } }),
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.reason).toBe('already_archived');
  });
});

describe('verifyArchiveConfirmationToken', () => {
  test('accepts a valid token', () => {
    const preflight = evaluateArchivePreflight(makePreflightInput());
    expect(preflight.kind).toBe('preflight');
    if (preflight.kind !== 'preflight') return;

    const verified = verifyArchiveConfirmationToken({
      token: preflight.confirmationToken,
      verifySignature: verify,
    });

    expect(verified.kind).toBe('verified');
    if (verified.kind !== 'verified') return;

    expect(verified.payload.channelId).toBe('channel-1');
    expect(verified.payload.channelRevision).toBe(5);
    expect(verified.payload.userId).toBe('user-1');
    expect(verified.payload.teamId).toBe('team-1');
  });

  test('rejects malformed token', () => {
    const result = verifyArchiveConfirmationToken({ token: 'not-a-token', verifySignature: verify });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.reason).toBe('malformed');
  });

  test('rejects signature mismatch', () => {
    const result = verifyArchiveConfirmationToken({
      token: 'eyJmb28iOiJiYXIifQ.badsignature',
      verifySignature: () => false,
    });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.reason).toBe('signature_mismatch');
  });
});

describe('evaluateArchiveConfirmation', () => {
  function validToken(): string {
    const preflight = evaluateArchivePreflight(makePreflightInput());
    expect(preflight.kind).toBe('preflight');
    if (preflight.kind !== 'preflight') throw new Error('unexpected');
    return preflight.confirmationToken;
  }

  test('confirms with valid token and matching state', () => {
    const result = evaluateArchiveConfirmation({
      channel: { id: 'channel-1', revision: 5, archivedAt: null },
      userId: 'user-1',
      teamId: 'team-1',
      now: NOW + 1,
      token: validToken(),
      verifySignature: verify,
      canArchive: true,
    });

    expect(result.kind).toBe('confirmed');
    if (result.kind !== 'confirmed') return;
    expect(result.payload.channelId).toBe('channel-1');
  });

  test('rejects expired token', () => {
    const result = evaluateArchiveConfirmation({
      channel: { id: 'channel-1', revision: 5, archivedAt: null },
      userId: 'user-1',
      teamId: 'team-1',
      now: NOW + TTL + 1,
      token: validToken(),
      verifySignature: verify,
      canArchive: true,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.reason).toBe('token_expired');
  });

  test('rejects revision drift', () => {
    const result = evaluateArchiveConfirmation({
      channel: { id: 'channel-1', revision: 6, archivedAt: null },
      userId: 'user-1',
      teamId: 'team-1',
      now: NOW + 1,
      token: validToken(),
      verifySignature: verify,
      canArchive: true,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.reason).toBe('channel_revision_changed');
  });

  test('rejects archived channel', () => {
    const result = evaluateArchiveConfirmation({
      channel: { id: 'channel-1', revision: 5, archivedAt: NOW - 1 },
      userId: 'user-1',
      teamId: 'team-1',
      now: NOW + 1,
      token: validToken(),
      verifySignature: verify,
      canArchive: true,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.reason).toBe('already_archived');
  });

  test('rejects user mismatch', () => {
    const result = evaluateArchiveConfirmation({
      channel: { id: 'channel-1', revision: 5, archivedAt: null },
      userId: 'user-2',
      teamId: 'team-1',
      now: NOW + 1,
      token: validToken(),
      verifySignature: verify,
      canArchive: true,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.reason).toBe('user_mismatch');
  });

  test('rejects team mismatch', () => {
    const result = evaluateArchiveConfirmation({
      channel: { id: 'channel-1', revision: 5, archivedAt: null },
      userId: 'user-1',
      teamId: 'team-2',
      now: NOW + 1,
      token: validToken(),
      verifySignature: verify,
      canArchive: true,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.reason).toBe('team_mismatch');
  });

  test('rejects insufficient permission', () => {
    const result = evaluateArchiveConfirmation({
      channel: { id: 'channel-1', revision: 5, archivedAt: null },
      userId: 'user-1',
      teamId: 'team-1',
      now: NOW + 1,
      token: validToken(),
      verifySignature: verify,
      canArchive: false,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.reason).toBe('forbidden');
  });
});

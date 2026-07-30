import { describe, expect, test } from 'vitest';
import {
  SYSTEM_ACTIVITY_COMMAND_NAMES,
  SYSTEM_ACTIVITY_FACT_KINDS,
  SYSTEM_ACTIVITY_LEVELS,
  SYSTEM_ACTIVITY_QUERY_NAMES,
  canonicalizeSystemActivityCommand,
  decodeSystemActivityCursor,
  encodeSystemActivityCursor,
  parseConsistencyTokenV1,
  parseSystemActivityCommandEnvelopeV1,
  parseSystemActivityCommandInputV1,
  parseSystemActivityQueryInputV1,
  parseSystemActivitySourceFactV1,
  type SystemActivityCommandEnvelopeV1,
  type SystemActivitySourceFactV1,
} from '../src/system-activity.js';

const INVALID = /SYSTEM_ACTIVITY_PAYLOAD_INVALID/;

const fact: SystemActivitySourceFactV1 = {
  schemaVersion: 1,
  eventId: 'evt-1',
  streamKind: 'task',
  streamId: 'task-1',
  sequence: 3,
  teamId: 'team-1',
  taskId: 'task-1',
  channelId: 'ch-1',
  factKind: 'in_review',
  occurredAt: 1000,
  visibleRecipientIds: ['user-a', 'user-b'],
  responsibleRecipientIds: ['user-a'],
  summary: '交付已提交，等待验收',
  attentionKey: 'review:task-1',
  taskRevision: 2,
  deliveryRevision: 1,
  allowedCommands: ['accept-root-delivery', 'reject-root-delivery'],
  confirmationToken: 'tok-1',
  escalationRevision: 1,
};

const envelope: SystemActivityCommandEnvelopeV1 = {
  schemaVersion: 1,
  commandName: 'project-source-fact',
  commandSchemaVersion: 1,
  idempotencyKey: 'idem-1',
};

describe('SYSTEM_ACTIVITY vocabulary', () => {
  test('frozen query/command sets', () => {
    expect(SYSTEM_ACTIVITY_QUERY_NAMES).toContain('query-task-activity');
    expect(SYSTEM_ACTIVITY_QUERY_NAMES).toContain('pull-change-feed');
    expect(SYSTEM_ACTIVITY_COMMAND_NAMES).toContain('mark-attention-seen');
    expect(SYSTEM_ACTIVITY_COMMAND_NAMES).toContain('ack-change-feed-cursor');
    expect(SYSTEM_ACTIVITY_LEVELS).toContain('action_required');
    expect(SYSTEM_ACTIVITY_FACT_KINDS).toContain('action_required_opened');
  });
});

describe('parseSystemActivitySourceFactV1', () => {
  test('accepts valid fact', () => {
    expect(parseSystemActivitySourceFactV1(fact).eventId).toBe('evt-1');
  });
  test('rejects pi-like empty summary', () => {
    expect(() => parseSystemActivitySourceFactV1({ ...fact, summary: '' })).toThrow(INVALID);
  });
  test('rejects unknown factKind', () => {
    expect(() => parseSystemActivitySourceFactV1({ ...fact, factKind: 'lease_renewed' })).toThrow(INVALID);
  });
});

describe('cursor encode/decode', () => {
  test('round-trips opaque cursor', () => {
    const opaque = encodeSystemActivityCursor({
      schemaVersion: 1,
      audienceUserId: 'user-a',
      teamId: 'team-1',
      surface: 'change_feed',
      position: 12,
      feedEpoch: 1,
    });
    expect(typeof opaque).toBe('string');
    expect(opaque.includes('{')).toBe(false);
    const decoded = decodeSystemActivityCursor(opaque);
    expect(decoded.position).toBe(12);
    expect(decoded.audienceUserId).toBe('user-a');
  });
  test('rejects garbage cursor', () => {
    expect(() => decodeSystemActivityCursor('%%%not-base64%%%')).toThrow(INVALID);
  });
});

describe('command/query inputs', () => {
  test('project-source-fact', () => {
    const input = parseSystemActivityCommandInputV1('project-source-fact', {
      fact,
      projectionWatermark: 5,
    });
    expect(input.fact.eventId).toBe('evt-1');
  });

  test('mark-attention-seen requires revision', () => {
    expect(() => parseSystemActivityCommandInputV1('mark-attention-seen', {
      attentionIdentity: 'attn:1',
      recipientId: 'user-a',
    })).toThrow(INVALID);
    const input = parseSystemActivityCommandInputV1('mark-attention-seen', {
      attentionIdentity: 'attn:1',
      recipientId: 'user-a',
      expectedRevision: 2,
    });
    expect(input.expectedRevision).toBe(2);
  });

  test('ack-change-feed-cursor validates opaque cursor', () => {
    const cursor = encodeSystemActivityCursor({
      schemaVersion: 1,
      audienceUserId: 'user-a',
      teamId: 'team-1',
      surface: 'change_feed',
      position: 1,
      feedEpoch: 0,
    });
    const input = parseSystemActivityCommandInputV1('ack-change-feed-cursor', {
      recipientId: 'user-a',
      cursor,
    });
    expect(input.recipientId).toBe('user-a');
  });

  test('query-task-activity supports minimumConsistency', () => {
    const token = parseConsistencyTokenV1({
      schemaVersion: 1,
      entries: [{ streamKind: 'task', streamId: 'task-1', revision: 4 }],
    });
    const input = parseSystemActivityQueryInputV1('query-task-activity', {
      taskId: 'task-1',
      recipientId: 'user-a',
      limit: 20,
      minimumConsistency: token,
    });
    expect(input.minimumConsistency?.entries[0]?.revision).toBe(4);
  });
});

describe('canonicalizeSystemActivityCommand', () => {
  test('stable hash input for same payload', () => {
    const a = canonicalizeSystemActivityCommand('mark-attention-seen', 1, {
      attentionIdentity: 'attn:1',
      recipientId: 'user-a',
      expectedRevision: 1,
    });
    const b = canonicalizeSystemActivityCommand('mark-attention-seen', 1, {
      expectedRevision: 1,
      recipientId: 'user-a',
      attentionIdentity: 'attn:1',
    });
    expect(a).toBe(b);
  });
});

describe('parseSystemActivityCommandEnvelopeV1', () => {
  test('accepts valid', () => {
    expect(parseSystemActivityCommandEnvelopeV1(envelope).commandName).toBe('project-source-fact');
  });
  test('rejects unknown command', () => {
    expect(() => parseSystemActivityCommandEnvelopeV1({
      ...envelope,
      commandName: 'send-message',
    })).toThrow(INVALID);
  });
});

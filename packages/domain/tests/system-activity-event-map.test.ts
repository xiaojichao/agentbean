import { describe, expect, test } from 'vitest';
import {
  deriveActivityAudience,
  mapLifecycleCommandToActivityFact,
  mapRemediationCommandToActivityFact,
} from '../src/system-activity-event-map.js';

describe('mapLifecycleCommandToActivityFact', () => {
  test('submit-root-delivery → in_review + attention', () => {
    const fact = mapLifecycleCommandToActivityFact({
      commandName: 'submit-root-delivery',
      teamId: 'team-1',
      taskId: 'task-1',
      taskRevision: 3,
      channelId: 'ch-1',
      visibleRecipientIds: ['u1', 'u2'],
      responsibleRecipientIds: ['u1'],
      eventId: 'e1',
      sequence: 3,
      occurredAt: 1000,
      deliveryMessageId: 'msg-1',
    });
    expect(fact?.factKind).toBe('in_review');
    expect(fact?.attentionKey).toBe('review:task-1');
    expect(fact?.allowedCommands).toContain('accept-root-delivery');
    expect(fact?.responsibleRecipientIds).toEqual(['u1']);
  });

  test('accept-root-delivery → delivery_accepted', () => {
    const fact = mapLifecycleCommandToActivityFact({
      commandName: 'accept-root-delivery',
      teamId: 'team-1',
      taskId: 'task-1',
      taskRevision: 4,
      visibleRecipientIds: ['u1'],
      responsibleRecipientIds: [],
      eventId: 'e2',
      sequence: 4,
      occurredAt: 2000,
    });
    expect(fact?.factKind).toBe('delivery_accepted');
    expect(fact?.attentionKey).toBeUndefined();
  });

  test('unknown mapping 返回 null', () => {
    // start-execution 有映射；用 visible 为空触发 null
    expect(mapLifecycleCommandToActivityFact({
      commandName: 'start-execution',
      teamId: 'team-1',
      taskId: 'task-1',
      taskRevision: 1,
      visibleRecipientIds: [],
      responsibleRecipientIds: [],
      eventId: 'e3',
      sequence: 1,
      occurredAt: 1,
    })).toBeNull();
  });
});

describe('mapRemediationCommandToActivityFact', () => {
  test('classify with AR → action_required_opened', () => {
    const fact = mapRemediationCommandToActivityFact({
      commandName: 'classify-failure',
      teamId: 'team-1',
      taskId: 'task-1',
      taskRevision: 2,
      visibleRecipientIds: ['u1', 'u2'],
      responsibleRecipientIds: ['u1'],
      eventId: 'e4',
      sequence: 2,
      occurredAt: 3000,
      actionRequiredId: 'ar-1',
      confirmationToken: 'tok',
      escalationRevision: 1,
      allowedCommands: ['retry-attempt'],
      failureClass: 'unknown',
    });
    expect(fact?.factKind).toBe('action_required_opened');
    expect(fact?.confirmationToken).toBe('tok');
    expect(fact?.allowedCommands).toContain('retry-attempt');
  });

  test('retry-attempt → action_required_resolved', () => {
    const fact = mapRemediationCommandToActivityFact({
      commandName: 'retry-attempt',
      teamId: 'team-1',
      taskId: 'task-1',
      taskRevision: 3,
      visibleRecipientIds: ['u1'],
      responsibleRecipientIds: ['u1'],
      eventId: 'e5',
      sequence: 3,
      occurredAt: 4000,
      actionRequiredId: 'ar-1',
    });
    expect(fact?.factKind).toBe('action_required_resolved');
  });
});

describe('deriveActivityAudience', () => {
  test('频道成员优先作为 visible', () => {
    const a = deriveActivityAudience({
      teamMemberIds: ['t1', 't2', 't3'],
      channelHumanMemberIds: ['c1', 'c2'],
      creatorId: 'c1',
      forReview: true,
    });
    expect(a.visibleRecipientIds).toEqual(['c1', 'c2']);
    expect(a.responsibleRecipientIds).toContain('c1');
  });
});

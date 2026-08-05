import { describe, expect, test } from 'vitest';
import type { SystemActivitySourceFactV1, SystemAttentionItemV1 } from '@agentbean/contracts';
import {
  assembleThreadTaskCard,
  checkMinimumConsistency,
  evaluateAckChangeFeedCursor,
  evaluateMarkAttentionSeen,
  evaluateNonResolvingAttentionSignal,
  projectSourceFact,
  resolveAudienceForSurface,
  reviewActionsFromAttention,
  shouldRetainProjectionForAudience,
  streamKey,
  surfacesForFact,
} from '../src/system-activity-policy.js';

function baseFact(overrides: Partial<SystemActivitySourceFactV1> = {}): SystemActivitySourceFactV1 {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    streamKind: 'task',
    streamId: 'task-1',
    sequence: 1,
    teamId: 'team-1',
    taskId: 'task-1',
    channelId: 'ch-1',
    threadId: 'th-1',
    factKind: 'task_created',
    occurredAt: 1000,
    visibleRecipientIds: ['user-a', 'user-b'],
    responsibleRecipientIds: ['user-a'],
    summary: '任务已创建',
    ...overrides,
  };
}

describe('audience scoping', () => {
  test('timeline 对 visible 成员开放；attention 仅责任人', () => {
    const fact = baseFact({ factKind: 'action_required_opened', attentionKey: 'esc:1' });
    expect(resolveAudienceForSurface(fact, 'task_timeline').recipientIds).toEqual(['user-a', 'user-b']);
    expect(resolveAudienceForSurface(fact, 'attention_inbox').recipientIds).toEqual(['user-a']);
  });

  test('权限变化后失去可见性的投影行应剔除', () => {
    expect(shouldRetainProjectionForAudience({
      recipientId: 'user-b',
      surface: 'task_timeline',
      visibleRecipientIds: ['user-a'],
      responsibleRecipientIds: ['user-a'],
    })).toBe(false);
    expect(shouldRetainProjectionForAudience({
      recipientId: 'user-a',
      surface: 'attention_inbox',
      visibleRecipientIds: ['user-a', 'user-b'],
      responsibleRecipientIds: ['user-a'],
    })).toBe(true);
  });
});

describe('projectSourceFact', () => {
  test('分层投影：timeline + thread milestone；PI actor 固定 system', () => {
    const result = projectSourceFact({
      fact: baseFact({ factKind: 'delivery_submitted', summary: '已提交交付' }),
      nextProjectionId: (i) => `p-${i}`,
      now: 2000,
    });
    expect(result.projections.every((p) => p.actorKind === 'system')).toBe(true);
    expect(result.projections.some((p) => p.surface === 'task_timeline')).toBe(true);
    expect(result.projections.some((p) => p.surface === 'thread_card')).toBe(true);
    // delivery_submitted 不是 attention 等级（milestone）
    expect(result.attentionUpserts).toHaveLength(0);
  });

  test('action_required 只给责任人建 attention，且带具名 commands', () => {
    const result = projectSourceFact({
      fact: baseFact({
        factKind: 'action_required_opened',
        attentionKey: 'esc:unknown',
        summary: '需要人工 remediation',
        responsibleRecipientIds: ['user-a'],
        visibleRecipientIds: ['user-a', 'user-b', 'user-c'],
        allowedCommands: ['retry-attempt', 'cancel-subtask'],
        confirmationToken: 'tok',
        escalationRevision: 1,
      }),
      nextProjectionId: (i) => `p-${i}`,
      now: 3000,
    });
    expect(result.attentionUpserts).toHaveLength(1);
    expect(result.attentionUpserts[0]?.recipientId).toBe('user-a');
    expect(result.attentionUpserts[0]?.level).toBe('action_required');
    expect(result.attentionUpserts[0]?.unread).toBe(true);
    expect(result.attentionUpserts[0]?.allowedCommands).toContain('retry-attempt');
    // user-b/c 可在 timeline 看到，但没有 attention
    const timelineRecipients = result.projections
      .filter((p) => p.surface === 'task_timeline')
      .map((p) => p.recipientId)
      .sort();
    expect(timelineRecipients).toEqual(['user-a', 'user-b', 'user-c']);
    const attentionRecipients = result.projections
      .filter((p) => p.surface === 'attention_inbox')
      .map((p) => p.recipientId);
    expect(attentionRecipients).toEqual(['user-a']);
  });

  test('重复 reminder 不递增 revision、不重置 seen', () => {
    const existing: SystemAttentionItemV1 = {
      schemaVersion: 1,
      attentionIdentity: 'attn:task-1:esc:1:user-a',
      teamId: 'team-1',
      recipientId: 'user-a',
      taskId: 'task-1',
      level: 'action_required',
      state: 'open',
      revision: 2,
      sourceEventId: 'evt-old',
      summary: '需要人工 remediation',
      unread: false,
      seenAt: 1500,
      createdAt: 1000,
      updatedAt: 1500,
      allowedCommands: ['retry-attempt'],
      confirmationToken: 'tok',
      escalationRevision: 2,
    };
    const map = new Map([[existing.attentionIdentity, existing]]);
    const result = projectSourceFact({
      fact: baseFact({
        eventId: 'evt-reminder',
        factKind: 'action_required_opened',
        attentionKey: 'esc:1',
        summary: '需要人工 remediation',
        allowedCommands: ['retry-attempt'],
        confirmationToken: 'tok',
        escalationRevision: 2,
      }),
      nextProjectionId: (i) => `p-${i}`,
      existingAttentionByIdentity: map,
      now: 4000,
    });
    expect(result.attentionUpserts).toHaveLength(1);
    expect(result.attentionUpserts[0]?.revision).toBe(2);
    expect(result.attentionUpserts[0]?.unread).toBe(false);
    expect(result.attentionUpserts[0]?.seenAt).toBe(1500);
    expect(result.attentionUpserts[0]?.lastReminderAt).toBe(4000);
  });

  test('实质升级递增 revision 并重新 unread', () => {
    const existing: SystemAttentionItemV1 = {
      schemaVersion: 1,
      attentionIdentity: 'attn:task-1:esc:1:user-a',
      teamId: 'team-1',
      recipientId: 'user-a',
      taskId: 'task-1',
      level: 'attention',
      state: 'open',
      revision: 1,
      sourceEventId: 'evt-old',
      summary: '等待中',
      unread: false,
      seenAt: 1500,
      createdAt: 1000,
      updatedAt: 1500,
    };
    const map = new Map([[existing.attentionIdentity, existing]]);
    const result = projectSourceFact({
      fact: baseFact({
        eventId: 'evt-upgrade',
        factKind: 'action_required_opened',
        attentionKey: 'esc:1',
        summary: '升级为人工处置',
        allowedCommands: ['retry-attempt'],
        confirmationToken: 'tok-2',
        escalationRevision: 2,
      }),
      nextProjectionId: (i) => `p-${i}`,
      existingAttentionByIdentity: map,
      now: 5000,
    });
    expect(result.attentionUpserts[0]?.revision).toBeGreaterThan(1);
    expect(result.attentionUpserts[0]?.unread).toBe(true);
    expect(result.attentionUpserts[0]?.level).toBe('action_required');
    expect(result.attentionUpserts[0]?.seenAt).toBeUndefined();
  });
});

describe('mark-seen / non-resolving signals', () => {
  const openItem: SystemAttentionItemV1 = {
    schemaVersion: 1,
    attentionIdentity: 'attn:1',
    teamId: 'team-1',
    recipientId: 'user-a',
    taskId: 'task-1',
    level: 'action_required',
    state: 'open',
    revision: 3,
    sourceEventId: 'evt-1',
    summary: '需要处理',
    unread: true,
    createdAt: 1,
    updatedAt: 1,
    allowedCommands: ['retry-attempt'],
    confirmationToken: 'tok',
  };

  test('seen 只清 unread，仍 open', () => {
    const decision = evaluateMarkAttentionSeen({
      item: openItem,
      recipientId: 'user-a',
      expectedRevision: 3,
      now: 9000,
    });
    expect(decision.kind).toBe('applied');
    if (decision.kind === 'applied') {
      expect(decision.unread).toBe(false);
      expect(decision.stillOpen).toBe(true);
      expect(decision.item.state).toBe('open');
    }
  });

  test('stale revision 拒绝', () => {
    const decision = evaluateMarkAttentionSeen({
      item: openItem,
      recipientId: 'user-a',
      expectedRevision: 2,
      now: 9000,
    });
    expect(decision).toEqual({ kind: 'rejected', reason: 'stale_attention_revision' });
  });

  test('read/seen/dismiss/cursor ack 均不结束责任', () => {
    for (const signal of ['read', 'seen', 'dismiss', 'change_feed_cursor_ack', 'notice_failed'] as const) {
      const r = evaluateNonResolvingAttentionSignal(openItem, signal);
      expect(r.stillOpen).toBe(true);
      expect(r.stateUnchanged).toBe(true);
    }
  });
});

describe('change feed cursor ack', () => {
  test('只推进 feed position，三独立边界均为 false', () => {
    const r = evaluateAckChangeFeedCursor({ cursorPosition: 10, currentAckedPosition: 4 });
    expect(r.ackedPosition).toBe(10);
    expect(r.advancedMessageRead).toBe(false);
    expect(r.advancedAttention).toBe(false);
    expect(r.advancedTaskResponsibility).toBe(false);
  });
});

describe('consistency token', () => {
  test('投影滞后明确 not-ready', () => {
    const watermarks = new Map([[streamKey('task', 'task-1'), 2]]);
    const result = checkMinimumConsistency({
      minimum: {
        schemaVersion: 1,
        entries: [{ streamKind: 'task', streamId: 'task-1', revision: 5 }],
      },
      currentWatermarks: watermarks,
    });
    expect(result.kind).toBe('projection_not_ready');
    if (result.kind === 'projection_not_ready') {
      expect(result.notReadyStreams[0]?.revision).toBe(5);
    }
  });

  test('水位足够时 ready', () => {
    const watermarks = new Map([[streamKey('task', 'task-1'), 5]]);
    const result = checkMinimumConsistency({
      minimum: {
        schemaVersion: 1,
        entries: [{ streamKind: 'task', streamId: 'task-1', revision: 5 }],
      },
      currentWatermarks: watermarks,
    });
    expect(result.kind).toBe('ready');
  });
});

describe('review actions', () => {
  test('open attention 暴露绑定的具名 commands', () => {
    const item: SystemAttentionItemV1 = {
      schemaVersion: 1,
      attentionIdentity: 'attn:1',
      teamId: 'team-1',
      recipientId: 'user-a',
      taskId: 'task-1',
      level: 'attention',
      state: 'open',
      revision: 1,
      sourceEventId: 'e',
      summary: 'in review',
      unread: true,
      createdAt: 1,
      updatedAt: 1,
      allowedCommands: ['accept-root-delivery', 'reject-root-delivery'],
    };
    expect(reviewActionsFromAttention(item)).toEqual([
      'accept-root-delivery',
      'reject-root-delivery',
    ]);
  });
});

describe('thread card', () => {
  test('稀疏里程碑组装', () => {
    const fact = baseFact({ factKind: 'in_review', sequence: 5, summary: '待验收' });
    const projected = projectSourceFact({
      fact,
      nextProjectionId: (i) => `p-${i}`,
      now: 1,
    });
    const milestones = projected.projections.filter((p) => p.surface === 'thread_card' && p.recipientId === 'user-a');
    const card = assembleThreadTaskCard({
      taskId: 'task-1',
      channelId: 'ch-1',
      threadId: 'th-1',
      milestones,
      asOf: 99,
      audienceScope: 'team-1:user-a',
    });
    expect(card.currentSummary).toBe('待验收');
    expect(card.milestones.length).toBeGreaterThan(0);
  });

  test('surfacesForFact 覆盖 action_required', () => {
    expect(surfacesForFact('action_required_opened')).toContain('attention_inbox');
    expect(surfacesForFact('task_created')).toContain('thread_card');
    expect(surfacesForFact('execution_started')).toContain('task_timeline');
  });
});

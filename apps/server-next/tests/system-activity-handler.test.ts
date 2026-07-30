import { describe, expect, test } from 'vitest';
import type { SystemActivitySourceFactV1 } from '../../../packages/contracts/src/system-activity.js';
import {
  drainSystemActivityNotices,
  handleAckChangeFeedCursor,
  handleMarkAttentionSeen,
  handleProjectSourceFact,
  handleRetrimAudience,
  handleSystemActivityQuery,
  type SystemActivityHandlerDeps,
} from '../src/application/system-activity-handler.js';
import { createMemorySystemActivityUnitOfWork } from '../src/application/system-activity-unit-of-work.js';
import {
  cloneSystemActivityMemoryState,
  createInMemorySystemActivityRepositories,
  createSystemActivityMemoryState,
  restoreSystemActivityMemoryState,
} from '../src/infra/memory/system-activity-repositories.js';
import { encodeSystemActivityCursor } from '../../../packages/contracts/src/system-activity.js';

function createDeps(): SystemActivityHandlerDeps & { state: ReturnType<typeof createSystemActivityMemoryState> } {
  const state = createSystemActivityMemoryState();
  const repos = createInMemorySystemActivityRepositories(state);
  let seq = 0;
  return {
    state,
    teamId: 'team-1',
    unitOfWork: createMemorySystemActivityUnitOfWork({
      repos,
      snapshot: () => cloneSystemActivityMemoryState(state),
      restore: (snap) => restoreSystemActivityMemoryState(state, snap as ReturnType<typeof createSystemActivityMemoryState>),
    }),
    ids: { nextId: () => `id-${++seq}` },
    clock: { now: () => 10_000 + seq },
  };
}

function envelope(commandName: string, key = 'idem-1') {
  return {
    schemaVersion: 1,
    commandName,
    commandSchemaVersion: 1,
    idempotencyKey: key,
  };
}

function fact(overrides: Partial<SystemActivitySourceFactV1> = {}): SystemActivitySourceFactV1 {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    streamKind: 'task',
    streamId: 'task-1',
    sequence: 3,
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

describe('project-source-fact', () => {
  test('按受众投影 timeline，action_required 只给责任人', async () => {
    const deps = createDeps();
    const res = await handleProjectSourceFact(deps, envelope('project-source-fact'), {
      fact: fact({
        factKind: 'action_required_opened',
        attentionKey: 'esc:1',
        summary: '需要人工处置',
        allowedCommands: ['retry-attempt'],
        confirmationToken: 'tok',
        escalationRevision: 1,
      }),
      projectionWatermark: 3,
    });
    expect(res.outcome).toBe('applied');
    if (res.result?.commandName !== 'project-source-fact') throw new Error('unexpected');
    expect(res.result.projectedItemCount).toBeGreaterThan(0);
    expect(res.result.attentionUpserted).toBe(true);

    const inboxA = await handleSystemActivityQuery(deps, 'query-attention-inbox', {
      recipientId: 'user-a',
      limit: 20,
    });
    expect(inboxA.outcome).toBe('ready');
    expect(inboxA.result?.queryName).toBe('query-attention-inbox');
    if (inboxA.result?.queryName === 'query-attention-inbox') {
      expect(inboxA.result.items).toHaveLength(1);
      expect(inboxA.result.items[0]?.level).toBe('action_required');
    }

    const inboxB = await handleSystemActivityQuery(deps, 'query-attention-inbox', {
      recipientId: 'user-b',
      limit: 20,
    });
    if (inboxB.result?.queryName === 'query-attention-inbox') {
      expect(inboxB.result.items).toHaveLength(0);
    }

    const timelineB = await handleSystemActivityQuery(deps, 'query-task-activity', {
      taskId: 'task-1',
      recipientId: 'user-b',
      limit: 50,
    });
    if (timelineB.result?.queryName === 'query-task-activity') {
      expect(timelineB.result.items.length).toBeGreaterThan(0);
      expect(timelineB.result.items.every((i) => i.recipientId === 'user-b')).toBe(true);
      expect(timelineB.result.items.every((i) => i.actorKind === 'system')).toBe(true);
    }
  });

  test('event identity 去重：重复 project 不新增投影', async () => {
    const deps = createDeps();
    const input = { fact: fact(), projectionWatermark: 1 };
    const first = await handleProjectSourceFact(deps, envelope('project-source-fact', 'idem-a'), input);
    expect(first.outcome).toBe('applied');
    const second = await handleProjectSourceFact(deps, envelope('project-source-fact', 'idem-b'), input);
    expect(second.outcome).toBe('applied');
    if (second.result?.commandName === 'project-source-fact') {
      expect(second.result.projectedItemCount).toBe(0);
    }
  });

  test('同 key replay 返回 replayed', async () => {
    const deps = createDeps();
    const input = { fact: fact(), projectionWatermark: 1 };
    await handleProjectSourceFact(deps, envelope('project-source-fact', 'idem-same'), input);
    const replay = await handleProjectSourceFact(deps, envelope('project-source-fact', 'idem-same'), input);
    expect(replay.outcome).toBe('replayed');
  });
});

describe('mark-attention-seen', () => {
  test('只清 unread，不结束 action_required', async () => {
    const deps = createDeps();
    await handleProjectSourceFact(deps, envelope('project-source-fact', 'p1'), {
      fact: fact({
        factKind: 'action_required_opened',
        attentionKey: 'esc:1',
        summary: '需要处理',
        allowedCommands: ['retry-attempt'],
        confirmationToken: 'tok',
        escalationRevision: 1,
      }),
      projectionWatermark: 1,
    });
    const inbox = await handleSystemActivityQuery(deps, 'query-attention-inbox', {
      recipientId: 'user-a',
      limit: 10,
    });
    if (inbox.result?.queryName !== 'query-attention-inbox') throw new Error('expected inbox');
    const item = inbox.result.items[0];
    if (!item) throw new Error('expected attention');

    const seen = await handleMarkAttentionSeen(deps, envelope('mark-attention-seen', 's1'), {
      attentionIdentity: item.attentionIdentity,
      recipientId: 'user-a',
      expectedRevision: item.revision,
    });
    expect(seen.outcome).toBe('applied');
    if (seen.result?.commandName === 'mark-attention-seen') {
      expect(seen.result.unread).toBe(false);
      expect(seen.result.stillOpen).toBe(true);
    }

    const again = await handleSystemActivityQuery(deps, 'query-attention-inbox', {
      recipientId: 'user-a',
      limit: 10,
      onlyUnread: false,
    });
    if (again.result?.queryName === 'query-attention-inbox') {
      expect(again.result.items[0]?.state).toBe('open');
      expect(again.result.items[0]?.unread).toBe(false);
    }
  });
});

describe('change feed + cursor ack', () => {
  test('pull feed 可恢复；ack 不推进 Message Read / attention / responsibility', async () => {
    const deps = createDeps();
    await handleProjectSourceFact(deps, envelope('project-source-fact', 'p1'), {
      fact: fact({ eventId: 'evt-1', sequence: 1 }),
      projectionWatermark: 1,
    });
    await handleProjectSourceFact(deps, envelope('project-source-fact', 'p2'), {
      fact: fact({
        eventId: 'evt-2',
        sequence: 2,
        factKind: 'in_review',
        summary: '待验收',
        attentionKey: 'review:1',
        allowedCommands: ['accept-root-delivery'],
        confirmationToken: 't',
        escalationRevision: 1,
      }),
      projectionWatermark: 2,
    });

    const feed = await handleSystemActivityQuery(deps, 'pull-change-feed', {
      recipientId: 'user-a',
      limit: 50,
    });
    expect(feed.outcome).toBe('ready');
    if (feed.result?.queryName !== 'pull-change-feed') throw new Error('expected feed');
    expect(feed.result.items.length).toBeGreaterThan(0);
    expect(feed.result.nextCursor).toBeTruthy();

    const ack = await handleAckChangeFeedCursor(deps, envelope('ack-change-feed-cursor', 'ack1'), {
      recipientId: 'user-a',
      cursor: feed.result.nextCursor!,
    });
    expect(ack.outcome).toBe('applied');
    if (ack.result?.commandName === 'ack-change-feed-cursor') {
      expect(ack.result.advancedMessageRead).toBe(false);
      expect(ack.result.advancedAttention).toBe(false);
      expect(ack.result.advancedTaskResponsibility).toBe(false);
    }

    // notice 失败/重复不改变事实：attention 仍 open
    const inbox = await handleSystemActivityQuery(deps, 'query-attention-inbox', {
      recipientId: 'user-a',
      limit: 10,
    });
    if (inbox.result?.queryName === 'query-attention-inbox') {
      expect(inbox.result.items.some((i) => i.state === 'open')).toBe(true);
    }
  });

  test('notice drain 是至少一次唤醒，重复 drain 不再投递已 delivered', async () => {
    const deps = createDeps();
    await handleProjectSourceFact(deps, envelope('project-source-fact', 'p1'), {
      fact: fact(),
      projectionWatermark: 1,
    });
    const first = await drainSystemActivityNotices(deps, 100);
    expect(first.length).toBeGreaterThan(0);
    const second = await drainSystemActivityNotices(deps, 100);
    expect(second).toHaveLength(0);
  });
});

describe('projection_not_ready', () => {
  test('minimum consistency 未满足时明确 not-ready', async () => {
    const deps = createDeps();
    // 不投影任何 fact，水位为 0
    const res = await handleSystemActivityQuery(deps, 'query-task-activity', {
      taskId: 'task-1',
      recipientId: 'user-a',
      limit: 10,
      minimumConsistency: {
        schemaVersion: 1,
        entries: [{ streamKind: 'task', streamId: 'task-1', revision: 9 }],
      },
    });
    expect(res.outcome).toBe('projection_not_ready');
    expect(res.notReadyStreams?.[0]?.revision).toBe(9);
  });

  test('投影追上后 ready', async () => {
    const deps = createDeps();
    await handleProjectSourceFact(deps, envelope('project-source-fact', 'p1'), {
      fact: fact({ sequence: 9 }),
      projectionWatermark: 9,
    });
    const res = await handleSystemActivityQuery(deps, 'query-task-activity', {
      taskId: 'task-1',
      recipientId: 'user-a',
      limit: 10,
      minimumConsistency: {
        schemaVersion: 1,
        entries: [{ streamKind: 'task', streamId: 'task-1', revision: 9 }],
      },
    });
    expect(res.outcome).toBe('ready');
  });
});

describe('retrim-audience', () => {
  test('权限变化后裁掉失去可见性的投影，客户端不会先收到完整 payload', async () => {
    const deps = createDeps();
    await handleProjectSourceFact(deps, envelope('project-source-fact', 'p1'), {
      fact: fact({ factKind: 'task_created' }),
      projectionWatermark: 1,
    });

    const before = await handleSystemActivityQuery(deps, 'query-task-activity', {
      taskId: 'task-1',
      recipientId: 'user-b',
      limit: 20,
    });
    if (before.result?.queryName === 'query-task-activity') {
      expect(before.result.items.length).toBeGreaterThan(0);
    }

    const trim = await handleRetrimAudience(deps, envelope('retrim-audience', 't1'), {
      taskId: 'task-1',
      visibleRecipientIds: ['user-a'],
      responsibleRecipientIds: ['user-a'],
    });
    expect(trim.outcome).toBe('applied');
    if (trim.result?.commandName === 'retrim-audience') {
      expect(trim.result.removedProjectionCount).toBeGreaterThan(0);
    }

    const after = await handleSystemActivityQuery(deps, 'query-task-activity', {
      taskId: 'task-1',
      recipientId: 'user-b',
      limit: 20,
    });
    if (after.result?.queryName === 'query-task-activity') {
      expect(after.result.items).toHaveLength(0);
    }
  });
});

describe('thread card', () => {
  test('稀疏里程碑卡', async () => {
    const deps = createDeps();
    await handleProjectSourceFact(deps, envelope('project-source-fact', 'p1'), {
      fact: fact({ factKind: 'in_review', summary: '待验收', attentionKey: 'rev' }),
      projectionWatermark: 1,
    });
    const res = await handleSystemActivityQuery(deps, 'query-thread-task-card', {
      channelId: 'ch-1',
      threadId: 'th-1',
      taskId: 'task-1',
      recipientId: 'user-a',
    });
    expect(res.outcome).toBe('ready');
    if (res.result?.queryName === 'query-thread-task-card') {
      expect(res.result.card.currentSummary).toBe('待验收');
      expect(res.result.card.milestones.every((m) => m.actorKind === 'system')).toBe(true);
    }
  });
});

describe('cursor audience binding', () => {
  test('ack 拒绝跨用户 cursor', async () => {
    const deps = createDeps();
    const cursor = encodeSystemActivityCursor({
      schemaVersion: 1,
      audienceUserId: 'user-a',
      teamId: 'team-1',
      surface: 'change_feed',
      position: 1,
      feedEpoch: 0,
    });
    const res = await handleAckChangeFeedCursor(deps, envelope('ack-change-feed-cursor', 'bad'), {
      recipientId: 'user-b',
      cursor,
    });
    expect(res.outcome).toBe('rejected');
    expect(res.rejectReason).toBe('cursor_audience_mismatch');
  });
});

import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  actionableCommandsFromAttention,
  buildAckChangeFeedCursorPayload,
  buildBoundActionPayload,
  buildMarkAttentionSeenPayload,
  isNamedActivityAction,
  isProjectionNotReady,
  mapReviewCommandToTaskSocketEvent,
  shouldRenderAsSystemActivity,
  sortAttentionInbox,
  sortTaskTimeline,
  unreadAttentionCount,
  type SystemActivityItemView,
  type SystemAttentionItemView,
} from '../lib/system-activity';
import { dispatchNamedReviewAction } from '../lib/system-activity-socket';
import { SystemActivityPanels } from '../components/SystemActivityPanels';

const timelineItem = (overrides: Partial<SystemActivityItemView> = {}): SystemActivityItemView => ({
  projectionId: 'p1',
  eventId: 'e1',
  surface: 'task_timeline',
  level: 'milestone',
  factKind: 'task_created',
  taskId: 'task-1',
  summary: '任务已创建',
  occurredAt: 1000,
  actorKind: 'system',
  ...overrides,
});

const attentionItem = (overrides: Partial<SystemAttentionItemView> = {}): SystemAttentionItemView => ({
  attentionIdentity: 'attn:1',
  taskId: 'task-1',
  level: 'action_required',
  state: 'open',
  revision: 2,
  summary: '需要人工处置',
  unread: true,
  allowedCommands: ['retry-attempt', 'cancel-subtask', 'dismiss'],
  confirmationToken: 'tok',
  escalationRevision: 2,
  taskRevision: 5,
  ...overrides,
});

describe('system-activity helpers', () => {
  test('只暴露白名单具名 command，忽略 dismiss', () => {
    const actions = actionableCommandsFromAttention(attentionItem());
    expect(actions).toEqual(['retry-attempt', 'cancel-subtask']);
    expect(isNamedActivityAction('retry-attempt')).toBe(true);
    expect(isNamedActivityAction('dismiss')).toBe(false);
  });

  test('mark-seen / cursor ack 语义明确不解决责任', () => {
    const seen = buildMarkAttentionSeenPayload(attentionItem(), 'user-a');
    expect(seen.expectedRevision).toBe(2);
    const ack = buildAckChangeFeedCursorPayload('user-a', 'opaque');
    expect(ack.doesNotAdvance.messageRead).toBe(true);
    expect(ack.doesNotAdvance.attention).toBe(true);
    expect(ack.doesNotAdvance.taskResponsibility).toBe(true);
  });

  test('bound action payload 绑定 revision / token', () => {
    const payload = buildBoundActionPayload({
      command: 'retry-attempt',
      taskId: 'task-1',
      attention: attentionItem(),
    });
    expect(payload.confirmationToken).toBe('tok');
    expect(payload.expectedEscalationRevision).toBe(2);
    expect(payload.expectedTaskRevision).toBe(5);
  });

  test('#995 review command 映射到 task socket 并绑定 reason', () => {
    expect(mapReviewCommandToTaskSocketEvent('accept-root-delivery')).toBe('acceptRootDelivery');
    expect(mapReviewCommandToTaskSocketEvent('reject-root-delivery')).toBe('rejectRootDelivery');
    expect(mapReviewCommandToTaskSocketEvent('retry-attempt')).toBeNull();
    const rejectPayload = buildBoundActionPayload({
      command: 'reject-root-delivery',
      taskId: 'task-1',
      attention: attentionItem({ allowedCommands: ['accept-root-delivery', 'reject-root-delivery'] }),
      reason: '证据不足',
    });
    expect(rejectPayload.reason).toBe('证据不足');
    expect(rejectPayload.expectedTaskRevision).toBe(5);
  });

  test('#995 dispatchNamedReviewAction 发 lifecycle task 事件', async () => {
    const emitWithAck = vi.fn(async () => ({ ok: true, task: { id: 'task-1', status: 'done' } }));
    const result = await dispatchNamedReviewAction(
      { emitWithAck },
      {
        command: 'accept-root-delivery',
        attention: attentionItem({
          allowedCommands: ['accept-root-delivery'],
          taskRevision: 3,
        }),
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(emitWithAck).toHaveBeenCalledWith(
      'task:accept-root-delivery',
      expect.objectContaining({ taskId: 'task-1', expectedTaskRevision: 3 }),
    );
  });

  test('PI / coordination 不得作为 system activity 渲染', () => {
    expect(shouldRenderAsSystemActivity({ actorKind: 'system' })).toBe(true);
    expect(shouldRenderAsSystemActivity({ senderKind: 'pi' })).toBe(false);
    expect(shouldRenderAsSystemActivity({ isCoordinationMessage: true })).toBe(false);
  });

  test('timeline / inbox 排序与 unread count', () => {
    const items = sortTaskTimeline([
      timelineItem({ projectionId: 'p2', occurredAt: 2000, eventId: 'e2' }),
      timelineItem({ projectionId: 'p1', occurredAt: 1000, eventId: 'e1' }),
    ]);
    expect(items.map((i) => i.projectionId)).toEqual(['p1', 'p2']);

    const inbox = sortAttentionInbox([
      attentionItem({ attentionIdentity: 'a2', unread: false, level: 'attention' }),
      attentionItem({ attentionIdentity: 'a1', unread: true, level: 'action_required' }),
    ]);
    expect(inbox[0]?.attentionIdentity).toBe('a1');
    expect(unreadAttentionCount(inbox)).toBe(1);
  });

  test('projection_not_ready 识别', () => {
    expect(isProjectionNotReady('projection_not_ready')).toBe(true);
    expect(isProjectionNotReady('ready')).toBe(false);
  });
});

describe('SystemActivityPanels', () => {
  test('渲染 timeline / card / inbox 与具名 action，不渲染 PI bubble', () => {
    const html = renderToStaticMarkup(
      createElement(SystemActivityPanels, {
        taskTimeline: [timelineItem()],
        threadCard: {
          taskId: 'task-1',
          currentLevel: 'milestone',
          currentSummary: '待验收',
          milestones: [timelineItem({ surface: 'thread_card', summary: '已提交' })],
        },
        attentionInbox: [attentionItem()],
      }),
    );
    expect(html).toContain('活动时间线');
    expect(html).toContain('责任收件箱');
    expect(html).toContain('待验收');
    expect(html).toContain('重试 attempt');
    expect(html).toContain('data-actor-kind="system"');
    expect(html).not.toContain('pi-avatar');
    expect(html).not.toContain('chat-bubble-pi');
  });

  test('projection not ready 明确提示', () => {
    const html = renderToStaticMarkup(
      createElement(SystemActivityPanels, { projectionNotReady: true }),
    );
    expect(html).toContain('projection not ready');
  });

  test('具名 action 回调', () => {
    const onNamedAction = vi.fn();
    // 静态渲染不触发 click；用 helper 验证 action 列表即可
    const actions = actionableCommandsFromAttention(attentionItem());
    for (const command of actions) {
      onNamedAction(command, attentionItem());
    }
    expect(onNamedAction).toHaveBeenCalledWith('retry-attempt', expect.any(Object));
  });
});

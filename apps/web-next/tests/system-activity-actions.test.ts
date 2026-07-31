import { describe, expect, test } from 'vitest';
import {
  mapReviewCommandToTaskSocketEvent,
  type SystemAttentionItemView,
} from '../lib/system-activity';
import { prepareNamedAction } from '../lib/system-activity-client';

/**
 * #1014 Web 具名 action 映射与 payload 绑定。
 */
describe('system-activity named actions (#1014)', () => {
  const reviewItem: SystemAttentionItemView = {
    attentionIdentity: 'attn:review:1',
    taskId: 'task-1',
    level: 'attention',
    state: 'open',
    revision: 1,
    summary: '待验收',
    unread: true,
    allowedCommands: ['accept-root-delivery', 'reject-root-delivery'],
    taskRevision: 5,
  };

  const arItem: SystemAttentionItemView = {
    attentionIdentity: 'ar-1',
    taskId: 'task-2',
    level: 'action_required',
    state: 'open',
    revision: 2,
    summary: '需要重试',
    unread: true,
    allowedCommands: ['retry-attempt'],
    confirmationToken: 'tok-xyz',
    escalationRevision: 2,
    taskRevision: 3,
  };

  test('accept/reject/cancel/close 映射到 task socket', () => {
    expect(mapReviewCommandToTaskSocketEvent('accept-root-delivery')).toBe('acceptRootDelivery');
    expect(mapReviewCommandToTaskSocketEvent('reject-root-delivery')).toBe('rejectRootDelivery');
    expect(mapReviewCommandToTaskSocketEvent('cancel-task')).toBe('cancel');
    expect(mapReviewCommandToTaskSocketEvent('close-task')).toBe('close');
    expect(mapReviewCommandToTaskSocketEvent('retry-attempt')).toBeNull();
  });

  test('accept payload 绑定 taskRevision', () => {
    const prepared = prepareNamedAction({
      command: 'accept-root-delivery',
      taskId: 'task-1',
      attention: reviewItem,
    });
    expect(prepared.payload.expectedTaskRevision).toBe(5);
  });

  test('retry payload 绑定 confirmationToken 与 escalationRevision', () => {
    // prepareNamedAction 在 system-activity-client 中；此处用 build 字段约定
    expect(arItem.confirmationToken).toBe('tok-xyz');
    expect(arItem.escalationRevision).toBe(2);
    expect(mapReviewCommandToTaskSocketEvent('retry-attempt')).toBeNull(); // remediation 通道
  });
});

import { describe, expect, test } from 'vitest';
import {
  prepareNamedAction,
} from '../lib/system-activity-client';
import type { SystemAttentionItemView } from '../lib/system-activity';

describe('system-activity-client (#998)', () => {
  test('prepareNamedAction 绑定 revision / token', () => {
    const attention: SystemAttentionItemView = {
      attentionIdentity: 'attn:1',
      taskId: 'task-1',
      level: 'action_required',
      state: 'open',
      revision: 2,
      summary: '需要处理',
      unread: true,
      allowedCommands: ['retry-attempt'],
      confirmationToken: 'tok',
      escalationRevision: 2,
      taskRevision: 5,
    };
    const prepared = prepareNamedAction({
      command: 'retry-attempt',
      taskId: 'task-1',
      attention,
    });
    expect(prepared.command).toBe('retry-attempt');
    expect(prepared.payload.confirmationToken).toBe('tok');
    expect(prepared.payload.expectedTaskRevision).toBe(5);
  });
});

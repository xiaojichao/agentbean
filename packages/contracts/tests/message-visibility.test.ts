import { describe, expect, test } from 'vitest';
import { isHiddenSystemMessage } from '../src/message.js';

describe('isHiddenSystemMessage', () => {
  test('隐藏 task-created 与 management-status 系统消息', () => {
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: { kind: 'task-created' } })).toBe(true);
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: { kind: 'management-status' } })).toBe(true);
  });

  test('隐藏 artifact-version-revision（文件状态变化不进聊天流）', () => {
    expect(isHiddenSystemMessage({
      senderKind: 'system',
      meta: { kind: 'artifact-version-revision', versionId: 'v-1' },
    })).toBe(true);
  });

  test('隐藏 PI 协调输出（meta.coordination）', () => {
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: { coordination: { action: 'suggest' } } })).toBe(true);
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: { coordination: {} } })).toBe(true);
  });

  test('保留 management-question / management-delivery 可见', () => {
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: { kind: 'management-question' } })).toBe(false);
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: { kind: 'management-delivery' } })).toBe(false);
  });

  test('保留 human/agent 与其它系统消息可见，容忍缺失 meta', () => {
    expect(isHiddenSystemMessage({ senderKind: 'human', meta: { kind: 'task-created' } })).toBe(false);
    expect(isHiddenSystemMessage({ senderKind: 'agent', meta: {} })).toBe(false);
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: { kind: 'task-status-updated' } })).toBe(false);
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: undefined })).toBe(false);
    expect(isHiddenSystemMessage({ senderKind: 'system', meta: null })).toBe(false);
  });
});

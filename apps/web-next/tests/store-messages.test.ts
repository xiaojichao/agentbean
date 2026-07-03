import { describe, expect, test } from 'vitest';
import { mergeMessagesByChannel } from '../lib/store';
import type { ChatMessage } from '../lib/schema';

function msg(id: string, channelId: string, senderKind: ChatMessage['senderKind'] = 'human'): ChatMessage {
  return { id, channelId, senderKind, senderId: 'u', body: '', createdAt: 0 };
}

describe('mergeMessagesByChannel', () => {
  test('新消息按 channelId 分组追加', () => {
    const result = mergeMessagesByChannel(
      { c1: [msg('m1', 'c1')] },
      [msg('m2', 'c1'), msg('m3', 'c2')],
    );
    expect(result.c1.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(result.c2.map((m) => m.id)).toEqual(['m3']);
  });

  test('已存在 id 不覆盖(保护 active channel 滚动状态)', () => {
    const existing = { c1: [{ ...msg('m1', 'c1'), body: 'old' }] };
    const result = mergeMessagesByChannel(existing, [{ ...msg('m1', 'c1'), body: 'new' }]);
    expect(result.c1[0].body).toBe('old');
  });

  test('同一批 msgs 内部去重', () => {
    const result = mergeMessagesByChannel({}, [msg('m1', 'c1'), msg('m1', 'c1')]);
    expect(result.c1.map((m) => m.id)).toEqual(['m1']);
  });

  test('无新增时返回原对象引用(让 Zustand bailout)', () => {
    const existing = { c1: [msg('m1', 'c1')] };
    expect(mergeMessagesByChannel(existing, [msg('m1', 'c1')])).toBe(existing);
  });

  test('空 msgs 返回原对象引用', () => {
    const existing = { c1: [msg('m1', 'c1')] };
    expect(mergeMessagesByChannel(existing, [])).toBe(existing);
  });
});

import { describe, expect, test } from 'vitest';
import { mergeSavedMessages } from '../lib/chat-scope';

interface Msg {
  id: string;
  createdAt: number;
  body?: string;
}

describe('mergeSavedMessages', () => {
  test('快照中存在、内存中没有的收藏仍保留（修复漏显根因）', () => {
    // 场景：消息 B 所属频道已不在可见会话里，listSaved 仍返回它，
    // 但内存 messagesByChannel 不含它 → 它必须被保留，否则 badge(2) ≠ 列表(1)。
    const snapshot: Msg[] = [
      { id: 'A', createdAt: 2, body: '消息A' },
      { id: 'B', createdAt: 1, body: '消息B（频道已不可见）' },
    ];
    const memory: Msg[] = [{ id: 'A', createdAt: 2, body: '消息A' }];

    const merged = mergeSavedMessages(snapshot, memory);

    expect(merged.map((m) => m.id).sort()).toEqual(['A', 'B']);
  });

  test('同 id 消息以内存版本优先（更新鲜）', () => {
    const snapshot: Msg[] = [{ id: 'A', createdAt: 1, body: '快照A' }];
    const memory: Msg[] = [{ id: 'A', createdAt: 1, body: '内存A-更新' }];

    const merged = mergeSavedMessages(snapshot, memory);

    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe('内存A-更新');
  });

  test('两份来源的不同 id 全部 union', () => {
    const snapshot: Msg[] = [{ id: 'A', createdAt: 3 }];
    const memory: Msg[] = [{ id: 'C', createdAt: 2 }];

    const merged = mergeSavedMessages(snapshot, memory);

    expect(merged.map((m) => m.id).sort()).toEqual(['A', 'C']);
  });

  test('结果按 createdAt 降序', () => {
    const snapshot: Msg[] = [
      { id: 'old', createdAt: 1 },
      { id: 'new', createdAt: 5 },
    ];

    const merged = mergeSavedMessages(snapshot, []);

    expect(merged.map((m) => m.id)).toEqual(['new', 'old']);
  });

  test('空快照 + 空内存返回空数组', () => {
    expect(mergeSavedMessages([], [])).toEqual([]);
  });
});

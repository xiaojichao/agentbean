import { describe, expect, test } from 'vitest';
import { extractMentions, resolveMentionByName, type MentionMember } from '../lib/mention';

// 真实症状：Agent 改名后，频道消息 body 里的 @旧名 应显示为新名。
// 根因：@提及只是 body 文本字符串，无 agentId 关联。修复：发送时 meta.mentions 锁定 id，
// 渲染用 id 解析当前 name。本回路覆盖核心纯逻辑（extractMentions 发送 / resolveMentionByName 渲染）。

describe('extractMentions (send time: lock id by name)', () => {
  test('locks agentId for body @name, skips unknown @tokens', () => {
    const members: MentionMember[] = [{ id: 'a1', name: 'codex', kind: 'agent' }];
    expect(extractMentions('@codex hi @nobody', members)).toEqual([
      { id: 'a1', kind: 'agent', name: 'codex', start: 0, end: 6 },
    ]);
  });

  test('records offset for multiple mentions', () => {
    const members: MentionMember[] = [
      { id: 'a1', name: 'codex', kind: 'agent' },
      { id: 'u1', name: 'alice', kind: 'human' },
    ];
    expect(extractMentions('@codex 问 @alice', members)).toEqual([
      { id: 'a1', kind: 'agent', name: 'codex', start: 0, end: 6 },
      { id: 'u1', kind: 'human', name: 'alice', start: 9, end: 15 },
    ]);
  });

  test('empty body or no match → []', () => {
    expect(extractMentions('普通消息', [{ id: 'a1', name: 'codex', kind: 'agent' }])).toEqual([]);
  });
});

describe('resolveMentionByName (render: follow rename via locked id)', () => {
  test('REGRESSION: body @oldname resolves to current name after rename', () => {
    // 发送时 name=codex 锁定 id=a1；之后 agent 改名为 NEW。body 仍是 @codex。
    const mentions = [{ id: 'a1', kind: 'agent' as const, name: 'codex', start: 0, end: 6 }];
    const agents = { a1: { name: 'NEW' } };
    expect(resolveMentionByName('codex', mentions, agents)).toEqual({
      id: 'a1', kind: 'agent', displayName: 'NEW',
    });
  });

  test('returns null when name not in mentions (legacy/降级 → 走 body name 兜底)', () => {
    expect(resolveMentionByName('codex', undefined, {})).toBeNull();
    expect(resolveMentionByName('codex', [], {})).toBeNull();
  });

  test('falls back to snapshot name when agent no longer in store', () => {
    const mentions = [{ id: 'gone', kind: 'agent' as const, name: 'codex', start: 0, end: 6 }];
    expect(resolveMentionByName('codex', mentions, {})?.displayName).toBe('codex');
  });

  test('human mention keeps snapshot name', () => {
    const mentions = [{ id: 'u1', kind: 'human' as const, name: 'alice', start: 0, end: 6 }];
    expect(resolveMentionByName('alice', mentions, {})?.displayName).toBe('alice');
  });
});

import { describe, expect, test } from 'vitest';
import {
  activeMentionDraft,
  extractMentions,
  replaceActiveMention,
  resolveMentionByName,
  structuredMentionPattern,
  type MentionMember,
} from '../lib/mention';

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

  test('keeps legacy case-insensitive matching while preserving the body snapshot', () => {
    const members: MentionMember[] = [{ id: 'a1', name: 'Codex', kind: 'agent' }];
    expect(extractMentions('@CODEX hi', members)).toEqual([
      { id: 'a1', kind: 'agent', name: 'CODEX', start: 0, end: 6 },
    ]);
  });

  test('empty body or no match → []', () => {
    expect(extractMentions('普通消息', [{ id: 'a1', name: 'codex', kind: 'agent' }])).toEqual([]);
  });
});

describe('mention composer draft', () => {
  test('detects the active @ query at the caret, including Chinese names', () => {
    expect(activeMentionDraft('请 @Hermes 处理', 9)).toEqual({ query: 'Hermes', start: 2, end: 9 });
    expect(activeMentionDraft('请 @小助', 5)).toEqual({ query: '小助', start: 2, end: 5 });
  });

  test('ignores completed mentions and replaces only the token at the caret', () => {
    expect(activeMentionDraft('请 @Hermes 处理', 12)).toBeNull();
    expect(replaceActiveMention('先 @Alice，再 @Her 后续', 15, 'Hermes-Agent')).toEqual({
      value: '先 @Alice，再 @Hermes-Agent 后续',
      caret: 25,
    });
  });

  test('preserves multi-word member names in structured mentions', () => {
    const replacement = replaceActiveMention('请 @Ren', 6, 'Renamed Codex');
    expect(replacement).toEqual({ value: '请 @Renamed Codex ', caret: 17 });
    const mentions = extractMentions(replacement!.value, [
      { id: 'a1', name: 'Renamed Codex', kind: 'agent' },
    ]);
    expect(mentions).toEqual([
      { id: 'a1', kind: 'agent', name: 'Renamed Codex', start: 2, end: 16 },
    ]);
    expect(resolveMentionByName('Renamed Codex', mentions, {
      a1: { name: 'Renamed Codex' },
    })).toEqual({ id: 'a1', kind: 'agent', displayName: 'Renamed Codex' });
  });

  test('matches the exact selected token before normalized-name collisions', () => {
    const members: MentionMember[] = [
      { id: 'a1', name: 'Renamed Codex', kind: 'agent' },
      { id: 'u1', name: 'renamed_codex', kind: 'human' },
    ];
    expect(extractMentions('@renamed_codex 请处理', members)).toEqual([
      { id: 'u1', kind: 'human', name: 'renamed_codex', start: 0, end: 14 },
    ]);
  });

  test('supports punctuation in selected member names without changing human display text', () => {
    const replacement = replaceActiveMention('@Cl', 3, 'Claude 3.5');
    expect(replacement).toEqual({ value: '@Claude 3.5 ', caret: 12 });
    const mentions = extractMentions(replacement!.value, [
      { id: 'u1', name: 'Claude 3.5', kind: 'human' },
    ]);
    expect(mentions).toEqual([
      { id: 'u1', kind: 'human', name: 'Claude 3.5', start: 0, end: 11 },
    ]);
    expect(resolveMentionByName('Claude 3.5', mentions, {})).toEqual({
      id: 'u1', kind: 'human', displayName: 'Claude 3.5',
    });
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

  test('resolves a structured mention case-insensitively', () => {
    const mentions = [{ id: 'a1', kind: 'agent' as const, name: 'Codex', start: 0, end: 6 }];
    expect(resolveMentionByName('CODEX', mentions, { a1: { name: 'NEW' } })?.displayName).toBe('NEW');
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

describe('structuredMentionPattern', () => {
  test('does not match a structured name when it is only a longer mention prefix', () => {
    const pattern = new RegExp(structuredMentionPattern('Claude 3.5'), 'u');
    expect('@Claude 3.5 请处理'.match(pattern)?.[0]).toBe('@Claude 3.5');
    expect(pattern.test('@Claude 3.5-beta')).toBe(false);
    expect(pattern.test('@Claude 3.50')).toBe(false);
  });
});

import { describe, expect, test } from 'vitest';
import { displayMessageBody, markdownBodyToPlainText, plainTextForMessage } from '../lib/chat-message-text';
import type { ChatMessage } from '../lib/schema';

const baseMessage: ChatMessage = {
  id: 'msg-1',
  channelId: 'channel-1',
  senderKind: 'human',
  senderId: 'user-1',
  body: '',
  createdAt: 1,
};

describe('chat message text helpers', () => {
  test('keeps displayMessageBody as the Markdown source used by rendered bubbles', () => {
    expect(displayMessageBody({
      ...baseMessage,
      body: '**粗体** and [标题](https://example.com)',
    })).toBe('**粗体** and [标题](https://example.com)');
  });

  test('copies the visible message text without Markdown syntax', () => {
    expect(plainTextForMessage({
      ...baseMessage,
      body: [
        '# 标题',
        '',
        '**粗体** and [链接](https://example.com)',
        '- `代码`',
        '- @shaw',
      ].join('\n'),
    })).toBe([
      '标题',
      '',
      '粗体 and 链接',
      '代码',
      '@shaw',
    ].join('\n'));
  });

  test('normalizes block Markdown while preserving useful text boundaries', () => {
    expect(markdownBodyToPlainText([
      '> 引用 **重点**',
      '',
      '| 名称 | 状态 |',
      '| --- | --- |',
      '| [AgentBean](https://agentbean.dev) | `ready` |',
      '',
      '```ts',
      'const ok = true;',
      '```',
    ].join('\n'))).toBe([
      '引用 重点',
      '',
      '名称\t状态',
      'AgentBean\tready',
      '',
      'const ok = true;',
    ].join('\n'));
  });
});

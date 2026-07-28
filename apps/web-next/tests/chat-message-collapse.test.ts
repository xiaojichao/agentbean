import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const chatPage = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
const channelMessage = readFileSync(new URL('../components/channel-message.tsx', import.meta.url), 'utf8');
const collapsible = readFileSync(new URL('../components/collapsible-message-body.tsx', import.meta.url), 'utf8');

describe('channel message expand/collapse surface', () => {
  test('chat MarkdownMessage wraps body with CollapsibleMessageBody', () => {
    expect(chatPage).toContain("import { CollapsibleMessageBody } from '@/components/collapsible-message-body'");
    expect(chatPage).toContain('<CollapsibleMessageBody');
    expect(chatPage).toContain('enabled={collapsible}');
  });

  test('document editor preview opts out of collapse so full docs stay readable', () => {
    expect(chatPage).toContain('safeDocumentResources collapsible={false}');
  });

  test('channel-message bubbles also support expand/collapse', () => {
    expect(channelMessage).toContain('CollapsibleMessageBody');
  });

  test('toggle labels are 展开 when collapsed and 折叠 when expanded', () => {
    expect(collapsible).toContain("expanded ? '折叠' : '展开'");
    expect(collapsible).toContain('data-smoke="message-collapse-toggle"');
    expect(collapsible).toContain('MESSAGE_COLLAPSE_LINE_THRESHOLD');
  });
});

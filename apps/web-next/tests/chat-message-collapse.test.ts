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

  test('#all 讨论串附件预览禁用折叠并直接展示 Markdown 全文', () => {
    const threadPanel = chatPage.slice(
      chatPage.indexOf('function ThreadPanel('),
      chatPage.indexOf('function ProfilePanel('),
    );
    const bubble = chatPage.slice(
      chatPage.indexOf('function ChatBubble('),
      chatPage.indexOf('function MessageContextMenuItem('),
    );
    const artifactPreview = chatPage.slice(
      chatPage.indexOf('function ChatArtifactPreview('),
      chatPage.indexOf('function formatTime('),
    );
    expect(threadPanel).toContain('readOnlyArtifacts');
    expect(bubble).toContain('collapsibleMarkdownPreview={!readOnlyArtifacts}');
    expect(artifactPreview).toContain('<MarkdownMessage body={content} collapsible={collapsibleMarkdownPreview} />');
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

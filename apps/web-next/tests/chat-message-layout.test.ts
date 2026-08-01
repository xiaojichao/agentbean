import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const chatPage = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
const channelMessage = readFileSync(new URL('../components/channel-message.tsx', import.meta.url), 'utf8');

describe('chat message layout', () => {
  test('ChatBubble 的 dispatch 状态（处理中/取消）渲染在附件之后的消息最底部', () => {
    const bubble = chatPage.slice(
      chatPage.indexOf('function ChatBubble('),
      chatPage.indexOf('function MessageContextMenuItem('),
    );
    const dispatchIndex = bubble.indexOf('renderDispatchStatus()');
    const artifactsIndex = bubble.indexOf('msg.artifacts && msg.artifacts.length > 0 && (');
    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(artifactsIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeGreaterThan(artifactsIndex);
  });

  test('ChannelMessage 的 dispatch 状态同样渲染在附件之后', () => {
    const dispatchIndex = channelMessage.indexOf('{renderDispatch()}');
    const artifactsIndex = channelMessage.indexOf('{msg.artifacts && msg.artifacts.length > 0 && (');
    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(artifactsIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeGreaterThan(artifactsIndex);
  });

  test('只有 Agent 输出（senderKind === agent）的 Markdown 附件才显示编辑入口', () => {
    const bubble = chatPage.slice(
      chatPage.indexOf('function ChatBubble('),
      chatPage.indexOf('function MessageContextMenuItem('),
    );
    expect(bubble).toMatch(/editable=\{msg\.senderKind === 'agent'\}/);
    const preview = chatPage.slice(
      chatPage.indexOf('function ChatArtifactPreview('),
      chatPage.indexOf('function formatTime('),
    );
    expect(preview).toContain('editable?: boolean');
    expect(preview).toContain('onEdit && editable && isMarkdownArtifact(artifact)');
  });

  test('文件库（ConversationFiles）按文件来源 senderKind 门禁编辑入口', () => {
    const filesSurface = chatPage.slice(
      chatPage.indexOf('function ConversationFiles('),
      chatPage.indexOf('function TaskDetailPanel('),
    );
    expect(filesSurface).toMatch(/editable=\{file\.senderKind === 'agent'\}/);
  });
});

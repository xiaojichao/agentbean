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
    const badgesIndex = bubble.indexOf('showInlineTaskBadge || showInlineReplyBadge || reacted || saved || pinned');
    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(artifactsIndex).toBeGreaterThan(-1);
    expect(badgesIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeGreaterThan(artifactsIndex);
    expect(dispatchIndex).toBeGreaterThan(badgesIndex);
  });

  test('ChannelMessage 的 dispatch 状态同样渲染在附件之后', () => {
    const dispatchIndex = channelMessage.indexOf('{renderDispatch()}');
    const artifactsIndex = channelMessage.indexOf('{msg.artifacts && msg.artifacts.length > 0 && (');
    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(artifactsIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeGreaterThan(artifactsIndex);
  });

  test('#all 讨论串附件保持只读，主聊天和其他频道仍按 Agent 来源显示编辑入口', () => {
    const chatPageShell = chatPage.slice(0, chatPage.indexOf('function ThreadPanel('));
    expect(chatPageShell).toContain("const isDefaultPublicChannel = !isDm && activeChannelObj?.name === 'all';");
    expect(chatPageShell).toContain('readOnlyArtifacts={isDefaultPublicChannel}');
    const bubble = chatPage.slice(
      chatPage.indexOf('function ChatBubble('),
      chatPage.indexOf('function MessageContextMenuItem('),
    );
    expect(bubble).toContain('readOnlyArtifacts = false');
    expect(bubble).toMatch(/editable=\{!readOnlyArtifacts && msg\.senderKind === 'agent'\}/);
    const threadPanel = chatPage.slice(
      chatPage.indexOf('function ThreadPanel('),
      chatPage.indexOf('function ProfilePanel('),
    );
    expect(threadPanel).toContain('readOnlyArtifacts={readOnlyArtifacts}');
    const preview = chatPage.slice(
      chatPage.indexOf('function ChatArtifactPreview('),
      chatPage.indexOf('function formatTime('),
    );
    expect(preview).toContain('editable?: boolean');
    expect(preview).toContain('onEdit && editable && isMarkdownArtifact(artifact)');
  });

  test('#all 讨论串仅在 Agent 消息包含多个文件时合并为文件列表', () => {
    const bubble = chatPage.slice(
      chatPage.indexOf('function ChatBubble('),
      chatPage.indexOf('function MessageContextMenuItem('),
    );
    expect(bubble).toContain("const showArtifactList = readOnlyArtifacts && msg.senderKind === 'agent' && (msg.artifacts?.length ?? 0) > 1;");
    expect(bubble).toContain("data-smoke={showArtifactList ? 'thread-artifact-list' : undefined}");
    expect(bubble).toContain("variant={showArtifactList ? 'list' : 'card'}");
  });

  test('文件库（ConversationFiles）按文件来源 senderKind 门禁编辑入口', () => {
    const filesSurface = chatPage.slice(
      chatPage.indexOf('function ConversationFiles('),
      chatPage.indexOf('function TaskDetailPanel('),
    );
    expect(filesSurface).toMatch(/editable=\{file\.senderKind === 'agent'\}/);
  });

  test('主聊天线跨日显示日期分隔线，并断开跨日消息分组', () => {
    const timeline = chatPage.slice(
      chatPage.indexOf('{rootMessages.map((msg, index) => {'),
      chatPage.indexOf('<div ref={messagesEndRef} />'),
    );
    expect(timeline).toContain('shouldShowMessageDateDivider(previousMessage?.createdAt, msg.createdAt)');
    expect(timeline).toContain('showDateDivider && <MessageDateDivider timestamp={msg.createdAt} now={messageDateReference} />');
    expect(timeline).toContain('groupedWithPrevious={!showDateDivider && isMessageGroupContinuation(previousMessage, msg)}');
  });

  test('ChatBubble 的消息时间使用完整日期时间', () => {
    const bubble = chatPage.slice(
      chatPage.indexOf('function ChatBubble('),
      chatPage.indexOf('function MessageContextMenuItem('),
    );
    expect(bubble).toContain('const time = formatMessageDateTime(msg.createdAt)');
    expect(bubble).toContain('data-smoke="chat-message-timestamp">{time}</div>');
    expect(bubble).not.toContain('group-hover:opacity-100">{time}</span>');
  });

  test('“今天”标签在下一个本地日历日自动刷新', () => {
    const hook = chatPage.slice(
      chatPage.indexOf('function useMessageDateReference()'),
      chatPage.indexOf('export default function ChatPage()'),
    );
    expect(hook).toContain('millisecondsUntilNextLocalDate() + 100');
    expect(hook).toContain('setReference(Date.now())');
  });
});

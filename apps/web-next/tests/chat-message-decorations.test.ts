import { describe, expect, test } from 'vitest';
import { chatMessageDecorationVisibility } from '../lib/chat-message-decorations';

describe('chat message decorations', () => {
  test('讨论串内的 Task 关联回复不重复展示任务编号和 Agent 名称', () => {
    const visibility = chatMessageDecorationVisibility({
      taskId: 'task-1',
      showTaskBadge: false,
      showReplyCount: false,
      replyCount: 0,
      artifactCount: 0,
      hasOutputPackage: false,
    });

    expect(visibility.showInlineTaskBadge).toBe(false);
  });

  test('主时间线仍展示 Task 讨论串入口', () => {
    const visibility = chatMessageDecorationVisibility({
      taskId: 'task-1',
      showTaskBadge: true,
      showReplyCount: true,
      replyCount: 1,
      artifactCount: 0,
      hasOutputPackage: false,
    });

    expect(visibility.hasThreadSurface).toBe(true);
  });

  test('交付文件包的 Agent 回复不重复展示普通附件预览和编辑入口', () => {
    const visibility = chatMessageDecorationVisibility({
      taskId: 'task-1',
      showTaskBadge: false,
      showReplyCount: false,
      replyCount: 0,
      artifactCount: 2,
      hasOutputPackage: true,
    });

    expect(visibility.showArtifactPreviews).toBe(false);
  });

  test('没有文件包的普通附件消息仍展示附件预览', () => {
    const visibility = chatMessageDecorationVisibility({
      taskId: null,
      showTaskBadge: true,
      showReplyCount: false,
      replyCount: 0,
      artifactCount: 1,
      hasOutputPackage: false,
    });

    expect(visibility.showArtifactPreviews).toBe(true);
  });
});

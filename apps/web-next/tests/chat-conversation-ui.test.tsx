import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const chatSource = readFileSync(join(process.cwd(), 'app/[teamPath]/chat/page.tsx'), 'utf8');

describe('频道与私聊共享会话界面', () => {
  test('聊天、任务、文件标签在文字前展示对应图标', () => {
    expect(chatSource).toContain('data-smoke="channel-chat-tab"');
    expect(chatSource).toContain('<MessageSquare size={13} />聊天');
    expect(chatSource).toContain('data-smoke="channel-tasks-tab"');
    expect(chatSource).toContain('<ListTodo size={13} />任务');
    expect(chatSource).toContain('data-smoke="channel-files-tab"');
    expect(chatSource).toContain('<Paperclip size={13} />文件');
  });

  test('主聊天与讨论串只保留可选择图片的通用附件入口', () => {
    expect(chatSource).toContain('data-smoke="chat-file-input"');
    expect(chatSource).toContain('data-smoke="thread-file-input"');
    expect(chatSource).toContain('title="上传附件"');
    expect(chatSource).not.toContain('title="上传图片"');
    expect(chatSource).not.toContain('accept="image/*"');
    expect(chatSource).not.toContain('imageInputRef');
    expect(chatSource).not.toContain('threadImageInputRef');
  });

  test('作为任务与发送按钮位于输入框右侧操作区', () => {
    const rightActionsStart = chatSource.indexOf('data-smoke="chat-composer-right-actions"');
    const rightActionsEnd = chatSource.indexOf('</div>', rightActionsStart);
    const rightActions = chatSource.slice(rightActionsStart, rightActionsEnd);

    expect(rightActionsStart).toBeGreaterThan(-1);
    expect(rightActions).toContain('data-smoke="chat-as-task-toggle"');
    expect(rightActions).toContain('data-smoke="chat-message-send"');
    expect(rightActions.indexOf('chat-as-task-toggle')).toBeLessThan(rightActions.indexOf('chat-message-send'));
  });
});

describe('会话顶部信息', () => {
  test('Agent 私聊头像不带状态，名称后单独展示状态圆点与文字', () => {
    const avatarStart = chatSource.indexOf('data-smoke="dm-header-avatar"');
    const avatarEnd = chatSource.indexOf('</button>', avatarStart);
    const avatar = chatSource.slice(avatarStart, avatarEnd);
    const statusStart = chatSource.indexOf('data-smoke="dm-header-status"');
    const statusEnd = chatSource.indexOf('</div>', statusStart);
    const status = chatSource.slice(statusStart, statusEnd);

    expect(avatarStart).toBeGreaterThan(-1);
    expect(avatar).not.toContain('statusDotClass');
    expect(status).toContain('statusDotClass(activeDmAgent?.status)');
    expect(status).toContain('statusLabel(activeDmAgent?.status)');
  });

  test('频道可见性图标有方框，并在名称下展示非空描述', () => {
    expect(chatSource).toContain('data-smoke="channel-header-visibility"');
    expect(chatSource).toContain('border border-neutral-300 bg-white');
    expect(chatSource).toContain('activeChannelObj?.title?.trim()');
    expect(chatSource).toContain('data-smoke="channel-header-description"');
    expect(chatSource).toContain('{activeChannelObj.title.trim()}');
  });
});

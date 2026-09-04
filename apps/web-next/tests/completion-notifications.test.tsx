// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CompletionNotificationDto, CompletionNotificationWake } from '@agentbean/contracts';
import { CompletionNotifications, completionNotificationHref } from '../components/completion-notifications';

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const mocks = vi.hoisted(() => ({
  list: vi.fn(), markRead: vi.fn(), push: vi.fn(), unsubscribe: vi.fn(),
  listener: null as ((wake: CompletionNotificationWake) => void) | null,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock('@/lib/socket', () => ({
  notificationEvents: () => ({
    list: mocks.list, markRead: mocks.markRead,
    onChanged: (listener: (wake: CompletionNotificationWake) => void) => { mocks.listener = listener; return mocks.unsubscribe; },
  }),
}));
const item = (patch: Partial<CompletionNotificationDto> = {}): CompletionNotificationDto => ({
  id: 'notice-1', teamId: 'team', recipientId: 'user', kind: 'delivery_ready',
  title: '报告已交付，待验收', taskId: 'task', channelId: 'channel', createdAt: 1, readAt: null, ...patch,
});
const props = {
  teamId: 'team', teamPath: 'test', userId: 'user', connected: true,
  open: true, onToggle: vi.fn(), onClose: vi.fn(), piAttention: true,
};
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  mocks.list.mockResolvedValue({ ok: true, items: [], unreadCount: 0 });
  mocks.markRead.mockResolvedValue({ ok: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(cleanup);

describe('侧栏交付提醒', () => {
  test('点击系统推送后用同一条提醒更新已读，保留任务定位参数', async () => {
    window.history.replaceState(null, '', '/test/tasks?task=task&notice=notice-1&noticeTeam=team');
    mocks.list.mockResolvedValue({ ok: true, items: [item()] });
    render(<CompletionNotifications {...props} />);
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith({ teamId: 'team', id: 'notice-1' }));
    await waitFor(() => expect(screen.getByLabelText('提醒')).toBeTruthy());
    expect(window.location.search).toBe('?task=task');
    window.history.replaceState(null, '', '/');
  });
  test('恢复未读列表，同时保留 PI 提醒；打开菜单不自动已读', async () => {
    mocks.list.mockResolvedValue({ ok: true, items: [item()] });
    const view = render(<CompletionNotifications {...props} />);
    await screen.findByText('报告已交付，待验收');
    expect(screen.getByLabelText('提醒，1条未读')).toBeTruthy();
    expect(screen.getByText('PI 需要处理')).toBeTruthy();
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(document.querySelector('[data-smoke="completion-notification-toast"]')).toBeNull();
    fireEvent.click(screen.getByText('报告已交付，待验收'));
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith({ teamId: 'team', id: 'notice-1' }));
    await waitFor(() => expect(screen.getByLabelText('提醒')).toBeTruthy());
    expect(mocks.push).toHaveBeenCalledWith('/test/tasks?thread=channel%3Atask');
    view.rerender(<CompletionNotifications {...props} piAttention={false} />);
    expect(screen.queryByText('PI 需要处理')).toBeNull();
    expect(screen.getByText('报告已交付，待验收')).toBeTruthy();
  });

  test('实时唤醒重拉权威列表，重复唤醒只显示一个提示', async () => {
    render(<CompletionNotifications {...props} open={false} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    mocks.list.mockResolvedValue({ ok: true, items: [item({ createdAt: Date.now() + 1 })] });
    await act(async () => { mocks.listener?.({ teamId: 'team', recipientId: 'user' }); });
    await waitFor(() => expect(document.querySelectorAll('[data-smoke="completion-notification-toast"]')).toHaveLength(1));
    fireEvent.click(screen.getByLabelText('关闭提示'));
    await act(async () => { mocks.listener?.({ teamId: 'team', recipientId: 'user' }); });
    expect(document.querySelector('[data-smoke="completion-notification-toast"]')).toBeNull();
    expect(screen.getByLabelText('提醒，1条未读')).toBeTruthy();
  });

  test('跨用户唤醒不拉取；换团队立即隐藏旧数据且丢弃旧请求', async () => {
    mocks.list.mockResolvedValue({ ok: true, items: [item()] });
    const view = render(<CompletionNotifications {...props} />);
    await screen.findByText('报告已交付，待验收');
    await act(async () => { mocks.listener?.({ teamId: 'team', recipientId: 'other' }); });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    mocks.list.mockResolvedValue({ ok: true, items: [] });
    view.rerender(<CompletionNotifications {...props} teamId="another" />);
    expect(screen.queryByText('报告已交付，待验收')).toBeNull();
    await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalled());
  });

  test('直接请求定位频道中的确切结果，独立任务也有明确入口', () => {
    const href = completionNotificationHref('test', item({
      taskId: undefined, threadId: 'origin', messageId: 'reply',
    }));
    expect(href).toBe('/test/channel/channel?thread=channel%3Aorigin&message=channel%3Areply');
    expect(completionNotificationHref('test', item({ channelId: undefined }))).toBe('/test/tasks?task=task');
  });
});

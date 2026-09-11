// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useChannelHistoryPagination } from '../lib/use-channel-history-pagination';
import type { ChannelHistoryAck } from '../lib/socket';
import type { ChatMessage } from '../lib/schema';

const message = (id: string, createdAt: number): ChatMessage => ({
  id, createdAt, channelId: 'channel', senderKind: 'human', senderId: 'user', body: id,
});

afterEach(() => { cleanup(); document.body.replaceChildren(); });

function setup() {
  const list = document.createElement('div');
  const row = document.createElement('div');
  row.id = 'message-current';
  list.append(row);
  document.body.append(list);
  let height = 2000;
  let rowTop = 0;
  Object.defineProperties(list, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 300 },
  });
  list.getBoundingClientRect = () => ({ top: 0, bottom: 300 } as DOMRect);
  row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 40 } as DOMRect);
  const end = document.createElement('div');
  end.scrollIntoView = vi.fn();
  const loadPage = vi.fn<(...args: string[]) => Promise<ChannelHistoryAck>>();
  const prepend = vi.fn();
  const options = {
    channelId: 'channel', teamId: 'team', enabled: true,
    messages: [message('current', 50)],
    pagination: { hasMore: true, nextBeforeMessageId: 'current' as string | null },
    listRef: { current: list }, endRef: { current: end }, loadPage, prepend,
  };
  return { options, list, end, loadPage, prepend, moveAnchor: () => { height += 400; rowTop += 400; } };
}

describe('top-of-channel history loading', () => {
  test('returning to the bottom resumes following live messages after clearing link focus', () => {
    const fixture = setup();
    const options = { ...fixture.options, suppressAutoScroll: true };
    const hook = renderHook(useChannelHistoryPagination, { initialProps: options });
    expect(fixture.end.scrollIntoView).not.toHaveBeenCalled();
    fixture.list.scrollTop = 1700;
    act(() => hook.result.current.onScroll());
    hook.rerender({ ...options, suppressAutoScroll: false });
    expect(fixture.end.scrollIntoView).toHaveBeenCalledTimes(1);
    hook.rerender({ ...options, suppressAutoScroll: false, messages: [...options.messages, message('live', 60)] });
    expect(fixture.end.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  test('message links suppress automatic bottom scrolling without disabling older history', async () => {
    const fixture = setup();
    const options = { ...fixture.options, suppressAutoScroll: true };
    const hook = renderHook(useChannelHistoryPagination, { initialProps: options });
    expect(fixture.end.scrollIntoView).not.toHaveBeenCalled();
    const older = [message('older', 40)];
    fixture.loadPage.mockResolvedValue({ ok: true, messages: older, hasMore: false, nextBeforeMessageId: null });
    await act(async () => { await hook.result.current.loadOlder(); });
    fixture.moveAnchor();
    hook.rerender({ ...options, messages: [...older, ...fixture.options.messages] });
    expect(fixture.list.scrollTop).toBe(400);
    expect(fixture.end.scrollIntoView).not.toHaveBeenCalled();
    expect(fixture.prepend).toHaveBeenCalledOnce();
  });

  test('coalesces repeated top scrolls and preserves the visible message after prepend', async () => {
    const fixture = setup();
    let resolve!: (page: ChannelHistoryAck) => void;
    fixture.loadPage.mockReturnValue(new Promise((done) => { resolve = done; }));
    const hook = renderHook(useChannelHistoryPagination, { initialProps: fixture.options });
    act(() => { hook.result.current.onScroll(); hook.result.current.onScroll(); });
    expect(fixture.loadPage).toHaveBeenCalledTimes(1);
    expect(fixture.loadPage).toHaveBeenCalledWith('team', 'channel', 'current');
    expect(hook.result.current.loading).toBe(true);
    const older = [message('older', 40)];
    await act(async () => { resolve({ ok: true, messages: older, hasMore: true, nextBeforeMessageId: 'older' }); });
    fixture.moveAnchor();
    hook.rerender({ ...fixture.options, messages: [...older, ...fixture.options.messages] });
    expect(fixture.list.scrollTop).toBe(400);
    expect(fixture.end.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(fixture.prepend).toHaveBeenCalledWith('channel', older, { hasMore: true, nextBeforeMessageId: 'older' });
  });

  test('shows failure without losing the cursor, retries on demand, and stops at the end', async () => {
    const fixture = setup();
    fixture.loadPage.mockResolvedValueOnce({ ok: false, error: 'TIMEOUT' })
      .mockResolvedValueOnce({ ok: true, messages: [], hasMore: false, nextBeforeMessageId: null });
    const hook = renderHook(useChannelHistoryPagination, { initialProps: fixture.options });
    await act(async () => { await hook.result.current.loadOlder(); });
    expect(hook.result.current.error).toBe(true);
    act(() => hook.result.current.onScroll());
    expect(fixture.loadPage).toHaveBeenCalledTimes(1);
    await act(async () => { await hook.result.current.loadOlder(); });
    expect(fixture.loadPage).toHaveBeenLastCalledWith('team', 'channel', 'current');
    expect(hook.result.current.error).toBe(false);
    hook.rerender({ ...fixture.options, pagination: { hasMore: false, nextBeforeMessageId: null } });
    act(() => hook.result.current.onScroll());
    expect(fixture.loadPage).toHaveBeenCalledTimes(2);
  });

  test('ignores a late response after switching channels', async () => {
    const fixture = setup();
    let resolve!: (page: ChannelHistoryAck) => void;
    fixture.loadPage.mockReturnValue(new Promise((done) => { resolve = done; }));
    const hook = renderHook(useChannelHistoryPagination, { initialProps: fixture.options });
    act(() => hook.result.current.onScroll());
    hook.rerender({ ...fixture.options, channelId: 'other-channel' });
    await act(async () => { resolve({ ok: true, messages: [message('old', 1)], hasMore: false, nextBeforeMessageId: null }); });
    expect(fixture.prepend).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(false);
  });

  test('new live messages do not pull a reader of older history back to the bottom', () => {
    const fixture = setup();
    const hook = renderHook(useChannelHistoryPagination, { initialProps: fixture.options });
    fixture.list.scrollTop = 400;
    act(() => hook.result.current.onScroll());
    hook.rerender({ ...fixture.options, messages: [...fixture.options.messages, message('live', 60)] });
    expect(fixture.end.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(fixture.list.scrollTop).toBe(400);
    expect(hook.result.current.showBackToBottom).toBe(true);
  });
});

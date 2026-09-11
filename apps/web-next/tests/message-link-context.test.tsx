// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../lib/schema';
import { useMessageLinkContext } from '../lib/use-message-link-context';

const { context } = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../lib/socket', () => ({ messageReactionEvents: () => ({ context }) }));
const root: ChatMessage = { id: 'old-root', channelId: 'channel', senderKind: 'human', senderId: 'user', body: '旧讨论串', createdAt: 1 };
const mark = (message: ChatMessage) => ({ ...message, meta: { __contextLoaded: true } });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('频道消息链接补取', () => {
  test('首批历史完成后补取缺失根消息，保留上下文标识', async () => {
    context.mockResolvedValue({ ok: true, messages: [root, { ...root, id: 'foreign', channelId: 'other' }] });
    const upsert = vi.fn();
    const { rerender } = renderHook(({ ready }) => useMessageLinkContext('channel', root.id, ready, false, upsert, mark), { initialProps: { ready: false } });
    expect(context).not.toHaveBeenCalled();
    rerender({ ready: true });
    await waitFor(() => expect(upsert).toHaveBeenCalledWith([mark(root)]));
    expect(context).toHaveBeenCalledWith(root.id);
  });

  test('目标已经加载时不请求上下文', () => {
    renderHook(() => useMessageLinkContext('channel', root.id, true, true, vi.fn(), mark));
    expect(context).not.toHaveBeenCalled();
  });

  test('切换链接后忽略前一个请求的迟到响应', async () => {
    let resolve!: (value: unknown) => void;
    context.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const upsert = vi.fn();
    const { rerender } = renderHook(({ target }: { target: string | null }) => useMessageLinkContext('channel', target, true, false, upsert, mark), { initialProps: { target: root.id as string | null } });
    rerender({ target: null });
    await act(async () => { resolve({ ok: true, messages: [root] }); });
    expect(upsert).not.toHaveBeenCalled();
  });

  test('拒绝访问时不合并消息，也不因重渲染循环请求', async () => {
    context.mockResolvedValue({ ok: false, error: 'forbidden' });
    const upsert = vi.fn();
    const { rerender } = renderHook(() => useMessageLinkContext('channel', root.id, true, false, upsert, mark));
    await act(async () => {});
    rerender();
    expect(upsert).not.toHaveBeenCalled();
    expect(context).toHaveBeenCalledTimes(1);
  });
});

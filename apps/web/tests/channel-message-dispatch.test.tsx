// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from '@/lib/schema';

const emitMock = vi.fn((event: string, payload: unknown, cb: (res: unknown) => void) => cb({ ok: true }));
let emitWithTimeoutResult: unknown = { ok: true, dispatch: { id: 'd1', status: 'cancelled' } };
const applyDispatchStatusMock = vi.fn();
vi.mock('@/lib/store', () => ({
  useAgentBeanStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ agents: {} }),
    { getState: () => ({ applyDispatchStatus: applyDispatchStatusMock }) },
  ),
}));
vi.mock('@/lib/socket', () => ({
  getWebSocket: () => ({ emit: emitMock }),
  getResolvedServerUrl: () => 'http://srv',
  getStoredAuthToken: () => 'tok',
  emitWithTimeout: (socket: { emit: typeof emitMock }, event: string, payload: unknown) => {
    socket.emit(event, payload, () => {});
    return Promise.resolve(emitWithTimeoutResult);
  },
}));
vi.mock('@/lib/display-names', () => ({
  messageSpeakerName: () => 'Agent',
}));

import { ChannelMessage } from '../components/channel-message';

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1', channelId: 'c1', senderKind: 'human', senderId: 'u1',
    body: 'hi', createdAt: 1000, ...overrides,
  };
}

afterEach(() => {
  cleanup();
  emitMock.mockReset();
  applyDispatchStatusMock.mockReset();
  emitWithTimeoutResult = { ok: true, dispatch: { id: 'd1', status: 'cancelled' } };
});

describe('ChannelMessage dispatch indicator', () => {
  it('shows 正在处理 and a 取消 button when running', () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'running', dispatchId: 'd1' })} />);
    expect(screen.getByText(/正在处理/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('shows 已取消 capsule when cancelled (no cancel button)', () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'cancelled', dispatchId: 'd1' })} />);
    expect(screen.getByText('已取消')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  });

  it('shows failure text when failed', () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'failed', dispatchId: 'd1' })} />);
    expect(screen.getByText(/失败/)).toBeInTheDocument();
  });

  it('renders no indicator when succeeded', () => {
    const { container } = render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'succeeded', dispatchId: 'd1' })} />);
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('正在处理');
  });

  it('emits dispatch:cancel with dispatchId on cancel click', () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'running', dispatchId: 'd1' })} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(emitMock).toHaveBeenCalledWith('dispatch:cancel', { dispatchId: 'd1' }, expect.any(Function));
  });

  it('updates from the server dispatch status returned by cancel ack', async () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'running', dispatchId: 'd1' })} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(applyDispatchStatusMock).toHaveBeenCalledWith('c1', 'm1', 'cancelled', 'd1');
    });
  });
});

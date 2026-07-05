import { describe, expect, test, vi } from 'vitest';
import { createDispatchOutbox, type OutboxSocket } from '../src/outbox';

function createMockSocket(initial: { connected?: boolean; emitWithAck?: OutboxSocket['emitWithAck'] } = {}) {
  const state = { connected: initial.connected ?? true };
  const emitWithAck = initial.emitWithAck ?? vi.fn().mockResolvedValue({ ok: true });
  const socket: OutboxSocket = {
    get connected() { return state.connected; },
    emitWithAck,
  };
  return { socket, emitWithAck, setConnected: (c: boolean) => { state.connected = c; } };
}

describe('DispatchOutbox', () => {
  test('sendOrEnqueue 立即发送且不入队（已连接）', async () => {
    const { socket, emitWithAck } = createMockSocket({ connected: true });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1', agentId: 'a1' });
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledWith('dispatch.result', { dispatchId: 'd1', agentId: 'a1' }));
    expect(outbox.size()).toBe(0);
  });

  test('sendOrEnqueue 断开时入队、不抛、不发送', () => {
    const { socket, emitWithAck } = createMockSocket({ connected: false });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' });
    expect(emitWithAck).not.toHaveBeenCalled();
    expect(outbox.size()).toBe(1);
  });

  test('sendOrEnqueue 已连接但 emit reject 时入队、不抛、回调 onWarn', async () => {
    const emitWithAck = vi.fn().mockRejectedValue(new Error('socket has been disconnected'));
    const { socket } = createMockSocket({ connected: true, emitWithAck });
    const onWarn = vi.fn();
    const outbox = createDispatchOutbox(socket, { onWarn });
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' });
    await vi.waitFor(() => expect(outbox.size()).toBe(1));
    expect(onWarn).toHaveBeenCalled();
  });

  test('sendOrEnqueue 已连接但业务 ACK 失败时入队', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: false, error: 'NOT_FOUND' });
    const { socket } = createMockSocket({ connected: true, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' }, {
      isDeliveredAck: (ack) => Boolean(ack && typeof ack === 'object' && (ack as { ok?: unknown }).ok === true),
    });
    await vi.waitFor(() => expect(outbox.size()).toBe(1));
  });

  test('sendOrEnqueue 成功 ACK 后调用 delivered 回调', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const { socket } = createMockSocket({ connected: true, emitWithAck });
    const onDelivered = vi.fn();
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' }, {
      isDeliveredAck: (ack) => Boolean(ack && typeof ack === 'object' && (ack as { ok?: unknown }).ok === true),
      onDelivered,
    });
    await vi.waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    expect(outbox.size()).toBe(0);
  });

  test('flush 成功补发后调用 delivered 回调', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const { socket, setConnected } = createMockSocket({ connected: false, emitWithAck });
    const onDelivered = vi.fn();
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' }, { onDelivered });
    setConnected(true);
    await outbox.flush();
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });

  test('flush 顺序补发全部待发项，成功后清空', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const { socket, setConnected } = createMockSocket({ connected: false, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' });
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd2' });
    expect(outbox.size()).toBe(2);
    setConnected(true);
    await outbox.flush();
    expect(emitWithAck).toHaveBeenCalledTimes(2);
    expect(emitWithAck).toHaveBeenNthCalledWith(1, 'dispatch.result', { dispatchId: 'd1' });
    expect(emitWithAck).toHaveBeenNthCalledWith(2, 'dispatch.result', { dispatchId: 'd2' });
    expect(outbox.size()).toBe(0);
  });

  test('flush 单项失败时该项留队、其余继续、不抛', async () => {
    const emitWithAck = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce({ ok: true });
    const { socket, setConnected } = createMockSocket({ connected: false, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' });
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd2' });
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd3' });
    setConnected(true);
    await outbox.flush();
    expect(outbox.size()).toBe(1);
  });

  test('按 dispatchId 去重，保留最新', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const { socket, setConnected } = createMockSocket({ connected: false, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1', body: 'first' });
    outbox.sendOrEnqueue('dispatch.error', { dispatchId: 'd1', error: 'second' });
    expect(outbox.size()).toBe(1);
    setConnected(true);
    await outbox.flush();
    expect(emitWithAck).toHaveBeenCalledTimes(1);
    expect(emitWithAck).toHaveBeenCalledWith('dispatch.error', { dispatchId: 'd1', error: 'second' });
  });

  test('flush 不会删除发送期间重新入队的同 dispatchId 新项', async () => {
    let resolveFirstSend: (() => void) | undefined;
    let calls = 0;
    const emitWithAck = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirstSend = () => resolve({ ok: true });
        });
      }
      return Promise.reject(new Error('socket has been disconnected'));
    });
    const { socket, setConnected } = createMockSocket({ connected: false, emitWithAck });
    const outbox = createDispatchOutbox(socket);

    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1', body: 'old' });
    setConnected(true);
    const flushing = outbox.flush();
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledTimes(1));

    outbox.sendOrEnqueue('dispatch.error', { dispatchId: 'd1', error: 'new' });
    await vi.waitFor(() => expect(outbox.size()).toBe(1));
    resolveFirstSend?.();
    await flushing;

    expect(outbox.size()).toBe(1);
  });

  test('payload 缺 dispatchId 时直接发送、永不入队', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const { socket } = createMockSocket({ connected: true, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('some.event', { noDispatchId: true });
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledWith('some.event', { noDispatchId: true }));
    expect(outbox.size()).toBe(0);
  });
});

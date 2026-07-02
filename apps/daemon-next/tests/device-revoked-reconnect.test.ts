import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index';
import {
  createDaemonProtocolClient,
  type DaemonProtocolSocket,
} from '../src/index';

describe('daemon handles DEVICE_REVOKED on hello', () => {
  test('on initial hello, DEVICE_REVOKED ack invokes onDeviceRemoved and aborts announce', async () => {
    const socket = new FakeAgentSocket();
    socket.helloAcks.push({ ok: false, error: 'DEVICE_REVOKED' });
    const onDeviceRemoved = vi.fn();
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => '',
      device: { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' },
      runtimes: [],
      agents: [],
      onDeviceRemoved,
    });

    // start() 触发初始 hello 握手；DEVICE_REVOKED 应导致 announce 抛错（拒绝复活），
    // 并先调用 onDeviceRemoved，让 cli 层关闭重连并退出进程。
    await expect(client.start()).rejects.toThrow(/revoked/);
    expect(onDeviceRemoved).toHaveBeenCalledTimes(1);

    // 不得继续上报 runtimes / agent.registerBatch。
    expect(socket.emitted.some(([event]) => event === AGENT_EVENTS.device.runtimes)).toBe(false);
    expect(socket.emitted.some(([event]) => event === AGENT_EVENTS.agent.registerBatch)).toBe(false);
  });

  test('on reconnect hello, DEVICE_REVOKED ack invokes onDeviceRemoved and aborts announce', async () => {
    const socket = new FakeAgentSocket();
    // 初始 hello 成功
    socket.helloAcks.push({ ok: true, device: { id: 'device-1' } });
    // 重连 hello 被拒（设备已离线删除 → 服务端返回 DEVICE_REVOKED）
    socket.helloAcks.push({ ok: false, error: 'DEVICE_REVOKED' });
    const onDeviceRemoved = vi.fn();
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => '',
      device: { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' },
      runtimes: [],
      agents: [],
      onDeviceRemoved,
    });

    await client.start();
    expect(onDeviceRemoved).not.toHaveBeenCalled();

    // 记录初始成功连接已发的事件，重连不应再追加任何 runtimes/agent.registerBatch。
    const emittedBeforeReconnect = socket.emitted.length;

    // 重连触发第二次 hello；DEVICE_REVOKED 应上抛 onDeviceRemoved。
    // 重连流程自身会捕获 announce 抛错（non-blocking），但 onDeviceRemoved 已在抛错前触发，
    // cli 层据此关闭重连并退出进程，使 daemon 不再发后续 hello 复活已删设备。
    await socket.triggerReconnect();
    await vi.waitFor(() => {
      expect(onDeviceRemoved).toHaveBeenCalledTimes(1);
    });

    // 不得在重连后继续上报 runtimes / agent.registerBatch（设备已 revoke）。
    const afterReconnect = socket.emitted.slice(emittedBeforeReconnect);
    expect(afterReconnect.some(([event]) => event === AGENT_EVENTS.device.runtimes)).toBe(false);
    expect(afterReconnect.some(([event]) => event === AGENT_EVENTS.agent.registerBatch)).toBe(false);
  });
});

class FakeAgentSocket implements DaemonProtocolSocket {
  readonly emitted: Array<[string, unknown]> = [];
  readonly helloAcks: unknown[] = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: (result: unknown) => void) => Promise<void>>();
  private reconnectHandler: (() => Promise<void>) | undefined;

  get connected(): boolean { return true; }

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    if (event === AGENT_EVENTS.device.hello) {
      const ack = this.helloAcks.shift();
      if (ack) {
        return ack;
      }
      return { ok: true, device: { id: 'device-1' } };
    }
    return { ok: true };
  }

  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void {
    this.handlers.set(event, handler);
  }

  onReconnect(handler: () => Promise<void>): void {
    this.reconnectHandler = handler;
  }

  async trigger(event: string, payload: unknown, ack?: (result: unknown) => void): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler for ${event}`);
    }
    await handler(payload, ack);
  }

  async triggerReconnect(): Promise<void> {
    if (!this.reconnectHandler) {
      throw new Error('No reconnect handler');
    }
    await this.reconnectHandler();
  }
}

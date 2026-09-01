import {
  AGENT_EVENTS,
  type DispatchAgentMessageV1,
} from '../../../packages/contracts/src/index.js';

const DEFAULT_ACK_TIMEOUT_MS = 2_000;

export interface DispatchAgentMessageSocket {
  readonly connected: boolean;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
}

export function createDispatchAgentMessageReporter(input: {
  readonly socket: DispatchAgentMessageSocket;
  readonly dispatchId: string;
  readonly agentId: string;
  readonly now?: () => number;
  readonly ackTimeoutMs?: number;
}): (message: Pick<DispatchAgentMessageV1, 'sequence' | 'kind' | 'body'>) => Promise<void> {
  const now = input.now ?? Date.now;
  const ackTimeoutMs = input.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  return async (message) => {
    if (!input.socket.connected) return;
    const payload: DispatchAgentMessageV1 = {
      schemaVersion: 1,
      dispatchId: input.dispatchId,
      agentId: input.agentId,
      updateId: `${input.dispatchId}:agent-message:${message.sequence}`,
      sequence: message.sequence,
      kind: message.kind,
      body: message.body,
      sentAt: now(),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        input.socket.emitWithAck(AGENT_EVENTS.dispatch.message, payload),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ackTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      // 用户可见动态是可选信号；断线/旧 Server 时保留结构化状态兜底，不能阻断执行。
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

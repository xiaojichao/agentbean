/**
 * DispatchOutbox：把 dispatch.result / dispatch.error 的上报与传输解耦。
 *
 * daemon 运行期间若 socket 断开，socket.io-client 会对所有 pending ack 同步
 * reject（"socket has been disconnected"）。直接 await emitWithAck 会让未捕获的
 * reject 变成 unhandledRejection，在 Node 上直接 crash 进程。
 *
 * outbox 保证 sendOrEnqueue 永不抛：已连接时即时发送（失败则入队），断开时直接
 * 入队；socket 重连后由 flush() 顺序补发，成功清队、失败留队。按 dispatchId 去重
 * ——一个 dispatch 只有一个终态（result 或 error），后到覆盖先到。
 */

export interface OutboxSocket {
  readonly connected: boolean;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
}

export interface DispatchOutbox {
  sendOrEnqueue(event: string, payload: unknown): void;
  flush(): Promise<void>;
  size(): number;
}

export interface CreateDispatchOutboxOptions {
  onWarn?: (message: string) => void;
}

type OutboxItem = { event: string; payload: unknown };

export function createDispatchOutbox(
  socket: OutboxSocket,
  options: CreateDispatchOutboxOptions = {},
): DispatchOutbox {
  const onWarn = options.onWarn ?? (() => {});
  const queue = new Map<string, OutboxItem>();
  let flushing = false;

  function readDispatchId(payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'dispatchId' in payload) {
      const value = (payload as { dispatchId?: unknown }).dispatchId;
      return typeof value === 'string' ? value : undefined;
    }
    return undefined;
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function trySend(item: OutboxItem): Promise<boolean> {
    try {
      await socket.emitWithAck(item.event, item.payload);
      return true;
    } catch (error) {
      onWarn(`dispatch outbox emit failed for ${item.event}: ${describeError(error)}`);
      return false;
    }
  }

  return {
    sendOrEnqueue(event, payload) {
      const item: OutboxItem = { event, payload };
      const dispatchId = readDispatchId(payload);
      if (!dispatchId) {
        // 无 dispatchId 无法去重，直接尝试发送；失败即放弃（不阻塞 dispatch 流程）。
        void trySend(item);
        return;
      }
      if (!socket.connected) {
        queue.set(dispatchId, item);
        return;
      }
      void (async () => {
        const ok = await trySend(item);
        if (!ok) {
          queue.set(dispatchId, item);
        }
      })();
    },
    async flush() {
      if (flushing) return;
      flushing = true;
      try {
        for (const [dispatchId, item] of Array.from(queue.entries())) {
          const ok = await trySend(item);
          if (ok) {
            if (queue.get(dispatchId) === item) {
              queue.delete(dispatchId);
            }
          }
        }
      } finally {
        flushing = false;
      }
    },
    size() {
      return queue.size;
    },
  };
}

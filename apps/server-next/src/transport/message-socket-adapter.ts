import type {
  Ack,
  DispatchRequestDto,
  ProjectReferenceSetDto,
} from '../../../../packages/contracts/src/index.js';
import type { DispatchSocketMutationSource } from './dispatch-socket-projection.js';

export interface MessageDispatchPort {
  getDispatchRequest(input: {
    dispatchId: string;
    purpose?: 'execute' | 'route';
  }): Promise<Ack<{ request: DispatchRequestDto & { id: string } }>>;
}

export type MessageSocketMutationKind = 'send' | 'edit' | 'delete' | 'convert-to-task';

type SendMessageDispatchAck = {
  id: string;
  teamId: string;
  channelId: string;
  messageId: string;
  agentId: string;
  requestId: string;
};

type SendMessageAck = {
  ok: true;
  message: {
    id?: string;
    teamId?: string;
    channelId?: string;
    threadId?: string;
    senderId?: string;
    body: string;
  };
  dispatches: SendMessageDispatchAck[];
  coalescedDispatchId?: string;
  task?: unknown;
  referenceSet?: ProjectReferenceSetDto;
};

export interface CommittedProjectReferences {
  readonly teamId: string;
  readonly channelId: string;
  readonly referenceSet: ProjectReferenceSetDto;
}

interface PendingDispatchRequest {
  readonly dispatchId: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface MessageSocketAdapterOptions {
  dispatch?(request: DispatchRequestDto & { id: string }): void;
  shouldUseDispatchClaim?(request: DispatchRequestDto & { id: string }): boolean;
  dispatchRequestCoalesceMs?: number;
  afterMessageSend?(payload: unknown, result: unknown): Promise<void> | void;
  afterProjectReferencesUpdated?(committed: CommittedProjectReferences): Promise<void> | void;
  afterTaskMutation?(payload: unknown, result: unknown): Promise<void> | void;
  afterDispatchMutation?(
    source: DispatchSocketMutationSource,
    payload: unknown,
    result: unknown,
  ): Promise<void> | void;
  afterMemoryMutation?(payload: unknown, result: unknown): Promise<void> | void;
}

export interface MessageSocketAdapter {
  /** 按 mutation kind 统一执行投影 fan-out，并为 send 处理 dispatch wake。 */
  handleMutation(
    kind: MessageSocketMutationKind,
    payload: unknown,
    result: unknown,
  ): Promise<void>;
  /** Dispatch 终态后取消尚未发出的 quiet-window wake。 */
  cancelPendingDispatch(dispatchId: string): void;
}

/**
 * Message mutation 的 socket adapter。
 *
 * Transport 只把 use-case 结果交给本 module；投影 fan-out、dispatch quiet window、
 * claim wake 与取消顺序都收敛在这个 interface 后面。
 */
export function createMessageSocketAdapter(
  port: MessageDispatchPort,
  options: MessageSocketAdapterOptions,
): MessageSocketAdapter {
  const dispatchRequestCoalesceMs = Math.max(0, options.dispatchRequestCoalesceMs ?? 0);
  const pendingDispatchRequests = new Map<string, PendingDispatchRequest>();

  const requestDispatchEmission = (dispatchId: string): void => {
    void emitDispatchRequest(port, options, dispatchId).catch((error) => {
      console.error(
        '[server-next] dispatch request emission failed:',
        error instanceof Error ? error.stack ?? error.message : error,
      );
    });
  };

  const scheduleDispatchRequest = (dispatch: SendMessageDispatchAck): void => {
    if (!options.dispatch) return;
    if (dispatchRequestCoalesceMs <= 0) {
      requestDispatchEmission(dispatch.id);
      return;
    }
    const pending: PendingDispatchRequest = { dispatchId: dispatch.id };
    pendingDispatchRequests.set(dispatch.id, pending);
    resetPendingDispatchRequestTimer(pendingDispatchRequests, pending, dispatchRequestCoalesceMs, () => {
      requestDispatchEmission(dispatch.id);
    });
    void emitDispatchClaimWakeIfSupported(port, options, pendingDispatchRequests, pending).catch((error) => {
      console.error(
        '[server-next] dispatch claim wake emission failed:',
        error instanceof Error ? error.stack ?? error.message : error,
      );
    });
  };

  const extendPendingDispatchRequest = (dispatchId: string | undefined): void => {
    if (dispatchRequestCoalesceMs <= 0 || !dispatchId) return;
    const pending = pendingDispatchRequests.get(dispatchId);
    if (!pending) return;
    resetPendingDispatchRequestTimer(pendingDispatchRequests, pending, dispatchRequestCoalesceMs, () => {
      requestDispatchEmission(pending.dispatchId);
    });
  };

  return {
    async handleMutation(kind, payload, result) {
      if (kind === 'convert-to-task') {
        await options.afterTaskMutation?.(payload, result);
        await options.afterMessageSend?.(payload, result);
        return;
      }

      await options.afterMessageSend?.(payload, result);
      if (kind === 'edit') return;
      if (kind === 'delete') {
        await options.afterMemoryMutation?.(payload, result);
        return;
      }

      if (!isSendMessageAck(result)) return;
      const teamId = result.message.teamId;
      const channelId = result.message.channelId;
      if (result.referenceSet && typeof teamId === 'string' && typeof channelId === 'string') {
        await options.afterProjectReferencesUpdated?.({
          teamId,
          channelId,
          referenceSet: result.referenceSet,
        });
      }
      if (result.task) {
        await options.afterTaskMutation?.(payload, result);
      }
      // 全量 Agent refresh 只在确实产生 dispatch（即写入 busy）时触发。
      if (result.dispatches.length > 0) {
        await options.afterDispatchMutation?.('message-send', payload, result);
      }
      if (!options.dispatch) return;
      extendPendingDispatchRequest(result.coalescedDispatchId);
      for (const dispatch of result.dispatches) {
        scheduleDispatchRequest(dispatch);
      }
    },
    cancelPendingDispatch(dispatchId) {
      const pending = pendingDispatchRequests.get(dispatchId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingDispatchRequests.delete(dispatchId);
    },
  };
}

async function emitDispatchRequest(
  port: MessageDispatchPort,
  options: Pick<MessageSocketAdapterOptions, 'dispatch'>,
  dispatchId: string,
): Promise<void> {
  if (!options.dispatch) return;
  const result = await port.getDispatchRequest({ dispatchId });
  if (result.ok) options.dispatch(result.request);
}

async function emitDispatchClaimWakeIfSupported(
  port: MessageDispatchPort,
  options: Pick<MessageSocketAdapterOptions, 'dispatch' | 'shouldUseDispatchClaim'>,
  pendingDispatchRequests: Map<string, PendingDispatchRequest>,
  pending: PendingDispatchRequest,
): Promise<void> {
  if (!options.dispatch || !options.shouldUseDispatchClaim) return;
  const result = await port.getDispatchRequest({ dispatchId: pending.dispatchId, purpose: 'route' });
  if (!result.ok || !options.shouldUseDispatchClaim(result.request)) return;
  if (pendingDispatchRequests.get(pending.dispatchId) !== pending) return;
  clearTimeout(pending.timer);
  pendingDispatchRequests.delete(pending.dispatchId);
  options.dispatch({ ...result.request, claimRequired: true });
}

function resetPendingDispatchRequestTimer(
  pendingDispatchRequests: Map<string, PendingDispatchRequest>,
  pending: PendingDispatchRequest,
  delayMs: number,
  callback: () => void,
): void {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pendingDispatchRequests.delete(pending.dispatchId);
    callback();
  }, delayMs);
  (pending.timer as { unref?: () => void }).unref?.();
}

function isSendMessageAck(result: unknown): result is SendMessageAck {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as { ok?: unknown; message?: { body?: unknown }; dispatches?: unknown };
  return candidate.ok === true
    && typeof candidate.message?.body === 'string'
    && Array.isArray(candidate.dispatches);
}

import { WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import {
  createMessageSocketAdapter,
  type MessageDispatchPort,
  type MessageSocketAdapterOptions,
} from './message-socket-adapter.js';

type MessageUseCase = (input: never) => Promise<unknown>;

export interface MessageSocketPort extends MessageDispatchPort {
  sendMessage: MessageUseCase;
  dispatchMessageTracerCommand: MessageUseCase;
  searchMessages: MessageUseCase;
  getMessageContext: MessageUseCase;
  reactMessage: MessageUseCase;
  saveMessage: MessageUseCase;
  listSavedMessages: MessageUseCase;
  pinMessage: MessageUseCase;
  listPinnedMessages: MessageUseCase;
  editMessage: MessageUseCase;
  deleteMessage: MessageUseCase;
  convertMessageToTask: MessageUseCase;
}

export interface MessageSocketBindOptions {
  augmentInput?(input: unknown): unknown | Promise<unknown>;
}

export interface MessageSocketEventBinder {
  bind(
    event: string,
    execute: (input: unknown) => Promise<unknown>,
    afterResult?: (input: unknown, result: unknown) => Promise<void> | void,
    options?: MessageSocketBindOptions,
  ): void;
}

export interface MessageSocketHandlerOptions extends MessageSocketAdapterOptions {
  connectedAgentDeviceIds?(): string[];
  dispatchClaimDeviceIds?(): string[];
  afterMessagePin?(payload: unknown, result: unknown): Promise<void> | void;
}

export interface MessageSocketHandlers {
  /** 注册 send 与 message-tracer 入口；保持它们在跨领域 command 之前的既有顺序。 */
  registerIngress(): void;
  /** 注册其余 Message query/mutation。 */
  registerOperations(): void;
  /** Dispatch 终态后取消尚未发出的 quiet-window wake。 */
  cancelPendingDispatch(dispatchId: string): void;
}

/**
 * 创建 Message bounded context 的 socket 注册 facade。
 * 认证身份注入与 ACK/error 整形由调用方提供的 binder 统一处理。
 */
export function createMessageSocketHandlers(
  binder: MessageSocketEventBinder,
  port: MessageSocketPort,
  options: MessageSocketHandlerOptions,
): MessageSocketHandlers {
  const adapter = createMessageSocketAdapter(port, options);

  return {
    registerIngress() {
      binder.bind(
        WEB_EVENTS.message.send,
        (input) => port.sendMessage(input as never),
        (input, result) => adapter.handleMutation('send', input, result),
        {
          augmentInput(input) {
            return {
              ...(input as Record<string, unknown>),
              connectedAgentDeviceIds: options.connectedAgentDeviceIds?.() ?? [],
              dispatchClaimDeviceIds: options.dispatchClaimDeviceIds?.() ?? [],
            };
          },
        },
      );

      // #921 Message tracer command 路径（默认关闭：use case 在 flag 关闭时返回 disabled）。
      binder.bind(
        WEB_EVENTS.message.messageTracer.command,
        (input) => port.dispatchMessageTracerCommand(input as never),
      );
    },
    registerOperations() {
      binder.bind(WEB_EVENTS.message.search, (input) => port.searchMessages(input as never));
      binder.bind(WEB_EVENTS.message.context, (input) => port.getMessageContext(input as never));
      binder.bind(WEB_EVENTS.message.react, (input) => port.reactMessage(input as never));
      binder.bind(WEB_EVENTS.message.save, (input) => port.saveMessage(input as never));
      binder.bind(WEB_EVENTS.message.listSaved, (input) => port.listSavedMessages(input as never));
      binder.bind(
        WEB_EVENTS.message.pin,
        (input) => port.pinMessage(input as never),
        (input, result) => options.afterMessagePin?.(input, result),
      );
      binder.bind(WEB_EVENTS.message.listPinned, (input) => port.listPinnedMessages(input as never));
      binder.bind(
        WEB_EVENTS.message.edit,
        (input) => port.editMessage(input as never),
        (input, result) => adapter.handleMutation('edit', input, result),
      );
      binder.bind(
        WEB_EVENTS.message.delete,
        (input) => port.deleteMessage(input as never),
        (input, result) => adapter.handleMutation('delete', input, result),
      );
      binder.bind(
        WEB_EVENTS.message.convertToTask,
        (input) => port.convertMessageToTask(input as never),
        (input, result) => adapter.handleMutation('convert-to-task', input, result),
      );
    },
    cancelPendingDispatch(dispatchId) {
      adapter.cancelPendingDispatch(dispatchId);
    },
  };
}

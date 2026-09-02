import { describe, expect, test, vi } from 'vitest';
import { WEB_EVENTS, makeFailure, makeSuccess } from '../../../packages/contracts/src/index.js';
import {
  createMessageSocketHandlers,
  type MessageSocketBindOptions,
  type MessageSocketEventBinder,
  type MessageSocketPort,
} from '../src/transport/message-socket-handlers.js';

type Binding = {
  execute: (input: unknown) => Promise<unknown>;
  afterResult?: (input: unknown, result: unknown) => Promise<void> | void;
  options?: MessageSocketBindOptions;
};

describe('createMessageSocketHandlers', () => {
  test('owns the complete Message event map behind a narrow port', async () => {
    const bindings = new Map<string, Binding>();
    const binder = recordingBinder(bindings);
    const port = messagePort();

    const handlers = createMessageSocketHandlers(binder, port, {});
    handlers.registerIngress();
    handlers.registerOperations();

    const eventToMethod = [
      [WEB_EVENTS.message.send, 'sendMessage'],
      [WEB_EVENTS.message.messageTracer.command, 'dispatchMessageTracerCommand'],
      [WEB_EVENTS.message.search, 'searchMessages'],
      [WEB_EVENTS.message.context, 'getMessageContext'],
      [WEB_EVENTS.message.react, 'reactMessage'],
      [WEB_EVENTS.message.save, 'saveMessage'],
      [WEB_EVENTS.message.listSaved, 'listSavedMessages'],
      [WEB_EVENTS.message.pin, 'pinMessage'],
      [WEB_EVENTS.message.listPinned, 'listPinnedMessages'],
      [WEB_EVENTS.message.edit, 'editMessage'],
      [WEB_EVENTS.message.delete, 'deleteMessage'],
      [WEB_EVENTS.message.convertToTask, 'convertMessageToTask'],
    ] as const;
    expect([...bindings.keys()]).toEqual(eventToMethod.map(([event]) => event));

    for (const [event, method] of eventToMethod) {
      const input = { event };
      await bindings.get(event)?.execute(input);
      expect(port[method]).toHaveBeenCalledWith(input);
    }
  });

  test('declares send augmentation and preserves send/pin post-result hooks', async () => {
    const bindings = new Map<string, Binding>();
    const port = messagePort();
    const afterMessageSend = vi.fn();
    const afterMessagePin = vi.fn();
    const handlers = createMessageSocketHandlers(recordingBinder(bindings), port, {
      connectedAgentDeviceIds: () => ['device-connected'],
      dispatchClaimDeviceIds: () => ['device-claim'],
      afterMessageSend,
      afterMessagePin,
    });
    handlers.registerIngress();
    handlers.registerOperations();

    const send = bindings.get(WEB_EVENTS.message.send);
    const input = await send?.options?.augmentInput?.({ body: 'hello' });
    expect(input).toEqual({
      body: 'hello',
      connectedAgentDeviceIds: ['device-connected'],
      dispatchClaimDeviceIds: ['device-claim'],
    });
    const sendResult = await send?.execute(input);
    await send?.afterResult?.(input, sendResult);
    expect(afterMessageSend).toHaveBeenCalledWith(input, sendResult);

    const pin = bindings.get(WEB_EVENTS.message.pin);
    const pinInput = { messageId: 'message-1' };
    const pinResult = await pin?.execute(pinInput);
    await pin?.afterResult?.(pinInput, pinResult);
    expect(afterMessagePin).toHaveBeenCalledWith(pinInput, pinResult);
  });
});

function recordingBinder(bindings: Map<string, Binding>): MessageSocketEventBinder {
  return {
    bind(event, execute, afterResult, options) {
      bindings.set(event, { execute, afterResult, options });
    },
  };
}

function messagePort() {
  const useCase = () => vi.fn(async (input: never): Promise<unknown> => makeSuccess({ input }));
  return {
    sendMessage: useCase(),
    dispatchMessageTracerCommand: useCase(),
    searchMessages: useCase(),
    getMessageContext: useCase(),
    reactMessage: useCase(),
    saveMessage: useCase(),
    listSavedMessages: useCase(),
    pinMessage: useCase(),
    listPinnedMessages: useCase(),
    editMessage: useCase(),
    deleteMessage: useCase(),
    convertMessageToTask: useCase(),
    getDispatchRequest: vi.fn(async () => makeFailure('NOT_FOUND', 'Dispatch not found')),
  } satisfies MessageSocketPort;
}

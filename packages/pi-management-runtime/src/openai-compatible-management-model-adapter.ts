import type {
  ManagementModelAdapter,
  ManagementModelContent,
  ManagementModelMessage,
  ManagementModelResponse,
  ManagementModelUsage,
} from './types.js';

export type ManagementModelAdapterErrorCode =
  | 'MANAGEMENT_MODEL_ABORTED'
  | 'MANAGEMENT_MODEL_AUTHENTICATION_FAILED'
  | 'MANAGEMENT_MODEL_RATE_LIMITED'
  | 'MANAGEMENT_MODEL_REQUEST_INVALID'
  | 'MANAGEMENT_MODEL_NETWORK_FAILED'
  | 'MANAGEMENT_MODEL_RESPONSE_INVALID'
  | 'MANAGEMENT_MODEL_RESPONSE_INVALID_JSON'
  | 'MANAGEMENT_MODEL_RESPONSE_REJECTED'
  | 'MANAGEMENT_MODEL_SERVER_FAILED'
  | 'MANAGEMENT_MODEL_TIMEOUT'
  | 'MANAGEMENT_MODEL_TOOL_CALL_INVALID';

export class ManagementModelAdapterError extends Error {
  readonly code: ManagementModelAdapterErrorCode;

  constructor(code: ManagementModelAdapterErrorCode) {
    super(code);
    this.name = 'ManagementModelAdapterError';
    this.code = code;
  }
}

export interface CreateOpenAiCompatibleManagementModelAdapterInput {
  readonly id: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly fetch?: typeof fetch;
}

export function createOpenAiCompatibleManagementModelAdapter(
  input: CreateOpenAiCompatibleManagementModelAdapterInput,
): ManagementModelAdapter {
  const fetchFn = input.fetch ?? fetch;
  const endpoint = `${normalizeBaseUrl(input.baseUrl)}/chat/completions`;
  const id = nonEmpty(input.id);
  const modelId = nonEmpty(input.modelId);
  if (!id || !modelId || !nonEmpty(input.apiKey)) {
    throw adapterError('MANAGEMENT_MODEL_REQUEST_INVALID');
  }
  assertOptionalPositiveInteger(input.timeoutMs);
  assertOptionalPositiveInteger(input.maxOutputTokens);

  return {
    id,
    async respond(request): Promise<ManagementModelResponse> {
      if (request.signal?.aborted) throw adapterError('MANAGEMENT_MODEL_ABORTED');

      const abort = createRequestAbort(request.signal, input.timeoutMs);
      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: modelId,
            messages: [
              { role: 'system', content: request.systemPrompt },
              ...request.messages.map(toOpenAiMessage),
            ],
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            ...(input.maxOutputTokens === undefined ? {} : { max_tokens: input.maxOutputTokens }),
            stream: false,
          }),
          signal: abort.signal,
        });
      } catch {
        abort.dispose();
        if (request.signal?.aborted) throw adapterError('MANAGEMENT_MODEL_ABORTED');
        if (abort.didTimeout()) throw adapterError('MANAGEMENT_MODEL_TIMEOUT');
        throw adapterError('MANAGEMENT_MODEL_NETWORK_FAILED');
      }

      try {
        if (!response.ok) throw responseError(response.status);

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          if (request.signal?.aborted) throw adapterError('MANAGEMENT_MODEL_ABORTED');
          if (abort.didTimeout()) throw adapterError('MANAGEMENT_MODEL_TIMEOUT');
          throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID_JSON');
        }
        return parseOpenAiResponse(body, modelId);
      } finally {
        abort.dispose();
      }
    },
  };
}

function toOpenAiMessage(message: ManagementModelMessage): Record<string, unknown> {
  if (message.role === 'user') {
    return { role: 'user', content: message.content.map((item) => item.text).join('\n') };
  }
  if (message.role === 'toolResult') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content.map((item) => item.text).join('\n'),
    };
  }
  const text = message.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  const toolCalls = message.content.flatMap((item) => item.type === 'toolCall' ? [{
    id: item.id,
    type: 'function',
    function: { name: item.name, arguments: JSON.stringify(item.arguments) },
  }] : []);
  return {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function parseOpenAiResponse(value: unknown, fallbackModel: string): ManagementModelResponse {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }
  const choice = value.choices[0];
  if (!isRecord(choice.message)) throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');

  const content: ManagementModelContent[] = [];
  if (typeof choice.message.content === 'string' && choice.message.content.length > 0) {
    content.push({ type: 'text', text: choice.message.content });
  } else if (choice.message.content !== null && choice.message.content !== undefined) {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }

  if (choice.message.tool_calls !== undefined) {
    if (!Array.isArray(choice.message.tool_calls)) {
      throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
    }
    for (const call of choice.message.tool_calls) {
      content.push(parseToolCall(call));
    }
  }
  if (content.length === 0) throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');

  const finishReason = parseFinishReason(choice.finish_reason);
  const hasToolCall = content.some((item) => item.type === 'toolCall');
  if ((hasToolCall && finishReason !== 'tool_use') || (!hasToolCall && finishReason === 'tool_use')) {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }

  return {
    content,
    usage: parseUsage(value.usage),
    finishReason,
    responseModel: typeof value.model === 'string' && value.model.trim()
      ? value.model.trim()
      : fallbackModel,
  };
}

function parseToolCall(value: unknown): Extract<ManagementModelContent, { type: 'toolCall' }> {
  if (!isRecord(value)
    || value.type !== 'function'
    || typeof value.id !== 'string'
    || !value.id.trim()
    || !isRecord(value.function)
    || typeof value.function.name !== 'string'
    || !value.function.name.trim()
    || typeof value.function.arguments !== 'string') {
    throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(value.function.arguments);
  } catch {
    throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
  }
  if (!isRecord(argumentsValue)) throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
  return {
    type: 'toolCall',
    id: value.id,
    name: value.function.name as never,
    arguments: argumentsValue,
  };
}

function parseUsage(value: unknown): ManagementModelUsage {
  if (value === undefined || value === null) return unknownUsage();
  if (!isRecord(value)) throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  const inputTokens = nonNegativeInteger(value.prompt_tokens);
  const outputTokens = nonNegativeInteger(value.completion_tokens);
  if (inputTokens === null || outputTokens === null) {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }
  const reportedTotal = value.total_tokens === undefined
    ? inputTokens + outputTokens
    : nonNegativeInteger(value.total_tokens);
  if (reportedTotal === null || reportedTotal !== inputTokens + outputTokens) {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: reportedTotal,
  };
}

function parseFinishReason(value: unknown): ManagementModelResponse['finishReason'] {
  if (value === 'stop') return 'stop';
  if (value === 'tool_calls') return 'tool_use';
  if (value === 'length') return 'length';
  if (value === 'content_filter') return 'content_filter';
  if (value === null || value === undefined) return 'unknown';
  throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
}

function responseError(status: number): ManagementModelAdapterError {
  if (status === 401 || status === 403) return adapterError('MANAGEMENT_MODEL_AUTHENTICATION_FAILED');
  if (status === 429) return adapterError('MANAGEMENT_MODEL_RATE_LIMITED');
  if (status >= 500) return adapterError('MANAGEMENT_MODEL_SERVER_FAILED');
  return adapterError('MANAGEMENT_MODEL_RESPONSE_REJECTED');
}

function createRequestAbort(externalSignal: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      if (timeout !== undefined) clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) throw adapterError('MANAGEMENT_MODEL_REQUEST_INVALID');
  return normalized;
}

function nonEmpty(value: string): string | undefined {
  const normalized = value.trim();
  return normalized || undefined;
}

function assertOptionalPositiveInteger(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw adapterError('MANAGEMENT_MODEL_REQUEST_INVALID');
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function unknownUsage(): ManagementModelUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  };
}

function adapterError(code: ManagementModelAdapterErrorCode): ManagementModelAdapterError {
  return new ManagementModelAdapterError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

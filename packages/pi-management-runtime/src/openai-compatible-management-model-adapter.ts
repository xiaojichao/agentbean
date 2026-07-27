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
  /** Provider 上线探测使用：缺少 model 或 usage 时 fail closed。 */
  readonly requireResponseMetadata?: boolean;
  /**
   * Merged into the Chat Completions JSON body (e.g. DeepSeek
   * `{ thinking: { type: 'disabled' } }` for deterministic probes).
   */
  readonly requestBodyExtras?: Readonly<Record<string, unknown>>;
  /** When tools are present, set `tool_choice: 'required'` (connectivity probes). */
  readonly forceRequiredToolChoiceWhenToolsPresent?: boolean;
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

      // DeepSeek / OpenAI function names: a-z A-Z 0-9 _ - only (no dots). Keep dotted
      // catalog names internally; map to wire-safe names for the provider request and back.
      const toolNames = buildToolNameWireMap(request.tools.map((tool) => tool.name));

      const abort = createRequestAbort(request.signal, input.timeoutMs);
      let response: Response;
      try {
        const body: Record<string, unknown> = {
          model: modelId,
          messages: [
            { role: 'system', content: request.systemPrompt },
            ...request.messages.map((message) => toOpenAiMessage(message, toolNames.toWire)),
          ],
          stream: false,
        };
        if (request.tools.length > 0) {
          body.tools = request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: toolNames.toWire(tool.name),
              description: tool.description,
              parameters: tool.inputSchema,
            },
          }));
          if (input.forceRequiredToolChoiceWhenToolsPresent) {
            body.tool_choice = 'required';
          }
        }
        if (input.maxOutputTokens !== undefined) {
          body.max_tokens = input.maxOutputTokens;
        }
        if (input.requestBodyExtras) {
          Object.assign(body, input.requestBodyExtras);
        }
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
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
        return parseOpenAiResponse(
          body,
          modelId,
          input.requireResponseMetadata ?? false,
          toolNames.fromWire,
        );
      } finally {
        abort.dispose();
      }
    },
  };
}

/**
 * Map catalog tool names (often dotted, e.g. context.get_root_message) to provider-safe
 * function names required by DeepSeek and the OpenAI function-name grammar.
 */
export function toProviderSafeToolName(name: string): string {
  return name.replace(/\./g, '_');
}

function buildToolNameWireMap(toolNames: readonly string[]): {
  toWire(name: string): string;
  fromWire(name: string): string;
} {
  const wireByOriginal = new Map<string, string>();
  const originalByWire = new Map<string, string>();
  for (const original of toolNames) {
    const wire = toProviderSafeToolName(original);
    const existing = originalByWire.get(wire);
    if (existing !== undefined && existing !== original) {
      throw adapterError('MANAGEMENT_MODEL_REQUEST_INVALID');
    }
    wireByOriginal.set(original, wire);
    originalByWire.set(wire, original);
    // Accept providers that echo the catalog name unchanged.
    originalByWire.set(original, original);
  }
  return {
    toWire: (name) => wireByOriginal.get(name) ?? toProviderSafeToolName(name),
    fromWire: (name) => originalByWire.get(name) ?? name,
  };
}

function toOpenAiMessage(
  message: ManagementModelMessage,
  toWireToolName: (name: string) => string,
): Record<string, unknown> {
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
    function: { name: toWireToolName(item.name), arguments: JSON.stringify(item.arguments) },
  }] : []);
  return {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function parseOpenAiResponse(
  value: unknown,
  fallbackModel: string,
  requireResponseMetadata: boolean,
  fromWireToolName: (name: string) => string = (name) => name,
): ManagementModelResponse {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }
  const choice = value.choices[0];
  if (!isRecord(choice.message)) throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');

  const content: ManagementModelContent[] = [];
  // DeepSeek may return content: "" or multimodal-style content arrays with tool_calls.
  const rawContent = choice.message.content;
  if (typeof rawContent === 'string') {
    if (rawContent.length > 0) content.push({ type: 'text', text: rawContent });
  } else if (Array.isArray(rawContent)) {
    const text = rawContent
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
    if (text.length > 0) content.push({ type: 'text', text });
  } else if (rawContent !== null && rawContent !== undefined) {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }

  if (choice.message.tool_calls !== undefined) {
    if (!Array.isArray(choice.message.tool_calls)) {
      throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
    }
    for (const call of choice.message.tool_calls) {
      content.push(parseToolCall(call, fromWireToolName));
    }
  }
  let finishReason = parseFinishReason(choice.finish_reason);
  const hasToolCall = content.some((item) => item.type === 'toolCall');
  // If the provider emitted tool_calls but finish_reason is missing/unknown, treat as tool_use.
  if (hasToolCall && finishReason !== 'tool_use') {
    finishReason = 'tool_use';
  } else if (!hasToolCall && finishReason === 'tool_use') {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }

  const responseModel = typeof value.model === 'string' && value.model.trim()
    ? value.model.trim()
    : null;
  if (requireResponseMetadata && (!responseModel || value.usage === undefined || value.usage === null)) {
    throw adapterError('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }

  return {
    content,
    usage: parseUsage(value.usage),
    finishReason,
    responseModel: responseModel ?? fallbackModel,
  };
}

function parseToolCall(
  value: unknown,
  fromWireToolName: (name: string) => string = (name) => name,
): Extract<ManagementModelContent, { type: 'toolCall' }> {
  if (!isRecord(value)
    || (value.type !== undefined && value.type !== 'function')
    || typeof value.id !== 'string'
    || !value.id.trim()
    || !isRecord(value.function)
    || typeof value.function.name !== 'string'
    || !value.function.name.trim()) {
    throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
  }
  let argumentsValue: unknown;
  const rawArgs = value.function.arguments;
  if (typeof rawArgs === 'string') {
    try {
      argumentsValue = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
    } catch {
      throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
    }
  } else if (isRecord(rawArgs) || rawArgs === undefined || rawArgs === null) {
    // Some providers return already-parsed objects (or omit empty args).
    argumentsValue = rawArgs ?? {};
  } else {
    throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
  }
  if (!isRecord(argumentsValue)) throw adapterError('MANAGEMENT_MODEL_TOOL_CALL_INVALID');
  return {
    type: 'toolCall',
    id: value.id,
    name: fromWireToolName(value.function.name) as never,
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
  // Prefer provider total when it matches; otherwise use the arithmetic sum.
  // DeepSeek thinking/cache fields sometimes make total ≠ prompt+completion.
  const reportedTotal = nonNegativeInteger(value.total_tokens);
  const sum = inputTokens + outputTokens;
  const totalTokens = reportedTotal === null || reportedTotal !== sum ? sum : reportedTotal;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
  };
}

function parseFinishReason(value: unknown): ManagementModelResponse['finishReason'] {
  if (value === 'stop') return 'stop';
  if (value === 'tool_calls') return 'tool_use';
  if (value === 'length') return 'length';
  if (value === 'content_filter') return 'content_filter';
  return 'unknown';
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
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    value = Number(value);
  }
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

import type {
  ManagementModelAdapter,
  ManagementModelContent,
  ManagementModelMessage,
  ManagementModelResponse,
} from '@agentbean/pi-management-runtime';
import type { ManagementCredentialResolution } from './management-credential-provider.js';

type AvailableManagementCredential = Exclude<ManagementCredentialResolution, { credentialStatus: 'unavailable' }>;

export interface CreateManagementModelAdapterInput {
  readonly credential: AvailableManagementCredential;
  readonly fetch?: typeof fetch;
}

export function createManagementModelAdapter(input: CreateManagementModelAdapterInput): ManagementModelAdapter {
  const fetchFn = input.fetch ?? fetch;
  const { credential } = input;
  return {
    id: `${credential.providerId}:${credential.modelId}`,
    async respond(request): Promise<ManagementModelResponse> {
      let response: Response;
      try {
        response = await fetchFn(`${credential.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: credential.modelId,
            messages: [
              { role: 'system', content: request.systemPrompt },
              ...request.messages.map(toOpenAiMessage),
            ],
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
          }),
          signal: request.signal,
        });
      } catch {
        throw new Error('MANAGEMENT_MODEL_REQUEST_FAILED');
      }
      if (!response.ok) throw new Error('MANAGEMENT_MODEL_RESPONSE_REJECTED');
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('MANAGEMENT_MODEL_RESPONSE_INVALID');
      }
      return parseOpenAiResponse(body, credential.modelId);
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
  const text = message.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  const toolCalls = message.content.flatMap((item) => item.type === 'toolCall' ? [{
    id: item.id,
    type: 'function',
    function: { name: item.name, arguments: JSON.stringify(item.arguments) },
  }] : []);
  return { role: 'assistant', content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
}

function parseOpenAiResponse(value: unknown, fallbackModel: string): ManagementModelResponse {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    throw new Error('MANAGEMENT_MODEL_RESPONSE_INVALID');
  }
  const choice = value.choices[0];
  const message = isRecord(choice.message) ? choice.message : {};
  const content: ManagementModelContent[] = [];
  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call) || typeof call.id !== 'string' || !isRecord(call.function)
        || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') {
        throw new Error('MANAGEMENT_MODEL_RESPONSE_INVALID');
      }
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(call.function.arguments);
      } catch {
        throw new Error('MANAGEMENT_MODEL_RESPONSE_INVALID');
      }
      if (!isRecord(argumentsValue)) throw new Error('MANAGEMENT_MODEL_RESPONSE_INVALID');
      content.push({
        type: 'toolCall',
        id: call.id,
        name: call.function.name as never,
        arguments: argumentsValue,
      });
    }
  }
  const usage = isRecord(value.usage) ? value.usage : {};
  const inputTokens = integer(usage.prompt_tokens);
  const outputTokens = integer(usage.completion_tokens);
  return {
    content,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: integer(usage.total_tokens) || inputTokens + outputTokens,
    },
    finishReason: finishReason(choice.finish_reason),
    responseModel: typeof value.model === 'string' ? value.model : fallbackModel,
  };
}

function finishReason(value: unknown): ManagementModelResponse['finishReason'] {
  if (value === 'stop') return 'stop';
  if (value === 'tool_calls') return 'tool_use';
  if (value === 'length') return 'length';
  if (value === 'content_filter') return 'content_filter';
  return 'unknown';
}

function integer(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

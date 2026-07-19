import type {
  ManagementFinishReason,
  ManagementModelResponse,
  ManagementModelTelemetry,
  ManagementModelUsage,
} from './types.js';
import { MANAGEMENT_TOOL_NAMES } from './types.js';

const FINISH_REASONS = new Set<ManagementFinishReason>([
  'stop',
  'tool_use',
  'length',
  'content_filter',
  'aborted',
  'error',
  'unknown',
]);

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUsage(value: unknown): ManagementModelUsage {
  if (!value || typeof value !== 'object') throw new Error('P1_MODEL_RESPONSE_INVALID');
  const usage = value as Record<string, unknown>;
  const fields = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
  ];
  if (fields.every((field) => field === null)) {
    return {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    };
  }
  if (!fields.every(isNonNegativeInteger)) throw new Error('P1_MODEL_RESPONSE_INVALID');
  const expectedTotal = Number(usage.inputTokens) + Number(usage.outputTokens)
    + Number(usage.cacheReadTokens) + Number(usage.cacheWriteTokens);
  if (usage.totalTokens !== expectedTotal) throw new Error('P1_MODEL_RESPONSE_INVALID');
  return {
    inputTokens: Number(usage.inputTokens),
    outputTokens: Number(usage.outputTokens),
    cacheReadTokens: Number(usage.cacheReadTokens),
    cacheWriteTokens: Number(usage.cacheWriteTokens),
    totalTokens: Number(usage.totalTokens),
  };
}

export function normalizeManagementModelResponse(response: ManagementModelResponse): ManagementModelResponse {
  if (!isRecord(response) || !Array.isArray(response.content)) {
    throw new Error('P1_MODEL_RESPONSE_INVALID');
  }
  if (!FINISH_REASONS.has(response.finishReason as ManagementFinishReason)
    || typeof response.responseModel !== 'string'
    || !response.responseModel.trim()) {
    throw new Error('P1_MODEL_RESPONSE_INVALID');
  }
  const usage = normalizeUsage(response.usage);
  const content = response.content.map((item) => {
    if (!isRecord(item)) throw new Error('P1_MODEL_RESPONSE_INVALID');
    if (item.type === 'text') {
      if (typeof item.text !== 'string') throw new Error('P1_MODEL_RESPONSE_INVALID');
      return { type: 'text' as const, text: item.text };
    }
    if (item.type === 'toolCall') {
      if (typeof item.id !== 'string' || !item.id.trim()
        || typeof item.name !== 'string'
        || !MANAGEMENT_TOOL_NAMES.includes(item.name as (typeof MANAGEMENT_TOOL_NAMES)[number])
        || !isRecord(item.arguments)) {
        throw new Error('P1_MODEL_RESPONSE_INVALID');
      }
      return {
        type: 'toolCall' as const,
        id: item.id,
        name: item.name as (typeof MANAGEMENT_TOOL_NAMES)[number],
        arguments: structuredClone(item.arguments),
      };
    }
    throw new Error('P1_MODEL_RESPONSE_INVALID');
  });
  const hasToolCall = content.some((item) => item.type === 'toolCall');
  if ((hasToolCall && response.finishReason !== 'tool_use')
    || (!hasToolCall && response.finishReason === 'tool_use')) {
    throw new Error('P1_MODEL_RESPONSE_INVALID');
  }
  return {
    content,
    usage,
    finishReason: response.finishReason as ManagementFinishReason,
    responseModel: response.responseModel.trim(),
  };
}

export function safeProviderFailureTelemetry(input: {
  aborted: boolean;
  responseModel: string;
}): ManagementModelTelemetry {
  return {
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    },
    finishReason: input.aborted ? 'aborted' : 'error',
    responseModel: input.responseModel,
  };
}

export function toPiStopReason(reason: ManagementFinishReason): 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' {
  if (reason === 'tool_use') return 'toolUse';
  if (reason === 'length') return 'length';
  if (reason === 'aborted') return 'aborted';
  if (reason === 'error' || reason === 'content_filter' || reason === 'unknown') return 'error';
  return 'stop';
}

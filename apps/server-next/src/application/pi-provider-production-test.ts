/**
 * 使用与生产协调相同的 OpenAI-compatible Adapter，对 Draft 配置执行
 * 固定无业务数据的普通文本 + 完整 tool-call 回合测试。
 */

import {
  ManagementModelAdapterError,
  createOpenAiCompatibleManagementModelAdapter,
  type ManagementModelRequest,
  type ManagementModelResponse,
} from '@agentbean/pi-management-runtime';
import {
  PI_PROVIDER_PROBE,
  PI_PROVIDER_PROBE_TOOL,
} from '../../../../packages/domain/src/index.js';
import type { PiProviderConfigDto } from '../../../../packages/contracts/src/index.js';

export interface RunPiProviderProductionTestInput {
  readonly apiKey: string;
  readonly config: PiProviderConfigDto;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface PiProviderProductionTestOutcome {
  readonly status: 'passed' | 'failed';
  readonly textOk: boolean;
  readonly toolCallOk: boolean;
  readonly responseModel: string | null;
  readonly finishReasonText: string | null;
  readonly finishReasonTool: string | null;
  readonly usageInputTokens: number | null;
  readonly usageOutputTokens: number | null;
  readonly durationMs: number;
  readonly diagnosticCode: string | null;
}

const PROBE_TOOL = {
  name: PI_PROVIDER_PROBE_TOOL.name,
  description: PI_PROVIDER_PROBE_TOOL.description,
  inputSchema: PI_PROVIDER_PROBE_TOOL.inputSchema,
  metadata: { phase: 1 as const, effect: 'read' as const, scope: 'thread' as const },
};

// sessionContext 仅满足类型；Adapter 不读取。
const EMPTY_SESSION_CONTEXT = {
  schemaVersion: 1 as const,
  mode: 'managed' as const,
  scope: {
    kind: 'managed' as const,
    managementRunId: 'pi-provider-probe',
    teamId: 'system',
    channelId: 'system',
    rootMessageId: 'probe',
  },
  visibleMessages: [],
  visibleCheckpoint: {
    revision: 0,
    lastEventSequence: 0,
    objective: 'probe',
    planSummary: 'probe',
  },
};

export async function runPiProviderProductionTest(
  input: RunPiProviderProductionTestInput,
): Promise<PiProviderProductionTestOutcome> {
  const now = input.now ?? Date.now;
  const started = now();
  const adapter = createOpenAiCompatibleManagementModelAdapter({
    id: `pi-provider-probe:${input.config.modelId}`,
    apiKey: input.apiKey,
    baseUrl: input.config.baseUrl,
    modelId: input.config.modelId,
    timeoutMs: input.config.timeoutMs,
    maxOutputTokens: Math.min(input.config.maxOutputTokens, 256),
    fetch: input.fetch,
  });

  let textOk = false;
  let toolCallOk = false;
  let responseModel: string | null = null;
  let finishReasonText: string | null = null;
  let finishReasonTool: string | null = null;
  let usageInputTokens: number | null = null;
  let usageOutputTokens: number | null = null;

  try {
    // 1) 普通文本
    const textResponse = await adapter.respond(buildTextRequest(), { callCount: 1 });
    const textCheck = assertTextProbe(textResponse);
    if (!textCheck.ok) {
      return failed(started, now, {
        textOk: false,
        toolCallOk: false,
        responseModel: textResponse.responseModel ?? null,
        finishReasonText: textResponse.finishReason,
        finishReasonTool: null,
        usageInputTokens: textResponse.usage.inputTokens,
        usageOutputTokens: textResponse.usage.outputTokens,
        diagnosticCode: textCheck.code,
      });
    }
    textOk = true;
    responseModel = textResponse.responseModel;
    finishReasonText = textResponse.finishReason;
    usageInputTokens = textResponse.usage.inputTokens;
    usageOutputTokens = textResponse.usage.outputTokens;

    // 2) 发起 tool call
    const toolCallResponse = await adapter.respond(buildToolCallRequest(), { callCount: 2 });
    const toolCall = extractToolCall(toolCallResponse);
    if (!toolCall) {
      return failed(started, now, {
        textOk,
        toolCallOk: false,
        responseModel: toolCallResponse.responseModel ?? responseModel,
        finishReasonText,
        finishReasonTool: toolCallResponse.finishReason,
        usageInputTokens,
        usageOutputTokens,
        diagnosticCode: 'PI_PROVIDER_TEST_TOOL_CALL_MISSING',
      });
    }
    finishReasonTool = toolCallResponse.finishReason;
    responseModel = toolCallResponse.responseModel ?? responseModel;

    // 3) tool result → 最终文本
    const finalResponse = await adapter.respond(
      buildToolResultRequest(toolCall.id, toolCall.name),
      { callCount: 3 },
    );
    const finalCheck = assertFinalProbe(finalResponse);
    if (!finalCheck.ok) {
      return failed(started, now, {
        textOk,
        toolCallOk: false,
        responseModel: finalResponse.responseModel ?? responseModel,
        finishReasonText,
        finishReasonTool: finalResponse.finishReason,
        usageInputTokens: finalResponse.usage.inputTokens ?? usageInputTokens,
        usageOutputTokens: finalResponse.usage.outputTokens ?? usageOutputTokens,
        diagnosticCode: finalCheck.code,
      });
    }
    toolCallOk = true;
    responseModel = finalResponse.responseModel ?? responseModel;
    usageInputTokens = finalResponse.usage.inputTokens ?? usageInputTokens;
    usageOutputTokens = finalResponse.usage.outputTokens ?? usageOutputTokens;

    return {
      status: 'passed',
      textOk: true,
      toolCallOk: true,
      responseModel,
      finishReasonText,
      finishReasonTool,
      usageInputTokens,
      usageOutputTokens,
      durationMs: Math.max(0, now() - started),
      diagnosticCode: null,
    };
  } catch (error) {
    return failed(started, now, {
      textOk,
      toolCallOk,
      responseModel,
      finishReasonText,
      finishReasonTool,
      usageInputTokens,
      usageOutputTokens,
      diagnosticCode: mapAdapterError(error),
    });
  }
}

function buildTextRequest(): ManagementModelRequest {
  return {
    systemPrompt: PI_PROVIDER_PROBE.textSystem,
    sessionContext: EMPTY_SESSION_CONTEXT as never,
    messages: [{ role: 'user', content: [{ type: 'text', text: PI_PROVIDER_PROBE.textUser }] }],
    tools: [],
  };
}

function buildToolCallRequest(): ManagementModelRequest {
  return {
    systemPrompt: PI_PROVIDER_PROBE.toolSystem,
    sessionContext: EMPTY_SESSION_CONTEXT as never,
    messages: [{ role: 'user', content: [{ type: 'text', text: PI_PROVIDER_PROBE.toolUser }] }],
    tools: [PROBE_TOOL as never],
  };
}

function buildToolResultRequest(toolCallId: string, toolName: string): ManagementModelRequest {
  return {
    systemPrompt: PI_PROVIDER_PROBE.toolFinalSystem,
    sessionContext: EMPTY_SESSION_CONTEXT as never,
    messages: [
      { role: 'user', content: [{ type: 'text', text: PI_PROVIDER_PROBE.toolUser }] },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: toolCallId,
          name: toolName as never,
          arguments: {},
        }],
      },
      {
        role: 'toolResult',
        toolCallId,
        toolName: toolName as never,
        content: [{ type: 'text', text: PI_PROVIDER_PROBE.toolResultContent }],
        isError: false,
      },
    ],
    tools: [PROBE_TOOL as never],
  };
}

function assertTextProbe(
  response: ManagementModelResponse,
): { ok: true } | { ok: false; code: string } {
  if (response.finishReason !== 'stop' && response.finishReason !== 'length') {
    return { ok: false, code: 'PI_PROVIDER_TEST_TEXT_FINISH_REASON' };
  }
  const text = response.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('')
    .trim();
  if (!text) return { ok: false, code: 'PI_PROVIDER_TEST_TEXT_EMPTY' };
  if (!response.responseModel) return { ok: false, code: 'PI_PROVIDER_TEST_RESPONSE_MODEL_MISSING' };
  return { ok: true };
}

function extractToolCall(
  response: ManagementModelResponse,
): { id: string; name: string } | null {
  if (response.finishReason !== 'tool_use') return null;
  const call = response.content.find((item) => item.type === 'toolCall');
  if (!call || call.type !== 'toolCall') return null;
  if (call.name !== PI_PROVIDER_PROBE_TOOL.name) return null;
  return { id: call.id, name: call.name };
}

function assertFinalProbe(
  response: ManagementModelResponse,
): { ok: true } | { ok: false; code: string } {
  if (response.finishReason !== 'stop' && response.finishReason !== 'length') {
    return { ok: false, code: 'PI_PROVIDER_TEST_FINAL_FINISH_REASON' };
  }
  const text = response.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('')
    .trim();
  if (!text) return { ok: false, code: 'PI_PROVIDER_TEST_FINAL_EMPTY' };
  return { ok: true };
}

function mapAdapterError(error: unknown): string {
  if (error instanceof ManagementModelAdapterError) {
    return error.code;
  }
  return 'PI_PROVIDER_TEST_UNKNOWN_FAILURE';
}

function failed(
  started: number,
  now: () => number,
  fields: Omit<PiProviderProductionTestOutcome, 'status' | 'durationMs'>,
): PiProviderProductionTestOutcome {
  return {
    status: 'failed',
    durationMs: Math.max(0, now() - started),
    ...fields,
  };
}

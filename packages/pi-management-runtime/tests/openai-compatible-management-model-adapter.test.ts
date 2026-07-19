import { describe, expect, it, vi } from 'vitest';

import {
  ManagementModelAdapterError,
  createOpenAiCompatibleManagementModelAdapter,
  type ManagementModelRequest,
} from '../src/index.js';

const request: ManagementModelRequest = {
  systemPrompt: 'Coordinate safely.',
  sessionContext: {} as never,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [{
    name: 'context.get_root_message',
    description: 'Read the root message.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    metadata: { phase: 1, effect: 'read', scope: 'thread' } as never,
  }],
};

function adapter(fetchFn: typeof fetch, overrides: {
  timeoutMs?: number;
  maxOutputTokens?: number;
} = {}) {
  return createOpenAiCompatibleManagementModelAdapter({
    id: 'provider-1:model-1',
    apiKey: 'sk-never-expose',
    baseUrl: 'https://provider.invalid/v1/',
    modelId: 'model-1',
    fetch: fetchFn,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAI-compatible Management Model Adapter', () => {
  it('发送非流式 Chat Completions 请求并解析普通文本与 usage', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({
      model: 'provider-model-1',
      choices: [{ message: { role: 'assistant', content: 'ack' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }));

    const response = await adapter(fetchFn, { maxOutputTokens: 123 }).respond(request, { callCount: 1 });

    expect(response).toEqual({
      content: [{ type: 'text', text: 'ack' }],
      finishReason: 'stop',
      responseModel: 'provider-model-1',
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 10,
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://provider.invalid/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'model-1',
      stream: false,
      max_tokens: 123,
      messages: [
        { role: 'system', content: 'Coordinate safely.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'context.get_root_message' },
      }],
    });
  });

  it('用同一路径序列化 assistant tool call、tool result 并解析完整 tool-call 回合', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-2',
            type: 'function',
            function: { name: 'context.get_root_message', arguments: '{"includeBody":true}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }));
    const toolRoundRequest: ManagementModelRequest = {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: [{
            type: 'toolCall', id: 'call-1', name: 'context.get_root_message', arguments: {},
          }],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'context.get_root_message',
          content: [{ type: 'text', text: 'root body' }],
          isError: false,
        },
      ],
    };

    const response = await adapter(fetchFn).respond(toolRoundRequest, { callCount: 2 });

    expect(response).toEqual({
      content: [{
        type: 'toolCall',
        id: 'call-2',
        name: 'context.get_root_message',
        arguments: { includeBody: true },
      }],
      finishReason: 'tool_use',
      responseModel: 'model-1',
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
      },
    });
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]?.body));
    expect(body.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'context.get_root_message', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'root body' },
    ]);
  });

  it.each([
    [401, 'MANAGEMENT_MODEL_AUTHENTICATION_FAILED'],
    [403, 'MANAGEMENT_MODEL_AUTHENTICATION_FAILED'],
    [429, 'MANAGEMENT_MODEL_RATE_LIMITED'],
    [500, 'MANAGEMENT_MODEL_SERVER_FAILED'],
    [400, 'MANAGEMENT_MODEL_RESPONSE_REJECTED'],
  ] as const)('将 HTTP %i 映射为稳定诊断码 %s 且不暴露响应正文', async (status, code) => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(
      `upstream leaked sk-never-expose at ${status}`,
      { status },
    ));

    const promise = adapter(fetchFn).respond(request, { callCount: 1 });
    await expect(promise).rejects.toMatchObject({ code, message: code });
    await expect(promise).rejects.not.toThrow(/sk-never-expose|upstream leaked/);
  });

  it('区分网络失败、非法 JSON 与非法 tool call', async () => {
    await expect(adapter(vi.fn<typeof fetch>(async () => {
      throw new Error('network includes sk-never-expose');
    })).respond(request, { callCount: 1 })).rejects.toMatchObject({
      code: 'MANAGEMENT_MODEL_NETWORK_FAILED',
    });

    await expect(adapter(vi.fn<typeof fetch>(async () => new Response('not json')))
      .respond(request, { callCount: 1 })).rejects.toMatchObject({
      code: 'MANAGEMENT_MODEL_RESPONSE_INVALID_JSON',
    });

    await expect(adapter(vi.fn<typeof fetch>(async () => jsonResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1', type: 'function', function: { name: 'bad', arguments: '{' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }))).respond(request, { callCount: 1 })).rejects.toMatchObject({
      code: 'MANAGEMENT_MODEL_TOOL_CALL_INVALID',
    });
  });

  it('区分 timeout 与外部 AbortSignal 取消', async () => {
    const waitForAbort = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await expect(adapter(waitForAbort, { timeoutMs: 5 }).respond(request, { callCount: 1 }))
      .rejects.toMatchObject({ code: 'MANAGEMENT_MODEL_TIMEOUT' });

    const controller = new AbortController();
    const cancelled = adapter(waitForAbort, { timeoutMs: 100 }).respond(
      { ...request, signal: controller.signal },
      { callCount: 1 },
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'MANAGEMENT_MODEL_ABORTED' });
  });

  it('导出可识别且只包含诊断码的错误类型', () => {
    const error = new ManagementModelAdapterError('MANAGEMENT_MODEL_TIMEOUT');
    expect(error).toMatchObject({ name: 'ManagementModelAdapterError', code: 'MANAGEMENT_MODEL_TIMEOUT' });
    expect(JSON.stringify(error)).not.toContain('sk-');
  });
});

import { describe, expect, test, vi } from 'vitest';
import { createDeviceServiceCore } from '../src/device-service-core';
import {
  createEnvironmentManagementCredentialProvider,
  managementCredentialCapability,
} from '../src/management-credential-provider';
import { createManagementModelAdapter } from '../src/management-model-adapter';

const managementModelRequest = {
  systemPrompt: 'system',
  sessionContext: {} as never,
  messages: [],
  tools: [],
};

function createTestManagementModelAdapter(fetchFn: typeof fetch) {
  return createManagementModelAdapter({
    credential: {
      credentialStatus: 'test_only', providerId: 'provider-1', modelId: 'model-1',
      apiKey: 'sk-never-log-this', baseUrl: 'https://model.invalid/v1',
    },
    fetch: fetchFn,
  });
}

describe('DeviceServiceCore', () => {
  test('按 Dispatch、Task Claim、PI Manager 顺序启动，并按反序停止', async () => {
    const calls: string[] = [];
    const core = createDeviceServiceCore({
      dispatchClient: {
        start: vi.fn(async () => { calls.push('dispatch:start'); }),
        stop: vi.fn(() => { calls.push('dispatch:stop'); }),
      },
      taskClaimClient: {
        start: vi.fn(async () => { calls.push('claim:start'); }),
        stop: vi.fn(async () => { calls.push('claim:stop'); }),
      },
      managementWorkerHost: {
        start: vi.fn(async () => { calls.push('management:start'); }),
        stop: vi.fn(async () => { calls.push('management:stop'); }),
      },
    });

    await core.start();
    await core.stop();

    expect(calls).toEqual([
      'dispatch:start',
      'claim:start',
      'management:start',
      'management:stop',
      'claim:stop',
      'dispatch:stop',
    ]);
  });

  test('管理宿主启动失败时回滚已经启动的 Dispatch client', async () => {
    const stop = vi.fn();
    const core = createDeviceServiceCore({
      dispatchClient: { start: vi.fn(async () => undefined), stop },
      managementWorkerHost: {
        start: vi.fn(async () => { throw new Error('register failed'); }),
      },
    });

    await expect(core.start()).rejects.toThrow('register failed');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('排空并发通知组件并聚合活动工作与 outbox 计数', async () => {
    const dispatchDrain = vi.fn(async () => undefined);
    const managementDrain = vi.fn(async () => undefined);
    const core = createDeviceServiceCore({
      dispatchClient: {
        start: vi.fn(async () => undefined), beginDrain: dispatchDrain,
        activeWorkCount: () => 2, outboxPendingCount: () => 3,
      },
      managementWorkerHost: {
        start: vi.fn(async () => undefined), beginDrain: managementDrain,
        activeWorkCount: () => 1, outboxPendingCount: () => 4,
      },
    });
    await core.beginDrain(1000);
    expect(dispatchDrain).toHaveBeenCalledWith(1000);
    expect(managementDrain).toHaveBeenCalledWith(1000);
    expect(core.activeWorkCount()).toBe(3);
    expect(core.outboxPendingCount()).toBe(7);
  });
});

describe('ManagementCredentialProvider', () => {
  test('凭据缺失时 capability 明确 unavailable', async () => {
    const provider = createEnvironmentManagementCredentialProvider({ env: {} });
    const resolved = await provider.resolve();

    expect(resolved).toEqual({ credentialStatus: 'unavailable' });
    expect(managementCredentialCapability(resolved)).toEqual({ credentialStatus: 'unavailable' });
  });

  test('显式环境凭据只标记 test_only，capability 不泄漏 secret', async () => {
    const provider = createEnvironmentManagementCredentialProvider({
      env: {
        AGENTBEAN_MANAGEMENT_API_KEY: 'sk-local-secret',
        AGENTBEAN_MANAGEMENT_PROVIDER_ID: 'openai-compatible',
        AGENTBEAN_MANAGEMENT_MODEL_ID: 'test-model',
      },
    });
    const resolved = await provider.resolve();
    const capability = managementCredentialCapability(resolved);

    expect(resolved).toMatchObject({ credentialStatus: 'test_only', apiKey: 'sk-local-secret' });
    expect(capability).toEqual({
      credentialStatus: 'test_only',
      providerId: 'openai-compatible',
      modelId: 'test-model',
    });
    expect(JSON.stringify(capability)).not.toContain('sk-local-secret');
  });

  test('model adapter 的失败只暴露稳定诊断码，不拼接 API key 或响应正文', async () => {
    const adapter = createTestManagementModelAdapter(
      vi.fn(async () => new Response('upstream says sk-never-log-this', { status: 500 })),
    );

    await expect(adapter.respond(managementModelRequest, { callCount: 1 }))
      .rejects.toThrow('MANAGEMENT_MODEL_RESPONSE_REJECTED');
  });

  test('Device 兼容包装继续接受 content 为空的成功响应', async () => {
    const adapter = createTestManagementModelAdapter(
      vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
      }), { status: 200 })),
    );

    await expect(adapter.respond(managementModelRequest, { callCount: 1 })).resolves.toEqual({
      content: [],
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
      },
      finishReason: 'stop',
      responseModel: 'model-1',
    });
  });

  test('Device 兼容包装继续将未知 finish reason 映射为 unknown', async () => {
    const adapter = createTestManagementModelAdapter(
      vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ack' }, finish_reason: 'provider_specific' }],
      }), { status: 200 })),
    );

    await expect(adapter.respond(managementModelRequest, { callCount: 1 })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ack' }],
      finishReason: 'unknown',
      responseModel: 'model-1',
    });
  });

  test('Device 兼容包装继续接受省略 type 的有效 tool call', async () => {
    const adapter = createTestManagementModelAdapter(
      vi.fn(async () => new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-1',
              function: { name: 'context.get_root_message', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }), { status: 200 })),
    );

    await expect(adapter.respond(managementModelRequest, { callCount: 1 })).resolves.toMatchObject({
      content: [{
        type: 'toolCall',
        id: 'call-1',
        name: 'context.get_root_message',
        arguments: {},
      }],
      finishReason: 'tool_use',
      responseModel: 'model-1',
    });
  });
});

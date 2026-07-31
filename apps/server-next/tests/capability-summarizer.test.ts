import { describe, expect, test, vi } from 'vitest';
import { createCapabilitySummarizer } from '../src/application/capability-summarizer';

interface TestContext {
  updateSummarized: ReturnType<typeof vi.fn>;
  clockNow: number;
  resolveTarget: () => Promise<{ kind: 'available'; config: { baseUrl: string; modelId: string; timeoutMs: number; maxOutputTokens: number }; apiKey: string } | { kind: 'unavailable'; diagnosticCode: string }>;
  fetchFn: ReturnType<typeof vi.fn>;
}

function makeContext(overrides: Partial<TestContext> = {}): TestContext {
  const updateSummarized = vi.fn().mockResolvedValue(null);
  const fetchFn = vi.fn();
  const resolveTarget = async () => ({
    kind: 'available' as const,
    config: { baseUrl: 'https://api.example.com', modelId: 'test-model', timeoutMs: 10000, maxOutputTokens: 1024 },
    apiKey: 'test-key',
  });
  return {
    updateSummarized,
    clockNow: 1000,
    resolveTarget,
    fetchFn,
    ...overrides,
  };
}

function makeSummarizer(ctx: TestContext) {
  return createCapabilitySummarizer({
    resolveActiveTarget: ctx.resolveTarget,
    updateSummarized: ctx.updateSummarized,
    clock: { now: () => ctx.clockNow },
    fetch: ctx.fetchFn,
  });
}

/** 模拟 adapter HTTP 调用：返回标准 chat-completions 响应。 */
function mockOkFetch(ctx: TestContext, capabilities: string[]) {
  ctx.fetchFn.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({ capabilities }),
          // 省略 tool_calls（adapter 对 null 判非法，只接受 undefined/数组）
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: 'test-model',
    }),
  });
}

describe('createCapabilitySummarizer', () => {
  test('解析模型 JSON 输出并写回 summarized 能力', async () => {
    const ctx = makeContext();
    mockOkFetch(ctx, ['code review', 'unit test writing']);
    const summarizer = makeSummarizer(ctx);

    await summarizer.summarize({ agentId: 'agent-1', rawContent: '# My Agent\n\n可以写代码', contentHash: 'hash-1' });

    expect(ctx.updateSummarized).toHaveBeenCalledWith({
      agentId: 'agent-1',
      capabilitiesSummarized: ['code review', 'unit test writing'],
      timestamp: 1000,
    });
  });

  test('内容 hash 缓存：同 hash 1h 内不重跑模型（但缓存结果写回新 agent）', async () => {
    const ctx = makeContext();
    mockOkFetch(ctx, ['code review']);
    const summarizer = makeSummarizer(ctx);

    await summarizer.summarize({ agentId: 'agent-1', rawContent: 'content', contentHash: 'same-hash' });
    ctx.clockNow = 2000; // 仍在 TTL 内
    await summarizer.summarize({ agentId: 'agent-2', rawContent: 'content', contentHash: 'same-hash' });

    // 模型只调一次（缓存命中）；缓存结果写回第二个 agent。
    expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    expect(ctx.updateSummarized).toHaveBeenCalledTimes(2);
    expect(ctx.updateSummarized).toHaveBeenLastCalledWith({
      agentId: 'agent-2',
      capabilitiesSummarized: ['code review'],
      timestamp: 2000,
    });
  });

  test('TTL 过期后同 hash 重跑', async () => {
    const ctx = makeContext();
    mockOkFetch(ctx, ['code review']);
    const summarizer = makeSummarizer(ctx);

    await summarizer.summarize({ agentId: 'agent-1', rawContent: 'content', contentHash: 'hash' });
    ctx.clockNow = 1000 + 61 * 60 * 1000; // 超过 1h
    await summarizer.summarize({ agentId: 'agent-1', rawContent: 'content', contentHash: 'hash' });

    expect(ctx.fetchFn).toHaveBeenCalledTimes(2);
  });

  test('Active PI Model 不可用 → 跳过总结，不写回', async () => {
    const ctx = makeContext({
      resolveTarget: async () => ({ kind: 'unavailable', diagnosticCode: 'PI_ACTIVE_MODEL_NOT_SET' }),
    });
    const summarizer = makeSummarizer(ctx);

    await summarizer.summarize({ agentId: 'agent-1', rawContent: 'content', contentHash: 'hash' });

    expect(ctx.fetchFn).not.toHaveBeenCalled();
    expect(ctx.updateSummarized).not.toHaveBeenCalled();
  });

  test('模型返回非法输出 → fail-open 不写回不抛错', async () => {
    const ctx = makeContext();
    ctx.fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'length', message: { content: 'oops not json' } }],
        usage: {},
        model: 'test-model',
      }),
    });
    const summarizer = makeSummarizer(ctx);

    await expect(
      summarizer.summarize({ agentId: 'agent-1', rawContent: 'content', contentHash: 'hash' }),
    ).resolves.toBeUndefined();
    expect(ctx.updateSummarized).not.toHaveBeenCalled();
  });

  test('模型网络错误 → 静默跳过', async () => {
    const ctx = makeContext();
    ctx.fetchFn.mockRejectedValue(new Error('network down'));
    const summarizer = makeSummarizer(ctx);

    await expect(
      summarizer.summarize({ agentId: 'agent-1', rawContent: 'content', contentHash: 'hash' }),
    ).resolves.toBeUndefined();
    expect(ctx.updateSummarized).not.toHaveBeenCalled();
  });

  test('缓存命中但结果为空 → 不写回', async () => {
    const ctx = makeContext();
    mockOkFetch(ctx, []);
    const summarizer = makeSummarizer(ctx);

    await summarizer.summarize({ agentId: 'agent-1', rawContent: 'content', contentHash: 'empty-hash' });

    expect(ctx.updateSummarized).not.toHaveBeenCalled();
  });
});

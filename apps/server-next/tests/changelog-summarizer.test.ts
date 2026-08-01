import { describe, expect, test, vi } from 'vitest';
import { createChangelogSummarizer, type ChangelogSummarizerDependencies } from '../src/application/changelog-summarizer';

type ResolveTarget = ChangelogSummarizerDependencies['resolveActiveTarget'];

interface TestContext {
  resolveTarget: ReturnType<typeof vi.fn<() => Promise<{ kind: 'available'; config: { baseUrl: string; modelId: string; timeoutMs: number; maxOutputTokens: number }; apiKey: string } | { kind: 'unavailable'; diagnosticCode: string }>>>;
  fetchFn: ReturnType<typeof vi.fn>;
}

function makeContext(overrides: Partial<TestContext> = {}): TestContext {
  const fetchFn = vi.fn();
  const resolveTarget = vi.fn(async () => ({
    kind: 'available' as const,
    config: { baseUrl: 'https://api.example.com', modelId: 'test-model', timeoutMs: 10000, maxOutputTokens: 1024 },
    apiKey: 'test-key',
  }));
  return { resolveTarget, fetchFn, ...overrides };
}

function makeSummarizer(ctx: TestContext) {
  return createChangelogSummarizer({
    resolveActiveTarget: ctx.resolveTarget,
    fetch: ctx.fetchFn,
  });
}

/** 模拟 adapter HTTP 调用：返回标准 chat-completions 响应。 */
function mockOkFetch(ctx: TestContext, entries: unknown) {
  ctx.fetchFn.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify(entries),
          // 省略 tool_calls（adapter 对 null 判非法，只接受 undefined/数组）
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: 'test-model',
    }),
  });
}

const SAMPLE_PULLS = [
  { number: 101, title: 'feat: 支持频道文件预览', body: '实现频道文件目录与预览。' },
  { number: 102, title: 'refactor: 内部路由重构', body: '纯内部重构，无用户可见影响。' },
];

describe('createChangelogSummarizer', () => {
  test('解析模型 JSON 输出并按 PR 返回条目', async () => {
    const ctx = makeContext();
    mockOkFetch(ctx, { number: 101, entries: [{ type: '新功能', text: '支持频道文件预览' }] });
    const summarizer = makeSummarizer(ctx);

    const results = await summarizer.summarize([{ ...SAMPLE_PULLS[0]! }]);

    expect(results).toEqual([{ number: 101, entries: [{ type: '新功能', text: '支持频道文件预览' }] }]);
    expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
  });

  test('模型判定无用户可见影响 → 空条目', async () => {
    const ctx = makeContext();
    mockOkFetch(ctx, { number: 102, entries: [] });
    const summarizer = makeSummarizer(ctx);

    const results = await summarizer.summarize([{ ...SAMPLE_PULLS[1]! }]);

    expect(results).toEqual([{ number: 102, entries: [] }]);
  });

  test('逐 PR 调用并保持顺序', async () => {
    const ctx = makeContext();
    ctx.fetchFn
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ number: 101, entries: [{ type: '新功能', text: 'A' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'test-model' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ number: 102, entries: [{ type: '修复', text: 'B' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'test-model' }),
      });
    const summarizer = makeSummarizer(ctx);

    const results = await summarizer.summarize(SAMPLE_PULLS);

    expect(results).toEqual([
      { number: 101, entries: [{ type: '新功能', text: 'A' }] },
      { number: 102, entries: [{ type: '修复', text: 'B' }] },
    ]);
    expect(ctx.fetchFn).toHaveBeenCalledTimes(2);
  });

  test('非法输出（非 JSON）→ 空条目（fail-open）', async () => {
    const ctx = makeContext();
    ctx.fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: '这不是 JSON' } }],
        usage: {},
        model: 'test-model',
      }),
    });
    const summarizer = makeSummarizer(ctx);

    const results = await summarizer.summarize([{ ...SAMPLE_PULLS[0]! }]);

    expect(results).toEqual([{ number: 101, entries: [] }]);
  });

  test('非法分类与缺失字段被过滤', async () => {
    const ctx = makeContext();
    mockOkFetch(ctx, {
      number: 101,
      entries: [
        { type: '移除', text: '非法分类' },
        { type: '新功能', text: '' },
        { type: '改进', text: '合法条目' },
        { type: '修复', text: 42 },
      ],
    });
    const summarizer = makeSummarizer(ctx);

    const results = await summarizer.summarize([{ ...SAMPLE_PULLS[0]! }]);

    expect(results).toEqual([{ number: 101, entries: [{ type: '改进', text: '合法条目' }] }]);
  });

  test('fetch 失败 → 空条目（fail-open），不抛异常', async () => {
    const ctx = makeContext();
    ctx.fetchFn.mockRejectedValue(new Error('network down'));
    const summarizer = makeSummarizer(ctx);

    const results = await summarizer.summarize([{ ...SAMPLE_PULLS[0]! }]);

    expect(results).toEqual([{ number: 101, entries: [] }]);
  });

  test('Active PI Model 未配置 → 全部空条目，不调模型', async () => {
    const ctx = makeContext({
      resolveTarget: vi.fn(async () => ({ kind: 'unavailable' as const, diagnosticCode: 'PI_ACTIVE_MODEL_NOT_SET' })),
    });
    const summarizer = makeSummarizer(ctx);

    const results = await summarizer.summarize(SAMPLE_PULLS);

    expect(results).toEqual([
      { number: 101, entries: [] },
      { number: 102, entries: [] },
    ]);
    expect(ctx.fetchFn).not.toHaveBeenCalled();
  });
});

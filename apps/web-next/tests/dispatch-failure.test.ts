import { describe, expect, test } from 'vitest';
import {
  classifyChannelDispatchFailure,
  formatChannelDispatchFailureBody,
  formatChannelDispatchFailureHint,
  rewriteLegacyCodexFailureBody,
} from '../lib/dispatch-failure';

describe('formatChannelDispatchFailureHint', () => {
  test('turns bare timed_out into Chinese guidance', () => {
    expect(formatChannelDispatchFailureHint({ status: 'timed_out' })).toContain('超时');
  });

  test('classifies usage limit from codex JSONL detail', () => {
    const classified = classifyChannelDispatchFailure({
      status: 'failed',
      detail: '{"type":"error","message":"You\'ve hit your usage limit."}',
    });
    expect(classified.category).toBe('usage_limit');
    expect(formatChannelDispatchFailureHint({
      status: 'failed',
      detail: '{"type":"error","message":"You\'ve hit your usage limit."}',
    })).toContain('额度');
  });

  test('maps DISPATCH_TIMEOUT error code', () => {
    expect(formatChannelDispatchFailureHint({ errorCode: 'DISPATCH_TIMEOUT' })).toContain('超时');
  });
});

  test('body helper returns summary plus guidance without JSONL dumps', () => {
    const body = formatChannelDispatchFailureBody({
      status: 'failed',
      detail: '{"type":"error","message":"You\'ve hit your usage limit."}',
    });
    expect(body).toContain('额度');
    expect(body).toContain('ChatGPT');
    expect(body).not.toContain('type":"error');
  });

describe('rewriteLegacyCodexFailureBody', () => {
  test('rewrites raw codex exit JSONL bodies', () => {
    const rewritten = rewriteLegacyCodexFailureBody(
      'codex exit 1: {"type":"error","message":"Missing environment variable: CRS_OAI_KEY."}',
    );
    expect(rewritten).toContain('CRS_OAI_KEY');
    expect(rewritten).toContain('环境变量');
  });

  test('does not rewrite ordinary agent answers that merely mention usage limits', () => {
    const body = '你可以在 ChatGPT 用量页检查 usage limit，再决定要不要换模型。';
    expect(rewriteLegacyCodexFailureBody(body)).toBe(body);
  });
});


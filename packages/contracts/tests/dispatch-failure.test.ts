import { describe, expect, test } from 'vitest';
import {
  classifyDispatchFailure,
  formatDispatchFailureBody,
  formatDispatchFailureSummary,
} from '../src/dispatch-failure.js';

describe('classifyDispatchFailure', () => {
  test('classifies dispatch timeout from status/error code', () => {
    expect(classifyDispatchFailure({ status: 'timed_out' })).toMatchObject({
      category: 'dispatch_timeout',
      summary: expect.stringContaining('超时'),
    });
    expect(formatDispatchFailureSummary({ errorCode: 'DISPATCH_TIMEOUT' })).toContain('超时');
  });

  test('prefers the last codex JSONL error over earlier noise', () => {
    const detail = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"error","message":"Reconnecting... 5/5 (request timed out)"}',
      '{"type":"error","message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"}',
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"}}',
    ].join('\n');
    const classified = classifyDispatchFailure({ status: 'failed', detail });
    expect(classified.category).toBe('usage_limit');
    expect(classified.summary).toContain('额度');
    expect(formatDispatchFailureBody({ detail })).toContain('ChatGPT');
    expect(formatDispatchFailureBody({ detail })).not.toContain('thread.started');
  });

  test('classifies missing env, node path, and auth failures', () => {
    expect(classifyDispatchFailure({
      detail: '{"type":"error","message":"Missing environment variable: CRS_OAI_KEY."}',
    }).category).toBe('missing_env');
    expect(classifyDispatchFailure({
      detail: 'env: node: No such file or directory',
      errorCode: 'WORKSPACE_RUN_FAILED',
    }).category).toBe('node_not_found');
    expect(classifyDispatchFailure({
      detail: 'Failed to refresh token: 401 Unauthorized',
    }).category).toBe('auth_expired');
  });

  test('maps workspace-run codes without dumping raw detail', () => {
    expect(classifyDispatchFailure({ errorCode: 'WORKSPACE_RUN_FAILED' }).summary).toContain('执行失败');
    expect(classifyDispatchFailure({ errorCode: 'WORKSPACE_RUN_CANCELLED' }).category).toBe('workspace_run_cancelled');
  });
});

  test('does not treat bare authentication text as auth_expired', () => {
    expect(classifyDispatchFailure({
      detail: 'Failed authentication with provider configuration docs',
    }).category).toBe('unknown');
    expect(classifyDispatchFailure({
      detail: 'Failed to refresh token: 401 Unauthorized',
    }).category).toBe('auth_expired');
  });


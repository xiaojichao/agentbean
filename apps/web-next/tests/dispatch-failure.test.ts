import { describe, expect, test } from 'vitest';
import {
  classifyChannelDispatchFailure,
  formatChannelDispatchFailureHint,
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

import { describe, expect, test } from 'vitest';
import {
  buildFailedDispatchHintInput,
  classifyChannelDispatchFailure,
  formatChannelDispatchFailureHint,
} from '../lib/dispatch-failure';

describe('formatChannelDispatchFailureHint', () => {
  test('turns bare timed_out into Chinese guidance', () => {
    expect(formatChannelDispatchFailureHint({ status: 'timed_out' })).toContain('超时');
  });

  test('timed_out + DAEMON_OFFLINE/UNRESPONSIVE 显示设备失联（而非模糊超时）', () => {
    expect(formatChannelDispatchFailureHint({ status: 'timed_out', errorCode: 'DAEMON_OFFLINE' })).toContain('离线');
    expect(formatChannelDispatchFailureHint({ status: 'timed_out', errorCode: 'DAEMON_UNRESPONSIVE' })).toContain('无响应');
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

  test('execution limit is a stop, not 兜底「Agent 处理失败」', () => {
    expect(formatChannelDispatchFailureHint({
      status: 'timed_out',
      errorCode: 'EXECUTION_LIMIT',
    })).toBe('已达执行上限，系统已停止等待');
  });
});

describe('buildFailedDispatchHintInput (production pipe mapping, H2)', () => {
  test('REGRESSION: diagnosable reason in dispatchError must reach the classifier as detail, not be swallowed', () => {
    // server 因 agent 缺环境变量失败 → error_message 经 socket → msg.dispatchError
    const input = buildFailedDispatchHintInput({ dispatchError: 'Missing environment variable: CODEX_API_KEY' });
    const hint = formatChannelDispatchFailureHint(input);
    expect(hint).toContain('环境变量');
    expect(hint).not.toBe('Agent 处理失败');
  });

  test('diagnosable usage-limit reason surfaces instead of 兜底「Agent 处理失败」', () => {
    const input = buildFailedDispatchHintInput({ dispatchError: "You've hit your usage limit." });
    expect(formatChannelDispatchFailureHint(input)).toContain('额度');
  });

  test('errorCode-style dispatchError still hits the errorCode branch (no false positive from routing it to detail)', () => {
    const input = buildFailedDispatchHintInput({ dispatchError: 'WORKSPACE_RUN_FAILED' });
    expect(formatChannelDispatchFailureHint(input)).toBe('Agent 执行失败');
  });

  test('explicit metaDispatchErrorDetail takes priority over dispatchError fallback', () => {
    const input = buildFailedDispatchHintInput({
      dispatchError: 'WORKSPACE_RUN_FAILED',
      metaDispatchErrorDetail: 'env: node: No such file or directory',
    });
    expect(formatChannelDispatchFailureHint(input)).toContain('Node');
  });
});

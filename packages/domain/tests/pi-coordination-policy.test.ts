import { describe, expect, test } from 'vitest';

import {
  COORDINATION_DIAGNOSTIC,
  DEFAULT_COORDINATION_BASE_DELAY_MS,
  DEFAULT_MAX_COORDINATION_ATTEMPTS,
  evaluateCoordinationGate,
  assessCoordinationRisk,
  isTransientCoordinationError,
  parseCoordinationResponse,
  planCoordinationRetry,
  sanitizeCoordinationReasonCode,
  sanitizeCoordinationReplyText,
} from '../src/pi-coordination-policy.js';

const ok = (textContents: string[], finishReason = 'stop') => ({
  finishReason,
  textContents,
});

describe('parseCoordinationResponse', () => {
  test('resolves no_action without requiring text', () => {
    expect(parseCoordinationResponse(ok([JSON.stringify({ intent: 'no_action', reasonCode: 'greeting' })]))).toEqual({
      kind: 'resolved',
      intent: 'no_action',
      reasonCode: 'greeting',
      text: null,
      risk: null,
      objective: null,
      targetAgentName: null,
    });
  });

  test('resolves system_reply with required text', () => {
    const result = parseCoordinationResponse(
      ok([JSON.stringify({ intent: 'system_reply', reasonCode: 'status_ok', text: 'PI 已就绪' })]),
    );
    expect(result).toMatchObject({ kind: 'resolved', intent: 'system_reply', reasonCode: 'status_ok', text: 'PI 已就绪' });
  });

  test('resolves clarification_required with required text', () => {
    expect(
      parseCoordinationResponse(
        ok([JSON.stringify({ intent: 'clarification_required', reasonCode: 'target_unclear', text: '请指定哪个 Agent？' })]),
      ).kind,
    ).toBe('resolved');
  });

  test('fail-closes on an unknown intent', () => {
    expect(parseCoordinationResponse(ok([JSON.stringify({ intent: 'tracked_task', text: 'x' })]))).toEqual({
      kind: 'invalid',
      code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT,
    });
  });

  test('fail-closed when reply/clarification text is missing', () => {
    expect(parseCoordinationResponse(ok([JSON.stringify({ intent: 'system_reply' })]))).toEqual({
      kind: 'invalid',
      code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT,
    });
  });

  test('fail-closed on non-JSON (MODEL_INVALID_JSON)', () => {
    expect(parseCoordinationResponse(ok(['请理解这条消息']))).toEqual({
      kind: 'invalid',
      code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_JSON,
    });
  });

  test('fail-closed when finishReason is not stop', () => {
    expect(
      parseCoordinationResponse(ok([JSON.stringify({ intent: 'no_action' })], 'tool_use')),
    ).toEqual({ kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT });
  });

  test('fail-closed when there is not exactly one text content', () => {
    expect(parseCoordinationResponse(ok([]))).toEqual({
      kind: 'invalid',
      code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT,
    });
    expect(parseCoordinationResponse(ok(['a', 'b']))).toEqual({
      kind: 'invalid',
      code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT,
    });
  });

  test('tolerates a single ```json fence but still fail-closes on prose', () => {
    const fenced = '```json\n{"intent":"no_action","reasonCode":"ok"}\n```';
    expect(parseCoordinationResponse(ok([fenced])).kind).toBe('resolved');
  });

  test('nullifies a disallowed reasonCode but still resolves on valid intent', () => {
    // reasonCode 非本质字段：模型给怪异理由码只 sanitize 成 null，不影响意图分类。
    const result = parseCoordinationResponse(
      ok([JSON.stringify({ intent: 'no_action', reasonCode: 'hello world; drop table' })]),
    );
    expect(result).toMatchObject({ kind: 'resolved', intent: 'no_action', reasonCode: null, text: null });
  });
});

describe('sanitize helpers', () => {
  test('reasonCode collapses whitespace and clamps length', () => {
    expect(sanitizeCoordinationReasonCode('  hello world  ')).toBe('hello_world');
    expect(sanitizeCoordinationReasonCode('x'.repeat(100))).toHaveLength(64);
    expect(sanitizeCoordinationReasonCode('')).toBeNull();
    expect(sanitizeCoordinationReasonCode(null)).toBeNull();
  });

  test('replyText strips control characters and clamps length', () => {
    expect(sanitizeCoordinationReplyText('a\x00b\x07c')).toBe('abc');
    expect(sanitizeCoordinationReplyText('   ')).toBeNull();
    expect(sanitizeCoordinationReplyText('x'.repeat(5000))).toHaveLength(2000);
  });
});

describe('planCoordinationRetry', () => {
  test('fails immediately on permanent auth error without retry', () => {
    expect(planCoordinationRetry({ attempt: 1, errorKind: 'auth', maxAttempts: 3, baseDelayMs: 1000, now: 10 })).toEqual({
      kind: 'fail',
      diagnosticCode: COORDINATION_DIAGNOSTIC.MODEL_AUTH_ERROR,
    });
  });

  test('retries transient timeout with exponential backoff', () => {
    expect(planCoordinationRetry({ attempt: 1, errorKind: 'timeout', maxAttempts: 3, baseDelayMs: 1000, now: 10 })).toEqual({
      kind: 'retry',
      nextAttempt: 2,
      nextRetryAt: 10 + 1000,
    });
    expect(planCoordinationRetry({ attempt: 2, errorKind: 'timeout', maxAttempts: 3, baseDelayMs: 1000, now: 10 })).toEqual({
      kind: 'retry',
      nextAttempt: 3,
      nextRetryAt: 10 + 2000,
    });
  });

  test('fails when transient retries are exhausted', () => {
    expect(planCoordinationRetry({ attempt: 3, errorKind: 'rate_limit', maxAttempts: 3, baseDelayMs: 1000, now: 10 })).toEqual({
      kind: 'fail',
      diagnosticCode: COORDINATION_DIAGNOSTIC.MODEL_RATE_LIMIT,
    });
  });

  test('unknown and aborted are treated as non-retryable', () => {
    expect(isTransientCoordinationError('unknown')).toBe(false);
    expect(isTransientCoordinationError('aborted')).toBe(false);
    expect(isTransientCoordinationError('invalid_json')).toBe(true);
  });

  test('defaults are sensible', () => {
    expect(DEFAULT_MAX_COORDINATION_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_COORDINATION_BASE_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('parseCoordinationResponse: side-effecting intents (#707)', () => {
  test('tracked_task resolves with required risk + objective', () => {
    const result = parseCoordinationResponse(
      ok([JSON.stringify({ intent: 'tracked_task', reasonCode: 'needs_tracking', risk: 'low', objective: '交付周报' })]),
    );
    expect(result).toMatchObject({
      kind: 'resolved', intent: 'tracked_task', risk: 'low', objective: '交付周报',
    });
  });

  test('agent_request resolves with optional targetAgentName', () => {
    const result = parseCoordinationResponse(
      ok([JSON.stringify({ intent: 'agent_request', reasonCode: 'code', risk: 'low', objective: '重构 X', targetAgentName: 'Codex' })]),
    );
    expect(result).toMatchObject({ kind: 'resolved', intent: 'agent_request', targetAgentName: 'Codex' });
  });

  test('side-effecting intent without risk → invalid', () => {
    expect(parseCoordinationResponse(ok([JSON.stringify({ intent: 'tracked_task', objective: 'x' })]))).toEqual({
      kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT,
    });
  });

  test('side-effecting intent without objective → invalid', () => {
    expect(parseCoordinationResponse(ok([JSON.stringify({ intent: 'tracked_task', risk: 'low' })]))).toEqual({
      kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT,
    });
  });

  test('invalid risk value → invalid', () => {
    expect(parseCoordinationResponse(ok([JSON.stringify({ intent: 'tracked_task', risk: 'medium', objective: 'x' })]))).toEqual({
      kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT,
    });
  });
});

describe('evaluateCoordinationGate (#707)', () => {
  const conv = (intent: any) => evaluateCoordinationGate({
    intent, risk: null, explicitTarget: false, autoCoordinationEnabled: false, channelArchived: false,
  });

  test('conversational intents are always applied regardless of toggle', () => {
    expect(conv('no_action').status).toBe('applied');
    expect(conv('system_reply').status).toBe('applied');
    expect(conv('clarification_required').status).toBe('applied');
  });

  test('side-effecting low-risk with auto ON → applied', () => {
    expect(evaluateCoordinationGate({
      intent: 'tracked_task', risk: 'low', explicitTarget: false, autoCoordinationEnabled: true, channelArchived: false,
    }).status).toBe('applied');
  });

  test('side-effecting low-risk with auto OFF and no explicit target → suggested (AC#5)', () => {
    const v = evaluateCoordinationGate({
      intent: 'tracked_task', risk: 'low', explicitTarget: false, autoCoordinationEnabled: false, channelArchived: false,
    });
    expect(v.status).toBe('suggested');
  });

  test('explicit target (@Agent/asTask) is not silenced by toggle OFF → applied (AC#6)', () => {
    expect(evaluateCoordinationGate({
      intent: 'agent_request', risk: 'low', explicitTarget: true, autoCoordinationEnabled: false, channelArchived: false,
    }).status).toBe('applied');
  });

  test('high risk is always blocked regardless of toggle or explicit target (AC#7)', () => {
    for (const auto of [true, false]) {
      for (const explicit of [true, false]) {
        expect(evaluateCoordinationGate({
          intent: 'tracked_task', risk: 'high', explicitTarget: explicit, autoCoordinationEnabled: auto, channelArchived: false,
        }).status).toBe('blocked');
      }
    }
  });

  test('archived channel blocks side-effecting intents', () => {
    expect(evaluateCoordinationGate({
      intent: 'tracked_task', risk: 'low', explicitTarget: false, autoCoordinationEnabled: true, channelArchived: true,
    }).status).toBe('blocked');
  });

  test('archived channel also blocks conversational replies', () => {
    expect(evaluateCoordinationGate({
      intent: 'system_reply', risk: null, explicitTarget: false,
      autoCoordinationEnabled: true, channelArchived: true,
    })).toMatchObject({ status: 'blocked', reason: 'CHANNEL_ARCHIVED' });
  });

  test('server risk assessment elevates destructive and sensitive objectives', () => {
    expect(assessCoordinationRisk({ modelRisk: 'low', objective: '删除生产数据库' })).toBe('high');
    expect(assessCoordinationRisk({ modelRisk: 'low', objective: 'export API key to a public file' })).toBe('high');
    expect(assessCoordinationRisk({ modelRisk: 'low', objective: '交付周报' })).toBe('low');
  });

  test('verdict reasons are auditable short codes', () => {
    expect(evaluateCoordinationGate({
      intent: 'tracked_task', risk: 'high', explicitTarget: false, autoCoordinationEnabled: true, channelArchived: false,
    }).reason).toBe('HIGH_RISK_REQUIRES_CONFIRMATION');
  });
});

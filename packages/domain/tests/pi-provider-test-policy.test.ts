import { describe, expect, test } from 'vitest';

import {
  computePiProviderConfigSummary,
  evaluatePiProviderPublish,
} from '../src/pi-provider-test-policy.js';

const base = {
  protocol: 'openai_chat_completions',
  baseUrl: 'https://api.openai.com/v1/',
  endpointMode: 'chat_completions',
  modelId: 'gpt-4.1-mini',
  timeoutMs: 60_000,
  maxOutputTokens: 4096,
  compatibilityParams: {},
  credentialFingerprint: 'abcd1234efgh',
};

describe('computePiProviderConfigSummary', () => {
  test('is stable under trailing slash normalization', () => {
    const a = computePiProviderConfigSummary(base);
    const b = computePiProviderConfigSummary({
      ...base,
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test('changes when modelId or credential fingerprint changes', () => {
    const a = computePiProviderConfigSummary(base);
    expect(computePiProviderConfigSummary({ ...base, modelId: 'other' })).not.toBe(a);
    expect(computePiProviderConfigSummary({
      ...base,
      credentialFingerprint: 'otherfingerprint',
    })).not.toBe(a);
  });
});

describe('evaluatePiProviderPublish', () => {
  test('allows only matching passed test for current draft summary', () => {
    const summary = computePiProviderConfigSummary(base);
    expect(evaluatePiProviderPublish({
      hasDraftRevision: true,
      draftConfigSummary: summary,
      latestTest: { status: 'passed', configSummary: summary },
    })).toEqual({ allowed: true });

    expect(evaluatePiProviderPublish({
      hasDraftRevision: false,
      draftConfigSummary: summary,
      latestTest: { status: 'passed', configSummary: summary },
    })).toEqual({ allowed: false, reason: 'NO_DRAFT' });

    expect(evaluatePiProviderPublish({
      hasDraftRevision: true,
      draftConfigSummary: summary,
      latestTest: null,
    })).toEqual({ allowed: false, reason: 'NO_PASSING_TEST' });

    expect(evaluatePiProviderPublish({
      hasDraftRevision: true,
      draftConfigSummary: summary,
      latestTest: { status: 'failed', configSummary: summary },
    })).toEqual({ allowed: false, reason: 'TEST_NOT_PASSED' });

    expect(evaluatePiProviderPublish({
      hasDraftRevision: true,
      draftConfigSummary: summary,
      latestTest: { status: 'passed', configSummary: 'stale-summary' },
    })).toEqual({ allowed: false, reason: 'CONFIG_SUMMARY_MISMATCH' });
  });
});

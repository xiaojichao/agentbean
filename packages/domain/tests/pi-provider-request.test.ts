import { describe, expect, test } from 'vitest';

import {
  parseCopyPiProviderCardRequest,
  parseCreatePiProviderCardRequest,
  parseUpdatePiProviderCardRequest,
} from '../src/pi-provider-request.js';

const validCreate = {
  userId: 'admin-1',
  preset: 'openai',
  displayName: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  endpointMode: 'chat_completions',
  modelId: 'gpt-4.1-mini',
  timeoutMs: 60_000,
  maxOutputTokens: 4096,
  apiKey: 'sk-test',
};

describe('parseCreatePiProviderCardRequest', () => {
  test('accepts exact-key payloads and socket enriched fields', () => {
    const result = parseCreatePiProviderCardRequest({
      ...validCreate,
      teamId: 'team-session',
      currentDeviceId: 'device-1',
      notes: null,
      consoleUrl: 'https://platform.openai.com',
      compatibilityParams: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe('admin-1');
      expect(result.value.config.modelId).toBe('gpt-4.1-mini');
    }
  });

  test.each([
    'headers',
    'body',
    'oauth',
    'shell',
    'env',
    'temperature',
    'unknown',
  ])('rejects top-level unsupported field %s even with otherwise valid fields', (field) => {
    const result = parseCreatePiProviderCardRequest({
      ...validCreate,
      [field]: field === 'headers' ? { Authorization: 'Bearer x' } : true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([
        'PI_PROVIDER_REQUEST_UNKNOWN_FIELD',
        'PI_PROVIDER_REQUEST_SENSITIVE_FIELD',
      ]).toContain(result.code);
    }
  });

  test('rejects advancedConfig bypass of headers/oauth/shell/env', () => {
    for (const advancedConfig of [
      { headers: { Authorization: 'Bearer x' } },
      { oauth: { clientId: 'x' } },
      { shell: 'curl' },
      { env: { KEY: 'v' } },
      { apiKey: 'sk-bypass' },
    ]) {
      const result = parseCreatePiProviderCardRequest({
        ...validCreate,
        advancedConfig,
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('parseUpdatePiProviderCardRequest', () => {
  test('rejects unknown top-level keys on update', () => {
    const result = parseUpdatePiProviderCardRequest({
      userId: 'admin-1',
      cardId: 'card-1',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt-4.1-mini',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      headers: { 'x-api-key': 'x' },
    });
    expect(result).toMatchObject({ ok: false, code: 'PI_PROVIDER_REQUEST_SENSITIVE_FIELD' });
  });
});

describe('parseCopyPiProviderCardRequest', () => {
  test('rejects unknown keys on copy', () => {
    const result = parseCopyPiProviderCardRequest({
      userId: 'admin-1',
      sourceCardId: 'card-1',
      oauth: true,
    });
    expect(result.ok).toBe(false);
  });
});

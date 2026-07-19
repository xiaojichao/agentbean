import { describe, expect, test } from 'vitest';

import {
  getPiProviderPreset,
  isPiProviderPreset,
  listPiProviderPresets,
  normalizePiProviderConfig,
  validatePiProviderApiKey,
  validatePiProviderConsoleUrl,
  validatePiProviderDisplayName,
} from '../src/pi-provider-policy.js';

describe('PI Provider presets', () => {
  test('exposes exactly four MVP presets with OpenAI-compatible defaults', () => {
    const presets = listPiProviderPresets();
    expect(presets.map((item) => item.preset)).toEqual([
      'openai',
      'openrouter',
      'deepseek',
      'custom_openai_compatible',
    ]);
    for (const preset of presets) {
      expect(preset.protocol).toBe('openai_chat_completions');
      expect(preset.defaultEndpointMode).toBe('chat_completions');
    }
    expect(getPiProviderPreset('openai')?.defaultBaseUrl).toBe('https://api.openai.com/v1');
    expect(isPiProviderPreset('anthropic')).toBe(false);
  });
});

describe('normalizePiProviderConfig', () => {
  test('accepts a valid form configuration', () => {
    const result = normalizePiProviderConfig({
      baseUrl: 'https://api.openai.com/v1/',
      modelId: 'gpt-4.1-mini',
      timeoutMs: 30_000,
      maxOutputTokens: 2048,
      compatibilityParams: {},
    });
    expect(result).toEqual({
      ok: true,
      config: {
        protocol: 'openai_chat_completions',
        baseUrl: 'https://api.openai.com/v1',
        endpointMode: 'chat_completions',
        modelId: 'gpt-4.1-mini',
        timeoutMs: 30_000,
        maxOutputTokens: 2048,
        compatibilityParams: {},
      },
    });
  });

  test('accepts advanced JSON that edits the same typed configuration', () => {
    const result = normalizePiProviderConfig({
      baseUrl: 'https://example.invalid',
      modelId: 'old',
      advancedConfig: {
        baseUrl: 'https://openrouter.ai/api/v1',
        endpointMode: 'chat_completions',
        modelId: 'openrouter/auto',
        timeoutMs: 45_000,
        maxOutputTokens: 1024,
        compatibilityParams: {},
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(result.config.modelId).toBe('openrouter/auto');
      expect(result.config.timeoutMs).toBe(45_000);
    }
  });

  test.each([
    ['headers', { headers: { Authorization: 'Bearer x' } }],
    ['body', { body: { stream: true } }],
    ['oauth', { oauth: { clientId: 'x' } }],
    ['shell', { shell: 'curl ...' }],
    ['env', { env: { OPENAI_API_KEY: 'x' } }],
    ['apiKey', { apiKey: 'sk-secret' }],
    ['unknown', { temperature: 0.2 }],
  ])('rejects unsupported advanced field %s', (_name, advancedConfig) => {
    const result = normalizePiProviderConfig({
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4.1-mini',
      advancedConfig,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([
        'PI_PROVIDER_UNSUPPORTED_FIELD',
        'PI_PROVIDER_UNSUPPORTED_AUTH',
        'PI_PROVIDER_ENV_INTERPOLATION',
      ]).toContain(result.code);
    }
  });

  test('rejects environment variable interpolation', () => {
    const result = normalizePiProviderConfig({
      baseUrl: 'https://api.openai.com/v1/${REGION}',
      modelId: 'gpt-4.1-mini',
    });
    expect(result).toMatchObject({ ok: false, code: 'PI_PROVIDER_ENV_INTERPOLATION' });
  });

  test('rejects unknown compatibility parameters', () => {
    const result = normalizePiProviderConfig({
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4.1-mini',
      compatibilityParams: { stream: true } as never,
    });
    expect(result).toMatchObject({ ok: false, code: 'PI_PROVIDER_INVALID_COMPATIBILITY_PARAMS' });
  });
});

describe('metadata validators', () => {
  test('requires displayName and validates console URL', () => {
    expect(validatePiProviderDisplayName('  My Card  ')).toEqual({ ok: true, value: 'My Card' });
    expect(validatePiProviderDisplayName('')).toMatchObject({ ok: false });
    expect(validatePiProviderConsoleUrl('https://platform.openai.com')).toEqual({
      ok: true,
      value: 'https://platform.openai.com',
    });
    expect(validatePiProviderConsoleUrl('not-a-url')).toMatchObject({ ok: false });
  });

  test('requires apiKey on create and allows omit on update', () => {
    expect(validatePiProviderApiKey('sk-test', { required: true })).toEqual({ ok: true, value: 'sk-test' });
    expect(validatePiProviderApiKey('', { required: true })).toMatchObject({ ok: false });
    expect(validatePiProviderApiKey(undefined, { required: false })).toEqual({ ok: true, value: null });
    expect(validatePiProviderApiKey('${OPENAI_API_KEY}', { required: true })).toMatchObject({
      ok: false,
      code: 'PI_PROVIDER_ENV_INTERPOLATION',
    });
  });
});


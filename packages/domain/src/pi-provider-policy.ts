/**
 * PI Provider Card 配置策略：Preset 默认值、高级 JSON Schema 限制、
 * 以及编辑已发布 Card 时产生新 Draft 的纯规则。
 */

export type PiProviderPreset =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'custom_openai_compatible';

export type PiProviderProtocol = 'openai_chat_completions';
export type PiProviderEndpointMode = 'chat_completions';

export interface PiProviderCompatibilityParams {
  // MVP allowlist is empty: only `{}` is valid.
}

export interface PiProviderConfig {
  readonly protocol: PiProviderProtocol;
  readonly baseUrl: string;
  readonly endpointMode: PiProviderEndpointMode;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly compatibilityParams: PiProviderCompatibilityParams;
}

export interface PiProviderPresetDescriptor {
  readonly preset: PiProviderPreset;
  readonly displayName: string;
  readonly defaultBaseUrl: string;
  readonly defaultEndpointMode: PiProviderEndpointMode;
  readonly defaultConsoleUrl: string | null;
  readonly protocol: PiProviderProtocol;
  readonly defaultTimeoutMs: number;
  readonly defaultMaxOutputTokens: number;
}

export type PiProviderConfigValidationErrorCode =
  | 'PI_PROVIDER_INVALID_PRESET'
  | 'PI_PROVIDER_INVALID_BASE_URL'
  | 'PI_PROVIDER_INVALID_ENDPOINT_MODE'
  | 'PI_PROVIDER_INVALID_MODEL_ID'
  | 'PI_PROVIDER_INVALID_TIMEOUT'
  | 'PI_PROVIDER_INVALID_MAX_OUTPUT_TOKENS'
  | 'PI_PROVIDER_INVALID_DISPLAY_NAME'
  | 'PI_PROVIDER_INVALID_NOTES'
  | 'PI_PROVIDER_INVALID_CONSOLE_URL'
  | 'PI_PROVIDER_INVALID_API_KEY'
  | 'PI_PROVIDER_UNSUPPORTED_FIELD'
  | 'PI_PROVIDER_UNSUPPORTED_AUTH'
  | 'PI_PROVIDER_ENV_INTERPOLATION'
  | 'PI_PROVIDER_INVALID_COMPATIBILITY_PARAMS'
  | 'PI_PROVIDER_INVALID_ADVANCED_JSON';

export type PiProviderConfigValidationResult =
  | { readonly ok: true; readonly config: PiProviderConfig }
  | { readonly ok: false; readonly code: PiProviderConfigValidationErrorCode; readonly message: string };

const PRESETS: readonly PiProviderPresetDescriptor[] = [
  {
    preset: 'openai',
    displayName: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultEndpointMode: 'chat_completions',
    defaultConsoleUrl: 'https://platform.openai.com',
    protocol: 'openai_chat_completions',
    defaultTimeoutMs: 60_000,
    defaultMaxOutputTokens: 4096,
  },
  {
    preset: 'openrouter',
    displayName: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultEndpointMode: 'chat_completions',
    defaultConsoleUrl: 'https://openrouter.ai',
    protocol: 'openai_chat_completions',
    defaultTimeoutMs: 60_000,
    defaultMaxOutputTokens: 4096,
  },
  {
    preset: 'deepseek',
    displayName: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultEndpointMode: 'chat_completions',
    defaultConsoleUrl: 'https://platform.deepseek.com',
    protocol: 'openai_chat_completions',
    defaultTimeoutMs: 60_000,
    defaultMaxOutputTokens: 4096,
  },
  {
    preset: 'custom_openai_compatible',
    displayName: 'Custom OpenAI-compatible',
    defaultBaseUrl: '',
    defaultEndpointMode: 'chat_completions',
    defaultConsoleUrl: null,
    protocol: 'openai_chat_completions',
    defaultTimeoutMs: 60_000,
    defaultMaxOutputTokens: 4096,
  },
] as const;

const PRESET_SET = new Set<string>(PRESETS.map((p) => p.preset));

/** 高级 JSON 允许的顶层键（与表单共享）。 */
const ALLOWED_CONFIG_KEYS = new Set([
  'protocol',
  'baseUrl',
  'endpointMode',
  'modelId',
  'timeoutMs',
  'timeout',
  'maxOutputTokens',
  'compatibilityParams',
]);

/** 明确拒绝的敏感/未支持字段（即使嵌套也拒绝）。 */
const FORBIDDEN_FIELD_NAMES = new Set([
  'apiKey',
  'api_key',
  'authorization',
  'headers',
  'header',
  'body',
  'requestBody',
  'rawBody',
  'oauth',
  'oauthToken',
  'shell',
  'command',
  'env',
  'environment',
  'credential',
  'credentials',
  'secret',
  'token',
  'bearer',
  'password',
]);

const ENV_INTERPOLATION = /\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|%\w+%/;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_MAX_OUTPUT_TOKENS = 1;
const MAX_MAX_OUTPUT_TOKENS = 1_000_000;

export function listPiProviderPresets(): readonly PiProviderPresetDescriptor[] {
  return PRESETS;
}

export function getPiProviderPreset(preset: string): PiProviderPresetDescriptor | null {
  return PRESETS.find((item) => item.preset === preset) ?? null;
}

export function isPiProviderPreset(value: unknown): value is PiProviderPreset {
  return typeof value === 'string' && PRESET_SET.has(value);
}

export interface NormalizePiProviderConfigInput {
  readonly baseUrl: unknown;
  readonly endpointMode?: unknown;
  readonly modelId: unknown;
  readonly timeoutMs?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly compatibilityParams?: unknown;
  readonly protocol?: unknown;
  /** 当提供 advancedConfig 时，与表单字段合并（advanced 覆盖同名字段）。 */
  readonly advancedConfig?: unknown;
}

/**
 * 规范化并校验类型化配置。表单与高级 JSON 编辑同一份配置；
 * 任意未支持字段、OAuth/Shell/env 插值、Header/Body 均 fail closed。
 */
export function normalizePiProviderConfig(
  input: NormalizePiProviderConfigInput,
): PiProviderConfigValidationResult {
  if (input.advancedConfig !== undefined) {
    const advanced = parseAdvancedConfig(input.advancedConfig);
    if (!advanced.ok) return advanced;
    return normalizePiProviderConfig({
      protocol: advanced.value.protocol ?? input.protocol,
      baseUrl: advanced.value.baseUrl ?? input.baseUrl,
      endpointMode: advanced.value.endpointMode ?? input.endpointMode,
      modelId: advanced.value.modelId ?? input.modelId,
      timeoutMs: advanced.value.timeoutMs ?? input.timeoutMs,
      maxOutputTokens: advanced.value.maxOutputTokens ?? input.maxOutputTokens,
      compatibilityParams: advanced.value.compatibilityParams ?? input.compatibilityParams,
    });
  }

  const protocol = input.protocol === undefined || input.protocol === null
    ? 'openai_chat_completions'
    : input.protocol;
  if (protocol !== 'openai_chat_completions') {
    return fail('PI_PROVIDER_UNSUPPORTED_FIELD', 'Only openai_chat_completions protocol is supported');
  }

  if (typeof input.baseUrl !== 'string' || !input.baseUrl.trim()) {
    return fail('PI_PROVIDER_INVALID_BASE_URL', 'baseUrl is required');
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  if (!isHttpUrl(baseUrl)) {
    return fail('PI_PROVIDER_INVALID_BASE_URL', 'baseUrl must be an http(s) URL');
  }
  if (containsEnvInterpolation(baseUrl)) {
    return fail('PI_PROVIDER_ENV_INTERPOLATION', 'Environment variable interpolation is not supported');
  }

  const endpointMode = input.endpointMode === undefined || input.endpointMode === null
    ? 'chat_completions'
    : input.endpointMode;
  if (endpointMode !== 'chat_completions') {
    return fail('PI_PROVIDER_INVALID_ENDPOINT_MODE', 'Only chat_completions endpoint mode is supported');
  }

  if (typeof input.modelId !== 'string' || !input.modelId.trim()) {
    return fail('PI_PROVIDER_INVALID_MODEL_ID', 'modelId is required');
  }
  const modelId = input.modelId.trim();
  if (containsEnvInterpolation(modelId)) {
    return fail('PI_PROVIDER_ENV_INTERPOLATION', 'Environment variable interpolation is not supported');
  }

  const timeoutMs = normalizePositiveInt(input.timeoutMs, 60_000);
  if (timeoutMs === null || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return fail('PI_PROVIDER_INVALID_TIMEOUT', `timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }

  const maxOutputTokens = normalizePositiveInt(input.maxOutputTokens, 4096);
  if (
    maxOutputTokens === null
    || maxOutputTokens < MIN_MAX_OUTPUT_TOKENS
    || maxOutputTokens > MAX_MAX_OUTPUT_TOKENS
  ) {
    return fail(
      'PI_PROVIDER_INVALID_MAX_OUTPUT_TOKENS',
      `maxOutputTokens must be between ${MIN_MAX_OUTPUT_TOKENS} and ${MAX_MAX_OUTPUT_TOKENS}`,
    );
  }

  const compatibilityParams = normalizeCompatibilityParams(input.compatibilityParams);
  if (!compatibilityParams.ok) return compatibilityParams;

  return {
    ok: true,
    config: {
      protocol: 'openai_chat_completions',
      baseUrl,
      endpointMode: 'chat_completions',
      modelId,
      timeoutMs,
      maxOutputTokens,
      compatibilityParams: compatibilityParams.value,
    },
  };
}

export function validatePiProviderDisplayName(value: unknown): { ok: true; value: string } | { ok: false; code: PiProviderConfigValidationErrorCode; message: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return fail('PI_PROVIDER_INVALID_DISPLAY_NAME', 'displayName is required');
  }
  const displayName = value.trim();
  if (displayName.length > 120) {
    return fail('PI_PROVIDER_INVALID_DISPLAY_NAME', 'displayName is too long');
  }
  if (containsEnvInterpolation(displayName)) {
    return fail('PI_PROVIDER_ENV_INTERPOLATION', 'Environment variable interpolation is not supported');
  }
  return { ok: true, value: displayName };
}

export function validatePiProviderNotes(value: unknown): { ok: true; value: string | null } | { ok: false; code: PiProviderConfigValidationErrorCode; message: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') {
    return fail('PI_PROVIDER_INVALID_NOTES', 'notes must be a string');
  }
  if (value.length > 4_000) {
    return fail('PI_PROVIDER_INVALID_NOTES', 'notes is too long');
  }
  if (containsEnvInterpolation(value)) {
    return fail('PI_PROVIDER_ENV_INTERPOLATION', 'Environment variable interpolation is not supported');
  }
  return { ok: true, value };
}

export function validatePiProviderConsoleUrl(value: unknown): { ok: true; value: string | null } | { ok: false; code: PiProviderConfigValidationErrorCode; message: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') {
    return fail('PI_PROVIDER_INVALID_CONSOLE_URL', 'consoleUrl must be a string');
  }
  const consoleUrl = value.trim();
  if (!isHttpUrl(consoleUrl)) {
    return fail('PI_PROVIDER_INVALID_CONSOLE_URL', 'consoleUrl must be an http(s) URL');
  }
  if (containsEnvInterpolation(consoleUrl)) {
    return fail('PI_PROVIDER_ENV_INTERPOLATION', 'Environment variable interpolation is not supported');
  }
  return { ok: true, value: consoleUrl };
}

export function validatePiProviderApiKey(value: unknown, options: { required: boolean }): { ok: true; value: string | null } | { ok: false; code: PiProviderConfigValidationErrorCode; message: string } {
  if (value === undefined || value === null || value === '') {
    if (options.required) {
      return fail('PI_PROVIDER_INVALID_API_KEY', 'apiKey is required');
    }
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return fail('PI_PROVIDER_INVALID_API_KEY', 'apiKey must be a string');
  }
  const apiKey = value.trim();
  if (!apiKey) {
    if (options.required) {
      return fail('PI_PROVIDER_INVALID_API_KEY', 'apiKey is required');
    }
    return { ok: true, value: null };
  }
  if (apiKey.length > 8_192) {
    return fail('PI_PROVIDER_INVALID_API_KEY', 'apiKey is too long');
  }
  if (containsEnvInterpolation(apiKey)) {
    return fail('PI_PROVIDER_ENV_INTERPOLATION', 'Environment variable interpolation is not supported');
  }
  return { ok: true, value: apiKey };
}

/**
 * 编辑已发布 Card 时：永远产生新 Draft revision，不修改已发布 revision 内容。
 * 返回 true 表示应创建新 draft 而不是改写 published。
 */
export function shouldCreateDraftRevisionForEdit(input: {
  readonly hasPublishedRevision: boolean;
  readonly hasDraftRevision: boolean;
}): boolean {
  // 任何编辑都写新 draft revision；已发布 revision 保持不可变。
  void input;
  return true;
}

function parseAdvancedConfig(value: unknown):
  | { ok: true; value: Partial<NormalizePiProviderConfigInput> }
  | { ok: false; code: PiProviderConfigValidationErrorCode; message: string } {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return fail('PI_PROVIDER_INVALID_ADVANCED_JSON', 'advancedConfig must be valid JSON');
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('PI_PROVIDER_INVALID_ADVANCED_JSON', 'advancedConfig must be a JSON object');
  }

  const forbidden = findForbiddenField(value);
  if (forbidden) {
    if (forbidden === 'oauth' || forbidden === 'oauthToken') {
      return fail('PI_PROVIDER_UNSUPPORTED_AUTH', `Unsupported auth field: ${forbidden}`);
    }
    if (forbidden === 'shell' || forbidden === 'command') {
      return fail('PI_PROVIDER_UNSUPPORTED_FIELD', `Shell/command fields are not supported: ${forbidden}`);
    }
    if (forbidden === 'env' || forbidden === 'environment') {
      return fail('PI_PROVIDER_ENV_INTERPOLATION', `Environment fields are not supported: ${forbidden}`);
    }
    if (forbidden === 'headers' || forbidden === 'header' || forbidden === 'body' || forbidden === 'requestBody' || forbidden === 'rawBody') {
      return fail('PI_PROVIDER_UNSUPPORTED_FIELD', `Arbitrary Header/Body is not supported: ${forbidden}`);
    }
    return fail('PI_PROVIDER_UNSUPPORTED_FIELD', `Unsupported field: ${forbidden}`);
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      return fail('PI_PROVIDER_UNSUPPORTED_FIELD', `Unsupported advanced config field: ${key}`);
    }
  }

  return {
    ok: true,
    value: {
      protocol: record.protocol,
      baseUrl: record.baseUrl,
      endpointMode: record.endpointMode,
      modelId: record.modelId,
      timeoutMs: record.timeoutMs ?? record.timeout,
      maxOutputTokens: record.maxOutputTokens,
      compatibilityParams: record.compatibilityParams,
    },
  };
}

function normalizeCompatibilityParams(
  value: unknown,
): { ok: true; value: PiProviderCompatibilityParams } | { ok: false; code: PiProviderConfigValidationErrorCode; message: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: {} };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return fail('PI_PROVIDER_INVALID_COMPATIBILITY_PARAMS', 'compatibilityParams must be an object');
  }
  const keys = Object.keys(value as object);
  if (keys.length > 0) {
    return fail(
      'PI_PROVIDER_INVALID_COMPATIBILITY_PARAMS',
      `Unsupported compatibility parameter: ${keys[0]}`,
    );
  }
  return { ok: true, value: {} };
}

function findForbiddenField(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_FIELD_NAMES.has(key)) return key;
    const found = findForbiddenField(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function containsEnvInterpolation(value: string): boolean {
  return ENV_INTERPOLATION.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function fail(
  code: PiProviderConfigValidationErrorCode,
  message: string,
): { ok: false; code: PiProviderConfigValidationErrorCode; message: string } {
  return { ok: false, code, message };
}

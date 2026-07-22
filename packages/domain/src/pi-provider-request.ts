/**
 * PI Provider 公开请求的运行时 exact-key parser。
 * TypeScript interface 不提供运行时校验；所有入口必须经此 fail closed。
 */

import {
  isPiProviderPreset,
  normalizePiProviderConfig,
  validatePiProviderApiKey,
  validatePiProviderConsoleUrl,
  validatePiProviderDisplayName,
  validatePiProviderNotes,
  type PiProviderConfig,
  type PiProviderPreset,
} from './pi-provider-policy.js';

/** Socket 认证层可能注入的字段；允许出现，但不得被客户端当作业务字段滥用。 */
const SOCKET_ENRICHED_KEYS = new Set(['userId', 'teamId', 'currentDeviceId']);

const CREATE_KEYS = new Set([
  ...SOCKET_ENRICHED_KEYS,
  'preset',
  'displayName',
  'baseUrl',
  'endpointMode',
  'modelId',
  'timeoutMs',
  'maxOutputTokens',
  'compatibilityParams',
  'notes',
  'consoleUrl',
  'apiKey',
  'advancedConfig',
]);

const UPDATE_KEYS = new Set([
  ...SOCKET_ENRICHED_KEYS,
  'cardId',
  'displayName',
  'baseUrl',
  'endpointMode',
  'modelId',
  'timeoutMs',
  'maxOutputTokens',
  'compatibilityParams',
  'notes',
  'consoleUrl',
  'apiKey',
  'advancedConfig',
]);

const COPY_KEYS = new Set([
  ...SOCKET_ENRICHED_KEYS,
  'sourceCardId',
  'displayName',
]);

const GET_KEYS = new Set([
  ...SOCKET_ENRICHED_KEYS,
  'cardId',
]);

const LIST_KEYS = new Set([...SOCKET_ENRICHED_KEYS]);

const CARD_ACTION_KEYS = new Set([
  ...SOCKET_ENRICHED_KEYS,
  'cardId',
]);

const ACTIVE_MODEL_KEYS = new Set([
  ...SOCKET_ENRICHED_KEYS,
  'revisionId',
]);

/** 顶层敏感/未支持字段：即使出现在 allowlist 外也给出更明确错误码。 */
const SENSITIVE_TOP_LEVEL = new Set([
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
  'apiKeyCiphertext',
  'encryptedApiKey',
  'encrypted_payload',
]);

export type PiProviderRequestParseErrorCode =
  | 'PI_PROVIDER_REQUEST_NOT_OBJECT'
  | 'PI_PROVIDER_REQUEST_UNKNOWN_FIELD'
  | 'PI_PROVIDER_REQUEST_SENSITIVE_FIELD'
  | 'PI_PROVIDER_REQUEST_MISSING_USER'
  | 'PI_PROVIDER_REQUEST_INVALID'
  | 'PI_PROVIDER_INVALID_PRESET'
  | 'PI_PROVIDER_INVALID_DISPLAY_NAME'
  | 'PI_PROVIDER_INVALID_NOTES'
  | 'PI_PROVIDER_INVALID_CONSOLE_URL'
  | 'PI_PROVIDER_INVALID_API_KEY'
  | 'PI_PROVIDER_INVALID_BASE_URL'
  | 'PI_PROVIDER_INVALID_ENDPOINT_MODE'
  | 'PI_PROVIDER_INVALID_MODEL_ID'
  | 'PI_PROVIDER_INVALID_TIMEOUT'
  | 'PI_PROVIDER_INVALID_MAX_OUTPUT_TOKENS'
  | 'PI_PROVIDER_INVALID_COMPATIBILITY_PARAMS'
  | 'PI_PROVIDER_UNSUPPORTED_FIELD'
  | 'PI_PROVIDER_UNSUPPORTED_AUTH'
  | 'PI_PROVIDER_ENV_INTERPOLATION'
  | 'PI_PROVIDER_INVALID_ADVANCED_JSON';

export type PiProviderRequestParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: PiProviderRequestParseErrorCode; readonly message: string };

export interface ParsedPiProviderActor {
  readonly userId: string;
}

export interface ParsedCreatePiProviderCardRequest extends ParsedPiProviderActor {
  readonly preset: PiProviderPreset;
  readonly displayName: string;
  readonly notes: string | null;
  readonly consoleUrl: string | null;
  readonly apiKey: string;
  readonly config: PiProviderConfig;
}

export interface ParsedUpdatePiProviderCardRequest extends ParsedPiProviderActor {
  readonly cardId: string;
  readonly displayName: string;
  readonly notes: string | null;
  readonly consoleUrl: string | null;
  readonly apiKey: string | null;
  readonly config: PiProviderConfig;
}

export interface ParsedCopyPiProviderCardRequest extends ParsedPiProviderActor {
  readonly sourceCardId: string;
  readonly displayName?: string;
}

export interface ParsedGetPiProviderCardRequest extends ParsedPiProviderActor {
  readonly cardId: string;
}

export interface ParsedSetActivePiModelRequest extends ParsedPiProviderActor {
  readonly revisionId: string;
}

export function parseListPiProviderPresetsRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedPiProviderActor> {
  return parseActorOnly(payload, LIST_KEYS);
}

export function parseListPiProviderCardsRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedPiProviderActor> {
  return parseActorOnly(payload, LIST_KEYS);
}

export function parseGetPiProviderCardRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedGetPiProviderCardRequest> {
  return parseCardActionRequest(payload, GET_KEYS);
}

/** 模型发现：仅 cardId + 认证注入字段。 */
export function parseDiscoverPiProviderModelsRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedGetPiProviderCardRequest> {
  return parseCardActionRequest(payload, CARD_ACTION_KEYS);
}

/** 生产同路径测试：仅 cardId + 认证注入字段。 */
export function parseRunPiProviderTestRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedGetPiProviderCardRequest> {
  return parseCardActionRequest(payload, CARD_ACTION_KEYS);
}

/** 发布 Draft：仅 cardId + 认证注入字段。 */
export function parsePublishPiProviderCardRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedGetPiProviderCardRequest> {
  return parseCardActionRequest(payload, CARD_ACTION_KEYS);
}

export function parseGetActivePiModelRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedPiProviderActor> {
  return parseActorOnly(payload, LIST_KEYS);
}

export function parsePublicPiHealthRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedPiProviderActor> {
  return parseActorOnly(payload, LIST_KEYS);
}

export function parseSetActivePiModelRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedSetActivePiModelRequest> {
  const base = requireObject(payload);
  if (!base.ok) return base;
  const keys = rejectUnknownKeys(base.value, ACTIVE_MODEL_KEYS);
  if (!keys.ok) return keys;
  const userId = requireUserId(base.value);
  if (!userId.ok) return userId;
  const revisionId = requireNonEmptyString(base.value.revisionId, 'revisionId');
  if (!revisionId.ok) return revisionId;
  return { ok: true, value: { userId: userId.value, revisionId: revisionId.value } };
}

function parseCardActionRequest(
  payload: unknown,
  allowed: Set<string>,
): PiProviderRequestParseResult<ParsedGetPiProviderCardRequest> {
  const base = requireObject(payload);
  if (!base.ok) return base;
  const keys = rejectUnknownKeys(base.value, allowed);
  if (!keys.ok) return keys;
  const userId = requireUserId(base.value);
  if (!userId.ok) return userId;
  const cardId = requireNonEmptyString(base.value.cardId, 'cardId');
  if (!cardId.ok) return cardId;
  return { ok: true, value: { userId: userId.value, cardId: cardId.value } };
}

export function parseCreatePiProviderCardRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedCreatePiProviderCardRequest> {
  const base = requireObject(payload);
  if (!base.ok) return base;
  const keys = rejectUnknownKeys(base.value, CREATE_KEYS);
  if (!keys.ok) return keys;
  const userId = requireUserId(base.value);
  if (!userId.ok) return userId;
  if (!isPiProviderPreset(base.value.preset)) {
    return fail('PI_PROVIDER_INVALID_PRESET', 'Invalid provider preset');
  }
  const displayName = validatePiProviderDisplayName(base.value.displayName);
  if (!displayName.ok) return fail(displayName.code, displayName.message);
  const notes = validatePiProviderNotes(base.value.notes);
  if (!notes.ok) return fail(notes.code, notes.message);
  const consoleUrl = validatePiProviderConsoleUrl(base.value.consoleUrl);
  if (!consoleUrl.ok) return fail(consoleUrl.code, consoleUrl.message);
  const apiKey = validatePiProviderApiKey(base.value.apiKey, { required: true });
  if (!apiKey.ok) return fail(apiKey.code, apiKey.message);
  if (!apiKey.value) return fail('PI_PROVIDER_INVALID_API_KEY', 'apiKey is required');

  const configResult = normalizePiProviderConfig({
    baseUrl: base.value.baseUrl,
    endpointMode: base.value.endpointMode,
    modelId: base.value.modelId,
    timeoutMs: base.value.timeoutMs,
    maxOutputTokens: base.value.maxOutputTokens,
    compatibilityParams: base.value.compatibilityParams ?? {},
    advancedConfig: base.value.advancedConfig,
  });
  if (!configResult.ok) return fail(configResult.code, configResult.message);

  return {
    ok: true,
    value: {
      userId: userId.value,
      preset: base.value.preset,
      displayName: displayName.value,
      notes: notes.value,
      consoleUrl: consoleUrl.value,
      apiKey: apiKey.value,
      config: configResult.config,
    },
  };
}

export function parseUpdatePiProviderCardRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedUpdatePiProviderCardRequest> {
  const base = requireObject(payload);
  if (!base.ok) return base;
  const keys = rejectUnknownKeys(base.value, UPDATE_KEYS);
  if (!keys.ok) return keys;
  const userId = requireUserId(base.value);
  if (!userId.ok) return userId;
  const cardId = requireNonEmptyString(base.value.cardId, 'cardId');
  if (!cardId.ok) return cardId;
  const displayName = validatePiProviderDisplayName(base.value.displayName);
  if (!displayName.ok) return fail(displayName.code, displayName.message);
  const notes = validatePiProviderNotes(base.value.notes);
  if (!notes.ok) return fail(notes.code, notes.message);
  const consoleUrl = validatePiProviderConsoleUrl(base.value.consoleUrl);
  if (!consoleUrl.ok) return fail(consoleUrl.code, consoleUrl.message);
  const apiKey = validatePiProviderApiKey(base.value.apiKey, { required: false });
  if (!apiKey.ok) return fail(apiKey.code, apiKey.message);

  const configResult = normalizePiProviderConfig({
    baseUrl: base.value.baseUrl,
    endpointMode: base.value.endpointMode,
    modelId: base.value.modelId,
    timeoutMs: base.value.timeoutMs,
    maxOutputTokens: base.value.maxOutputTokens,
    compatibilityParams: base.value.compatibilityParams ?? {},
    advancedConfig: base.value.advancedConfig,
  });
  if (!configResult.ok) return fail(configResult.code, configResult.message);

  return {
    ok: true,
    value: {
      userId: userId.value,
      cardId: cardId.value,
      displayName: displayName.value,
      notes: notes.value,
      consoleUrl: consoleUrl.value,
      apiKey: apiKey.value,
      config: configResult.config,
    },
  };
}

export function parseCopyPiProviderCardRequest(
  payload: unknown,
): PiProviderRequestParseResult<ParsedCopyPiProviderCardRequest> {
  const base = requireObject(payload);
  if (!base.ok) return base;
  const keys = rejectUnknownKeys(base.value, COPY_KEYS);
  if (!keys.ok) return keys;
  const userId = requireUserId(base.value);
  if (!userId.ok) return userId;
  const sourceCardId = requireNonEmptyString(base.value.sourceCardId, 'sourceCardId');
  if (!sourceCardId.ok) return sourceCardId;
  if (base.value.displayName !== undefined && base.value.displayName !== null) {
    const displayName = validatePiProviderDisplayName(base.value.displayName);
    if (!displayName.ok) return fail(displayName.code, displayName.message);
    return {
      ok: true,
      value: {
        userId: userId.value,
        sourceCardId: sourceCardId.value,
        displayName: displayName.value,
      },
    };
  }
  return {
    ok: true,
    value: {
      userId: userId.value,
      sourceCardId: sourceCardId.value,
    },
  };
}

function parseActorOnly(
  payload: unknown,
  allowed: Set<string>,
): PiProviderRequestParseResult<ParsedPiProviderActor> {
  const base = requireObject(payload);
  if (!base.ok) return base;
  const keys = rejectUnknownKeys(base.value, allowed);
  if (!keys.ok) return keys;
  const userId = requireUserId(base.value);
  if (!userId.ok) return userId;
  return { ok: true, value: { userId: userId.value } };
}

function requireObject(
  payload: unknown,
): PiProviderRequestParseResult<Record<string, unknown>> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('PI_PROVIDER_REQUEST_NOT_OBJECT', 'Request payload must be an object');
  }
  return { ok: true, value: payload as Record<string, unknown> };
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
): PiProviderRequestParseResult<true> {
  for (const key of Object.keys(record)) {
    if (SENSITIVE_TOP_LEVEL.has(key)) {
      return fail('PI_PROVIDER_REQUEST_SENSITIVE_FIELD', `Unsupported sensitive field: ${key}`);
    }
    if (!allowed.has(key)) {
      return fail('PI_PROVIDER_REQUEST_UNKNOWN_FIELD', `Unsupported request field: ${key}`);
    }
  }
  return { ok: true, value: true };
}

function requireUserId(
  record: Record<string, unknown>,
): PiProviderRequestParseResult<string> {
  if (typeof record.userId !== 'string' || !record.userId.trim()) {
    return fail('PI_PROVIDER_REQUEST_MISSING_USER', 'userId is required');
  }
  return { ok: true, value: record.userId.trim() };
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): PiProviderRequestParseResult<string> {
  if (typeof value !== 'string' || !value.trim()) {
    return fail('PI_PROVIDER_REQUEST_INVALID', `${field} is required`);
  }
  return { ok: true, value: value.trim() };
}

function fail(
  code: PiProviderRequestParseErrorCode,
  message: string,
): { ok: false; code: PiProviderRequestParseErrorCode; message: string } {
  return { ok: false, code, message };
}

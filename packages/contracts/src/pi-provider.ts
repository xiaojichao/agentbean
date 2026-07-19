import type { ID, UnixMs } from './common.js';

/** MVP 仅实现 OpenAI-compatible Chat Completions 协议。 */
export type PiProviderProtocol = 'openai_chat_completions';

/** MVP 内置四类 Provider Preset。 */
export type PiProviderPreset =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'custom_openai_compatible';

/** MVP 仅支持 chat_completions 端点模式。 */
export type PiProviderEndpointMode = 'chat_completions';

/** 配置 revision 生命周期状态。Draft 可被新 revision 取代；published 不可原地修改。 */
export type PiProviderRevisionStatus = 'draft' | 'published';

/**
 * 高级 JSON 与普通表单共享的类型化配置。
 * Credential 不在此结构中，仅以不可编辑的 credentialRef 出现在 Card DTO。
 */
export interface PiProviderConfigDto {
  readonly protocol: PiProviderProtocol;
  readonly baseUrl: string;
  readonly endpointMode: PiProviderEndpointMode;
  readonly modelId: string;
  /** 请求超时（毫秒）。 */
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  /**
   * 少量明确允许的兼容参数。
   * 任意 Header/Body、OAuth、Shell、环境变量插值与未支持字段一律拒绝。
   */
  readonly compatibilityParams: PiProviderCompatibilityParamsDto;
}

/**
 * MVP 兼容参数 allowlist。当前为空对象契约：允许 `{}`，拒绝未知键。
 * 后续仅在 Schema 扩展后再增加字段。
 */
export type PiProviderCompatibilityParamsDto = Record<string, never>;

/** 系统管理员可见的 Credential 引用；永不包含明文或密文。 */
export interface PiProviderCredentialRefDto {
  readonly credentialRef: ID;
  /** 是否已配置 Credential（不暴露内容）。 */
  readonly configured: boolean;
  /** 短指纹，仅用于识别轮换，不可逆推密钥。 */
  readonly fingerprint?: string;
}

/** 不可变配置 revision 的公开管理 DTO（无 Credential 明文/密文）。 */
export interface PiProviderCardRevisionDto {
  readonly id: ID;
  readonly cardId: ID;
  readonly status: PiProviderRevisionStatus;
  readonly config: PiProviderConfigDto;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
}

/** 系统管理员可见的 PI Provider Card。 */
export interface PiProviderCardDto {
  readonly id: ID;
  readonly displayName: string;
  readonly preset: PiProviderPreset;
  readonly notes: string | null;
  readonly consoleUrl: string | null;
  readonly credential: PiProviderCredentialRefDto;
  readonly draftRevision: PiProviderCardRevisionDto | null;
  readonly publishedRevision: PiProviderCardRevisionDto | null;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface ListPiProviderPresetsResult {
  readonly presets: readonly PiProviderPresetDescriptorDto[];
}

export interface PiProviderPresetDescriptorDto {
  readonly preset: PiProviderPreset;
  readonly displayName: string;
  readonly defaultBaseUrl: string;
  readonly defaultEndpointMode: PiProviderEndpointMode;
  readonly defaultConsoleUrl: string | null;
  readonly protocol: PiProviderProtocol;
}

export interface CreatePiProviderCardInput {
  readonly preset: PiProviderPreset;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly endpointMode: PiProviderEndpointMode;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly compatibilityParams?: PiProviderCompatibilityParamsDto;
  readonly notes?: string | null;
  readonly consoleUrl?: string | null;
  /** 创建时提供的 Bearer API Key；保存后永不回显。 */
  readonly apiKey: string;
  /**
   * 可选高级 JSON 投影。若提供，必须通过 Schema 校验，并与表单字段合并为同一配置。
   * 不得包含 Credential、任意 Header/Body 等未支持字段。
   */
  readonly advancedConfig?: unknown;
}

export interface UpdatePiProviderCardInput {
  readonly cardId: ID;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly endpointMode: PiProviderEndpointMode;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly compatibilityParams?: PiProviderCompatibilityParamsDto;
  readonly notes?: string | null;
  readonly consoleUrl?: string | null;
  /**
   * 若提供非空字符串，则替换 Credential（保持稳定 credentialRef）。
   * 省略或 null 表示保留现有 Credential。
   */
  readonly apiKey?: string | null;
  readonly advancedConfig?: unknown;
}

export interface CopyPiProviderCardInput {
  readonly sourceCardId: ID;
  readonly displayName?: string;
}

export interface GetPiProviderCardInput {
  readonly cardId: ID;
}

export interface ListPiProviderCardsResult {
  readonly cards: readonly PiProviderCardDto[];
}

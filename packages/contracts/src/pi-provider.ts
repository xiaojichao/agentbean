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
  /** 显示名称属于 revision 元数据；编辑已发布 Card 时进入新 Draft，不改 published。 */
  readonly displayName: string;
  readonly notes: string | null;
  readonly consoleUrl: string | null;
  readonly config: PiProviderConfigDto;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
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

/** 模型发现结果；不自动发布、不改变生产绑定。 */
export interface PiProviderModelCandidateDto {
  readonly modelId: string;
}

export interface DiscoverPiProviderModelsResult {
  readonly cardId: ID;
  /** Provider 是否提供可用的 /models 发现接口。 */
  readonly discoverySupported: boolean;
  readonly models: readonly PiProviderModelCandidateDto[];
  readonly updatedAt: UnixMs;
  /** 脱敏诊断码；发现成功时为 null。 */
  readonly diagnosticCode: string | null;
}

export type PiProviderTestStatus = 'passed' | 'failed';

/**
 * 生产同路径测试结果。
 * 不含业务消息、完整 prompt 或 Credential；绑定 configSummary。
 */
export interface PiProviderTestResultDto {
  readonly id: ID;
  readonly cardId: ID;
  readonly draftRevisionId: ID;
  readonly configSummary: string;
  readonly status: PiProviderTestStatus;
  readonly textOk: boolean;
  readonly toolCallOk: boolean;
  readonly responseModel: string | null;
  readonly finishReasonText: string | null;
  readonly finishReasonTool: string | null;
  readonly usageInputTokens: number | null;
  readonly usageOutputTokens: number | null;
  readonly durationMs: number;
  /** 公开诊断码，永不含秘密。 */
  readonly diagnosticCode: string | null;
  readonly testedBy: ID;
  readonly testedAt: UnixMs;
}

export interface RunPiProviderTestResult {
  readonly test: PiProviderTestResultDto;
  readonly card: PiProviderCardDto;
}

export interface CancelPiProviderTestResult {
  readonly cancelled: boolean;
}

export interface PublishPiProviderCardResult {
  readonly card: PiProviderCardDto;
}

/**
 * 系统管理员可见的 PI Provider Card。
 * displayName/notes/consoleUrl 是当前工作 revision（draft 优先，否则 published）的投影。
 */
export interface PiProviderCardDto {
  readonly id: ID;
  readonly displayName: string;
  readonly preset: PiProviderPreset;
  readonly notes: string | null;
  readonly consoleUrl: string | null;
  readonly credential: PiProviderCredentialRefDto;
  readonly draftRevision: PiProviderCardRevisionDto | null;
  readonly publishedRevision: PiProviderCardRevisionDto | null;
  readonly modelCandidates: readonly PiProviderModelCandidateDto[];
  readonly modelCandidatesUpdatedAt: UnixMs | null;
  readonly latestTest: PiProviderTestResultDto | null;
  readonly canPublish: boolean;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

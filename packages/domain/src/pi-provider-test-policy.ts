/**
 * PI Provider 生产同路径测试与发布门禁（纯规则）。
 * 测试结果绑定规范化配置摘要；摘要变化后旧通过结果不可用于发布。
 */

import { createHash } from 'node:crypto';

export interface PiProviderConfigSummaryInput {
  readonly protocol: string;
  readonly baseUrl: string;
  readonly endpointMode: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly compatibilityParams: Record<string, never> | Record<string, unknown>;
  /** Credential 指纹；轮换密钥后旧测试失效。 */
  readonly credentialFingerprint: string;
}

/** 规范化配置摘要（sha256 hex），不含显示名/备注等不影响模型路径的字段。 */
export function computePiProviderConfigSummary(input: PiProviderConfigSummaryInput): string {
  const canonical = {
    protocol: input.protocol,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    endpointMode: input.endpointMode,
    modelId: input.modelId.trim(),
    timeoutMs: input.timeoutMs,
    maxOutputTokens: input.maxOutputTokens,
    compatibilityParams: input.compatibilityParams ?? {},
    credentialFingerprint: input.credentialFingerprint,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export type PiProviderPublishDenialReason =
  | 'NO_DRAFT'
  | 'NO_PASSING_TEST'
  | 'CONFIG_SUMMARY_MISMATCH'
  | 'TEST_NOT_PASSED';

export type PiProviderPublishDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: PiProviderPublishDenialReason };

export interface EvaluatePiProviderPublishInput {
  readonly hasDraftRevision: boolean;
  readonly draftConfigSummary: string;
  readonly latestTest: {
    readonly status: 'passed' | 'failed';
    readonly configSummary: string;
  } | null;
}

/** 只有绑定当前 Draft 配置摘要且通过的测试才能发布。 */
export function evaluatePiProviderPublish(
  input: EvaluatePiProviderPublishInput,
): PiProviderPublishDecision {
  if (!input.hasDraftRevision) return { allowed: false, reason: 'NO_DRAFT' };
  if (!input.latestTest) return { allowed: false, reason: 'NO_PASSING_TEST' };
  if (input.latestTest.configSummary !== input.draftConfigSummary) {
    return { allowed: false, reason: 'CONFIG_SUMMARY_MISMATCH' };
  }
  if (input.latestTest.status !== 'passed') {
    return { allowed: false, reason: 'TEST_NOT_PASSED' };
  }
  return { allowed: true };
}

/** 固定无业务数据的探测文案。 */
export const PI_PROVIDER_PROBE = {
  textSystem: 'You are a connectivity probe. Reply with exactly the word OK and nothing else.',
  textUser: 'probe',
  toolSystem:
    'You are a connectivity probe. You must call the function context.get_root_message with an empty JSON object {}. Do not answer in plain text before the tool call.',
  toolUser: 'run tool probe',
  toolResultContent: 'probe-ok',
  toolFinalSystem:
    'You are a connectivity probe. After receiving the tool result, reply with exactly the word DONE and nothing else.',
} as const;

export const PI_PROVIDER_PROBE_TOOL = {
  name: 'context.get_root_message' as const,
  description: 'Connectivity probe tool. Call with empty arguments.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

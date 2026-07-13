import type { ManagementWorkerCredentialStatus } from '../../../packages/contracts/src/index.js';

export type ManagementCredentialResolution = {
  readonly credentialStatus: 'unavailable';
} | {
  readonly credentialStatus: Exclude<ManagementWorkerCredentialStatus, 'unavailable'>;
  readonly providerId: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseUrl: string;
};

export interface ManagementCredentialProvider {
  resolve(): Promise<ManagementCredentialResolution>;
}

export type ManagementCredentialCapability = {
  readonly credentialStatus: 'unavailable';
} | {
  readonly credentialStatus: Exclude<ManagementWorkerCredentialStatus, 'unavailable'>;
  readonly providerId: string;
  readonly modelId: string;
};

export interface CreateEnvironmentManagementCredentialProviderInput {
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * 环境变量仅用于 CI/dev 的显式临时凭据，因此永远只能报告 test_only。
 * production_ready 必须由后续系统凭证存储 adapter 显式提供。
 */
export function createEnvironmentManagementCredentialProvider(
  input: CreateEnvironmentManagementCredentialProviderInput = {},
): ManagementCredentialProvider {
  const env = input.env ?? process.env;
  return {
    async resolve() {
      const apiKey = nonEmpty(env.AGENTBEAN_MANAGEMENT_API_KEY);
      const providerId = nonEmpty(env.AGENTBEAN_MANAGEMENT_PROVIDER_ID);
      const modelId = nonEmpty(env.AGENTBEAN_MANAGEMENT_MODEL_ID);
      if (!apiKey || !providerId || !modelId) {
        return { credentialStatus: 'unavailable' };
      }
      return {
        credentialStatus: 'test_only',
        providerId,
        modelId,
        apiKey,
        baseUrl: normalizeBaseUrl(env.AGENTBEAN_MANAGEMENT_BASE_URL),
      };
    },
  };
}

export function managementCredentialCapability(
  resolution: ManagementCredentialResolution,
): ManagementCredentialCapability {
  if (resolution.credentialStatus === 'unavailable') {
    return { credentialStatus: 'unavailable' };
  }
  return {
    credentialStatus: resolution.credentialStatus,
    providerId: resolution.providerId,
    modelId: resolution.modelId,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(value: string | undefined): string {
  const normalized = nonEmpty(value) ?? 'https://api.openai.com/v1';
  return normalized.replace(/\/+$/, '');
}

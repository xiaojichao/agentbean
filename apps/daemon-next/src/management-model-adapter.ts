import {
  ManagementModelAdapterError,
  createOpenAiCompatibleManagementModelAdapter,
  type ManagementModelAdapter,
} from '@agentbean/pi-management-runtime';
import type { ManagementCredentialResolution } from './management-credential-provider.js';

type AvailableManagementCredential = Exclude<ManagementCredentialResolution, { credentialStatus: 'unavailable' }>;

export interface CreateManagementModelAdapterInput {
  readonly credential: AvailableManagementCredential;
  readonly fetch?: typeof fetch;
}

/**
 * Device-hosted Management Worker 的兼容包装。
 * 共享 adapter 暴露细分诊断码；这里保留旧 Device 路径已有的三类错误语义。
 */
export function createManagementModelAdapter(input: CreateManagementModelAdapterInput): ManagementModelAdapter {
  const { credential } = input;
  const sharedAdapter = createOpenAiCompatibleManagementModelAdapter({
    id: `${credential.providerId}:${credential.modelId}`,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl,
    modelId: credential.modelId,
    fetch: input.fetch,
  });
  return {
    id: sharedAdapter.id,
    async respond(request, state) {
      try {
        return await sharedAdapter.respond(request, state);
      } catch (error) {
        if (!(error instanceof ManagementModelAdapterError)) throw error;
        if (error.code === 'MANAGEMENT_MODEL_RESPONSE_INVALID'
          || error.code === 'MANAGEMENT_MODEL_RESPONSE_INVALID_JSON'
          || error.code === 'MANAGEMENT_MODEL_TOOL_CALL_INVALID') {
          throw new Error('MANAGEMENT_MODEL_RESPONSE_INVALID');
        }
        if (error.code === 'MANAGEMENT_MODEL_AUTHENTICATION_FAILED'
          || error.code === 'MANAGEMENT_MODEL_RATE_LIMITED'
          || error.code === 'MANAGEMENT_MODEL_RESPONSE_REJECTED'
          || error.code === 'MANAGEMENT_MODEL_SERVER_FAILED') {
          throw new Error('MANAGEMENT_MODEL_RESPONSE_REJECTED');
        }
        throw new Error('MANAGEMENT_MODEL_REQUEST_FAILED');
      }
    },
  };
}

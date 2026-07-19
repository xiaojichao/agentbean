/**
 * OpenAI-compatible 模型列表发现：GET {baseUrl}/models
 * 不支持时返回 discoverySupported=false，允许手工填写 Model ID。
 */

export interface DiscoverPiProviderModelsInput {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export interface DiscoverPiProviderModelsOutcome {
  readonly discoverySupported: boolean;
  readonly modelIds: readonly string[];
  readonly diagnosticCode: string | null;
}

export async function discoverPiProviderModels(
  input: DiscoverPiProviderModelsInput,
): Promise<DiscoverPiProviderModelsOutcome> {
  const fetchFn = input.fetch ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/models`;
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return { discoverySupported: false, modelIds: [], diagnosticCode: 'PI_PROVIDER_DISCOVERY_UNSUPPORTED' };
    }
    if (response.status === 401 || response.status === 403) {
      return { discoverySupported: false, modelIds: [], diagnosticCode: 'PI_PROVIDER_DISCOVERY_AUTH_FAILED' };
    }
    if (!response.ok) {
      return {
        discoverySupported: false,
        modelIds: [],
        diagnosticCode: `PI_PROVIDER_DISCOVERY_HTTP_${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { discoverySupported: false, modelIds: [], diagnosticCode: 'PI_PROVIDER_DISCOVERY_INVALID_JSON' };
    }

    const modelIds = parseModelIds(body);
    if (modelIds === null) {
      return { discoverySupported: false, modelIds: [], diagnosticCode: 'PI_PROVIDER_DISCOVERY_INVALID_SHAPE' };
    }
    return { discoverySupported: true, modelIds, diagnosticCode: null };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { discoverySupported: false, modelIds: [], diagnosticCode: 'PI_PROVIDER_DISCOVERY_TIMEOUT' };
    }
    return { discoverySupported: false, modelIds: [], diagnosticCode: 'PI_PROVIDER_DISCOVERY_NETWORK_FAILED' };
  } finally {
    clearTimeout(timer);
  }
}

function parseModelIds(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  // 去重保序
  return Array.from(new Set(ids));
}

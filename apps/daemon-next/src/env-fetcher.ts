import type { AgentEnvResolver } from './index.js';

export interface HttpEnvResolverOptions {
  serverUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/**
 * Creates an AgentEnvResolver that fetches a custom agent's env from the server
 * via the authenticated HTTP route `GET /api/teams/:teamId/agents/:agentId/env`,
 * using the device token as a Bearer header (not query string, to avoid access-log leakage).
 *
 * v1 does not cache: dispatch is low-frequency, so per-dispatch fetch keeps env always correct.
 */
export function createHttpEnvResolver(options: HttpEnvResolverOptions): AgentEnvResolver {
  const fetchFn = options.fetch ?? fetch;
  return async ({ agentId, teamId }) => {
    const url = `${options.serverUrl}/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}/env`;
    const response = await fetchFn(url, { headers: { Authorization: `Bearer ${options.token}` } });
    if (!response.ok) {
      throw new Error(`Agent env fetch failed: ${response.status}`);
    }
    const body = (await response.json()) as { ok: true; env: Record<string, string> };
    return body.env;
  };
}

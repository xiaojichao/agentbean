import type { AdapterKind } from './db.js';

export function renderConnectCommand(input: { adapterKind: AdapterKind; serverUrl?: string; token?: string }): string {
  const serverUrl = input.serverUrl ?? process.env.AGENT_BEAN_PUBLIC_SERVER_URL ?? 'http://localhost:4000';
  const tokenPart = input.token ? ` --token ${input.token}` : '';
  return `npx @agentbean/daemon@latest --server-url ${serverUrl}${tokenPart}`;
}

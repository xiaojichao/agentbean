import type { AdapterKind } from './db.js';

const KNOWN: Partial<Record<AdapterKind, string>> = {
  codex: 'examples/codex-shaw.yaml.example',
  'claude-code': 'examples/claude-code-shaw.yaml.example',
};

export function renderConnectCommand(input: { adapterKind: AdapterKind }): string {
  const cfg = KNOWN[input.adapterKind] ?? 'examples/agent.config.yaml.example';
  return [
    '# 启动一个真实 Agent daemon (确保已 cp .env.example .env 并填好 token)',
    'cd apps/agent',
    `AGENT_CONFIG=${cfg} npm run dev`,
  ].join('\n');
}

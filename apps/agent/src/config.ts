import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';

export type AdapterKind = 'codex' | 'claude-code' | 'openclaw' | 'hermes' | 'standalone';
const KINDS: AdapterKind[] = ['codex', 'claude-code', 'openclaw', 'hermes', 'standalone'];

export type AgentCategory = 'executor-hosted' | 'agentos-hosted' | 'standalone-cli';

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  category: AgentCategory;
  adapter: {
    kind: AdapterKind;
    command: string;
    args: string[];
    cwd?: string;
    workspace?: string;
    systemPrompt?: string;
  };
  server: { url: string; token: string };
  heartbeatIntervalMs: number;
}

export interface AgentConfigEntry {
  id: string;
  name: string;
  role: string;
  category: AgentCategory;
  adapter: {
    kind: AdapterKind;
    command: string;
    args: string[];
    cwd?: string;
    workspace?: string;
    systemPrompt?: string;
  };
  visibility: 'public' | 'private';
  sandboxed?: boolean;
}

export interface DeviceConfig {
  deviceId: string;
  networkId: string;
  server: { url: string; token: string };
  heartbeatIntervalMs: number;
  agents: AgentConfigEntry[];
}

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function interpolate(value: string): string {
  return value.replace(ENV_PATTERN, (_match, name) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`config references missing env var: ${name}`);
    return v;
  });
}

function deepInterpolate(node: unknown): unknown {
  if (typeof node === 'string') return interpolate(node);
  if (Array.isArray(node)) return node.map(deepInterpolate);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepInterpolate(v);
    return out;
  }
  return node;
}

export function loadConfig(path: string): AgentConfig {
  const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('config: top-level must be a mapping');
  const interp = deepInterpolate(raw) as Record<string, any>;

  const need = ['id', 'name', 'role'] as const;
  for (const k of need) {
    if (typeof interp[k] !== 'string' || interp[k].length === 0) {
      throw new Error(`config: ${k} is required (non-empty string)`);
    }
  }
  const a = interp.adapter ?? {};
  if (!KINDS.includes(a.kind)) {
    throw new Error(`config: adapter.kind must be one of ${KINDS.join(', ')}`);
  }
  if (typeof a.command !== 'string') {
    throw new Error('config: adapter.command is required');
  }
  const s = interp.server ?? {};
  if (typeof s.url !== 'string' || typeof s.token !== 'string') {
    throw new Error('config: server.url and server.token are required');
  }

  const inferredCategory: AgentCategory =
    a.kind === 'codex' || a.kind === 'claude-code' ? 'executor-hosted' :
    a.kind === 'openclaw' || a.kind === 'hermes' ? 'agentos-hosted' :
    'standalone-cli';
  const category: AgentCategory =
    typeof interp.category === 'string' && ['executor-hosted', 'agentos-hosted', 'standalone-cli'].includes(interp.category)
      ? (interp.category as AgentCategory)
      : inferredCategory;

  return {
    id: interp.id,
    name: interp.name,
    role: interp.role,
    category,
    adapter: {
      kind: a.kind,
      command: a.command,
      args: Array.isArray(a.args) ? a.args.map(String) : [],
      cwd: typeof a.cwd === 'string' ? a.cwd : undefined,
      workspace: typeof a.workspace === 'string' ? a.workspace : undefined,
      systemPrompt: typeof a.systemPrompt === 'string' ? a.systemPrompt : undefined,
    },
    server: { url: s.url, token: s.token },
    heartbeatIntervalMs: isValidHeartbeat(interp.heartbeatIntervalMs) ? interp.heartbeatIntervalMs : 10_000,
  };
}

function isValidHeartbeat(v: unknown): v is number {
  return typeof v === 'number' && v > 0 && Number.isFinite(v);
}

export function loadDeviceConfig(path: string): DeviceConfig {
  const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('config: top-level must be a mapping');
  const interp = deepInterpolate(raw) as Record<string, any>;

  if (typeof interp.deviceId !== 'string' || interp.deviceId.length === 0) {
    throw new Error('config: deviceId is required (non-empty string)');
  }
  if (typeof interp.networkId !== 'string' || interp.networkId.length === 0) {
    throw new Error('config: networkId is required (non-empty string)');
  }

  const s = interp.server ?? {};
  if (typeof s.url !== 'string' || typeof s.token !== 'string') {
    throw new Error('config: server.url and server.token are required');
  }

  const agents = interp.agents ?? [];
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error('config: agents array is required (at least one agent)');
  }

  const parsedAgents: AgentConfigEntry[] = [];
  for (const a of agents) {
    if (typeof a.id !== 'string' || a.id.length === 0) {
      throw new Error('config: each agent must have an id (non-empty string)');
    }
    if (typeof a.name !== 'string' || a.name.length === 0) {
      throw new Error('config: each agent must have a name (non-empty string)');
    }
    const ad = a.adapter ?? {};
    if (!KINDS.includes(ad.kind)) {
      throw new Error(`config: adapter.kind must be one of ${KINDS.join(', ')}`);
    }
    if (typeof ad.command !== 'string') {
      throw new Error('config: adapter.command is required');
    }
    const inferredCategory: AgentCategory =
      ad.kind === 'codex' || ad.kind === 'claude-code' ? 'executor-hosted' :
      ad.kind === 'openclaw' || ad.kind === 'hermes' ? 'agentos-hosted' :
      'standalone-cli';
    const category: AgentCategory =
      typeof a.category === 'string' && ['executor-hosted', 'agentos-hosted', 'standalone-cli'].includes(a.category)
        ? a.category
        : inferredCategory;
    parsedAgents.push({
      id: a.id,
      name: a.name,
      role: typeof a.role === 'string' ? a.role : '',
      category,
      adapter: {
        kind: ad.kind,
        command: ad.command,
        args: Array.isArray(ad.args) ? ad.args.map(String) : [],
        cwd: typeof ad.cwd === 'string' ? ad.cwd : undefined,
        workspace: typeof ad.workspace === 'string' ? ad.workspace : undefined,
        systemPrompt: typeof ad.systemPrompt === 'string' ? ad.systemPrompt : undefined,
      },
      visibility: a.visibility === 'public' ? 'public' : 'private',
      sandboxed: a.sandboxed === true,
    });
  }

  return {
    deviceId: interp.deviceId,
    networkId: interp.networkId,
    server: { url: s.url, token: s.token },
    heartbeatIntervalMs: isValidHeartbeat(interp.heartbeatIntervalMs) ? interp.heartbeatIntervalMs : 10_000,
    agents: parsedAgents,
  };
}

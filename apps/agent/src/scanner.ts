import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentCategory, AdapterKind } from './config.js';
import { logger } from './log.js';

// --- Runtime (not an Agent, just an installed CLI tool) ---

export interface RuntimeInfo {
  name: string;
  adapterKind: AdapterKind;
  command: string;
  installed: boolean;
}

// --- Discovered Agent (is an Agent, can be auto-added) ---

export interface ScannedAgent {
  category: AgentCategory;
  name: string;
  adapterKind: AdapterKind;
  command: string;
  args: string[];
  cwd?: string;
  source: 'gateway' | 'filesystem';
}

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile('which', [bin], { timeout: 5_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const path = stdout.trim();
      resolve(path.length > 0 ? path : null);
    });
    child.on('error', () => resolve(null));
  });
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: 10_000 }, (err, stdout) => {
      resolve(stdout?.trim() ?? '');
    });
    child.on('error', () => resolve(''));
  });
}

// --- Scan Coding Agent Runtimes (Claude Code, Codex, Kimi) ---

export async function scanRuntimes(): Promise<RuntimeInfo[]> {
  const checks = [
    { bin: 'claude', name: 'Claude Code', adapterKind: 'claude-code' as AdapterKind },
    { bin: 'codex', name: 'Codex CLI', adapterKind: 'codex' as AdapterKind },
    { bin: 'kimi-cli', name: 'Kimi CLI', adapterKind: 'codex' as AdapterKind },
    { bin: 'manus', name: 'Manus', adapterKind: 'standalone' as AdapterKind },
    { bin: 'anygen', name: 'Anygen', adapterKind: 'standalone' as AdapterKind },
  ];

  const results: RuntimeInfo[] = [];
  for (const s of checks) {
    const path = await which(s.bin);
    results.push({
      name: s.name,
      adapterKind: s.adapterKind,
      command: path ?? '',
      installed: path !== null,
    });
  }
  return results;
}

// --- Scan AgentOS Gateways (Hermes, OpenClaw) ---

async function checkHermesGateway(): Promise<ScannedAgent | null> {
  const path = await which('hermes');
  if (!path) return null;

  const status = await run('hermes', ['gateway', 'status']);
  const running = status.includes('running') || status.includes('✓');

  if (running) {
    return {
      category: 'agentos-hosted',
      name: 'Hermes Agent',
      adapterKind: 'hermes',
      command: path,
      args: ['gateway', 'run'],
      source: 'gateway',
    };
  }
  return null;
}

async function checkOpenClawGateway(): Promise<ScannedAgent | null> {
  const path = await which('openclaw');
  if (!path) return null;

  const status = await run('openclaw', ['gateway', 'status']);
  const running = status.includes('running') || status.includes('✓');

  if (running) {
    return {
      category: 'agentos-hosted',
      name: 'OpenClaw Agent',
      adapterKind: 'openclaw',
      command: path,
      args: ['gateway', 'run'],
      source: 'gateway',
    };
  }
  return null;
}

export async function scanAgentOSAgents(): Promise<ScannedAgent[]> {
  const [hermes, openclaw] = await Promise.all([
    checkHermesGateway(),
    checkOpenClawGateway(),
  ]);
  return [hermes, openclaw].filter((a): a is ScannedAgent => a !== null);
}

// --- Scan local agent definitions from filesystem ---

export async function scanLocalAgents(scanDir = join(homedir(), '.agentbean', 'agents')): Promise<ScannedAgent[]> {
  if (!existsSync(scanDir)) {
    return [];
  }

  const results: ScannedAgent[] = [];
  let entries: string[];
  try {
    entries = readdirSync(scanDir);
  } catch (err: any) {
    logger?.warn?.({ err: err?.message }, 'scan failed');
    return [];
  }

  for (const entry of entries) {
    const subdir = join(scanDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(subdir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const jsonPath = join(subdir, 'agent.json');
    const yamlPath = join(subdir, 'agent.yaml');
    const ymlPath = join(subdir, 'agent.yml');

    let raw: string | null = null;
    let ext: 'json' | 'yaml' | null = null;
    if (existsSync(jsonPath)) {
      raw = readFileSync(jsonPath, 'utf8');
      ext = 'json';
    } else if (existsSync(yamlPath)) {
      raw = readFileSync(yamlPath, 'utf8');
      ext = 'yaml';
    } else if (existsSync(ymlPath)) {
      raw = readFileSync(ymlPath, 'utf8');
      ext = 'yaml';
    }

    if (raw === null || ext === null) continue;

    let parsed: Record<string, unknown> | null = null;
    try {
      if (ext === 'json') {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } else {
        const { load: parseYaml } = await import('js-yaml');
        parsed = parseYaml(raw) as Record<string, unknown> | null;
      }
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;

    const name = typeof parsed.name === 'string' ? parsed.name : entry;
    const command = typeof parsed.command === 'string' ? parsed.command : '';
    const args = Array.isArray(parsed.args) ? (parsed.args as unknown[]).map(String) : [];

    let category: AgentCategory;
    if (typeof parsed.category === 'string' && ['executor-hosted', 'agentos-hosted', 'standalone-cli'].includes(parsed.category)) {
      category = parsed.category as AgentCategory;
    } else if ('executor' in parsed) {
      category = 'executor-hosted';
    } else {
      category = 'standalone-cli';
    }

    const adapterKind =
      typeof parsed.adapterKind === 'string' && ['codex', 'claude-code', 'openclaw', 'hermes', 'standalone'].includes(parsed.adapterKind)
        ? (parsed.adapterKind as AdapterKind)
        : 'standalone';

    results.push({
      category,
      name,
      adapterKind,
      command,
      args,
      source: 'filesystem',
    });
  }

  return results;
}

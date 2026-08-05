import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DaemonScanProvider, DaemonScanSnapshot } from './index.js';
import { scanAgentDescriptor } from './descriptor-scanner.js';

interface RuntimeSpec {
  bin: string;
  name: string;
  adapterKind: string;
  candidates?: string[];
}

export interface BuiltinScannerOptions {
  envPath?: string;
  homeDir?: string;
  localAgentsDir?: string;
  findExecutable?: (bin: string, candidates: string[]) => Promise<string | null>;
  runCommand?: (command: string, args: string[]) => Promise<string>;
}

export function createBuiltinScanProvider(options: BuiltinScannerOptions = {}): DaemonScanProvider {
  return () => scanBuiltinRuntimeAgents(options);
}

export async function scanBuiltinRuntimeAgents(
  options: BuiltinScannerOptions = {},
  specs: RuntimeSpec[] = defaultRuntimeSpecs(options.homeDir ?? homedir()),
): Promise<DaemonScanSnapshot> {
  const findExecutable = options.findExecutable ?? ((bin, candidates) => findExecutableOnPath(bin, candidates, options));
  const runtimes: DaemonScanSnapshot['runtimes'] = [];
  const agents: DaemonScanSnapshot['agents'] = [];

  for (const spec of specs) {
    const command = await findExecutable(spec.bin, spec.candidates ?? []);
    const installed = command !== null;
    runtimes.push({
      adapterKind: spec.adapterKind,
      name: spec.name,
      command: command ?? undefined,
      cwd: command ? dirname(command) : undefined,
      installed,
    });
    if (installed && command) {
      agents.push({
        adapterKind: spec.adapterKind,
        name: spec.name,
        category: 'executor-hosted',
        command,
        cwd: dirname(command),
        discoverySource: 'runtime',
        projectDocumentInputSetVersions: [1],
      });
    }
  }

  agents.push(...await scanAgentOSGateways(options, findExecutable));
  agents.push(...scanLocalAgentDefinitions(options.localAgentsDir ?? defaultLocalAgentsDir(options.homeDir ?? homedir())));

  return { runtimes, agents };
}

function defaultRuntimeSpecs(home: string): RuntimeSpec[] {
  return [
    {
      bin: 'claude',
      name: 'Claude Code',
      adapterKind: 'claude-code',
      candidates: claudeCandidates(home),
    },
    {
      bin: 'codex',
      name: 'Codex CLI',
      adapterKind: 'codex',
    },
    {
      bin: 'gemini',
      name: 'Gemini CLI',
      adapterKind: 'gemini',
    },
  ];
}

async function findExecutableOnPath(
  bin: string,
  candidates: string[],
  options: Pick<BuiltinScannerOptions, 'envPath' | 'homeDir'>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  for (const directory of pathEntries(options)) {
    const candidate = join(directory, bin);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function pathEntries(options: Pick<BuiltinScannerOptions, 'envPath' | 'homeDir'>): string[] {
  const home = options.homeDir ?? homedir();
  const dirs: string[] = [
    ...(options.envPath ?? process.env.PATH ?? '').split(':').filter(Boolean),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(home, '.local/bin'),
    join(home, '.bun/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.asdf/shims'),
    join(home, '.local/share/mise/shims'),
    // 版本管理器 shim/bin：daemon 作为 launchd 服务时 PATH 极简（/usr/bin:/bin:/usr/sbin:/sbin），
    // nvm/fnm 只在交互 shell 里动态注入 PATH，后台服务须显式纳入这些位置才能发现运行时。
    join(home, '.volta/bin'),
    join(home, '.fnm/current/bin'),
  ];
  // nvm/fnm 把可执行文件放在版本化目录（~/.nvm/versions/node/<ver>/bin），版本号可变，需扫描。
  pushVersionBinDirs(dirs, join(home, '.nvm/versions/node'), 'bin');
  pushVersionBinDirs(dirs, join(home, '.fnm/node-versions'), 'installation/bin');
  pushVersionBinDirs(dirs, join(home, '.local/share/fnm/node-versions'), 'installation/bin');
  return [...new Set(dirs)];
}

function pushVersionBinDirs(dirs: string[], versionsDir: string, suffix: string): void {
  let entries: string[];
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return;
  }
  for (const version of entries) {
    dirs.push(join(versionsDir, version, suffix));
  }
}

function claudeCandidates(home: string): string[] {
  return [
    join(home, '.local/share/claude-latest/current/claude'),
    join(home, '.local/share/claude/current/claude'),
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  ];
}

async function scanAgentOSGateways(
  options: BuiltinScannerOptions,
  findExecutable: (bin: string, candidates: string[]) => Promise<string | null>,
): Promise<DaemonScanSnapshot['agents']> {
  const [hermes, openclaw] = await Promise.all([
    scanHermesGateway(options, findExecutable),
    scanOpenClawGateway(options, findExecutable),
  ]);
  return [hermes, openclaw].filter((agent): agent is DaemonScanSnapshot['agents'][number] => agent !== null);
}

async function scanHermesGateway(
  options: BuiltinScannerOptions,
  findExecutable: (bin: string, candidates: string[]) => Promise<string | null>,
): Promise<DaemonScanSnapshot['agents'][number] | null> {
  const command = await findExecutable('hermes', []);
  if (!command) {
    return null;
  }

  const status = await runScannerCommand(options, command, ['gateway', 'status']);
  const running = status.includes('running') || status.includes('✓');
  if (!running) {
    return null;
  }

  const cwd = dirname(command);
  return {
    adapterKind: 'hermes',
    name: 'Hermes-Agent',
    category: 'agentos-hosted',
    command,
    args: [],
    cwd,
    discoverySource: 'gateway',
    gatewayInstanceKey: `hermes:${command}`,
    projectDocumentInputSetVersions: [1],
    // AgentOS 托管型 Agent：扫描 cwd 的 AGENTS.md/CLAUDE.md 作为能力事实层。
    descriptor: scanAgentDescriptor(cwd),
  };
}

async function scanOpenClawGateway(
  options: BuiltinScannerOptions,
  findExecutable: (bin: string, candidates: string[]) => Promise<string | null>,
): Promise<DaemonScanSnapshot['agents'][number] | null> {
  const command = await findExecutable('openclaw', []);
  if (!command) {
    return null;
  }

  const [status, agentsJson] = await Promise.all([
    runScannerCommand(options, command, ['gateway', 'status']),
    runScannerCommand(options, command, ['agents', 'list', '--json']),
  ]);
  const agentId = parseOpenClawAgentId(agentsJson);
  const running = status.includes('running') || status.includes('✓');
  if (!running && !agentId) {
    return null;
  }

  const resolvedAgentId = agentId ?? 'main';
  const cwd = dirname(command);
  return {
    adapterKind: 'openclaw',
    name: 'OpenClaw-Agent',
    category: 'agentos-hosted',
    command,
    args: ['agent', '--agent', resolvedAgentId],
    cwd,
    discoverySource: 'gateway',
    gatewayInstanceKey: `openclaw:${command}:${resolvedAgentId}`,
    projectDocumentInputSetVersions: [1],
    // AgentOS 托管型 Agent：扫描 cwd 的 AGENTS.md/CLAUDE.md 作为能力事实层。
    descriptor: scanAgentDescriptor(cwd),
  };
}

function parseOpenClawAgentId(output: string): string | null {
  if (!output.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(output);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.agents)
        ? parsed.agents
        : Array.isArray(parsed?.items)
          ? parsed.items
          : [];
    for (const item of list) {
      const id = typeof item === 'string'
        ? item
        : typeof item?.id === 'string'
          ? item.id
          : typeof item?.agentId === 'string'
            ? item.agentId
            : null;
      if (id?.trim()) {
        return id.trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}

function scanLocalAgentDefinitions(scanDir: string): DaemonScanSnapshot['agents'] {
  if (!existsSync(scanDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(scanDir);
  } catch {
    return [];
  }

  const agents: DaemonScanSnapshot['agents'] = [];
  for (const entry of entries) {
    const subdir = join(scanDir, entry);
    try {
      if (!statSync(subdir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const agent = readLocalAgentDefinition(join(subdir, 'agent.json'), entry);
    if (agent) {
      agents.push(agent);
    }
  }
  return agents;
}

function readLocalAgentDefinition(path: string, fallbackName: string): DaemonScanSnapshot['agents'][number] | null {
  if (!existsSync(path)) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  const command = typeof parsed.command === 'string' ? parsed.command : undefined;
  if (!command) {
    return null;
  }
  const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined;
  return {
    name: sanitizeAgentName(typeof parsed.name === 'string' ? parsed.name : fallbackName),
    adapterKind: readAdapterKind(parsed.adapterKind),
    category: readAgentCategory(parsed.category),
    command,
    args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
    cwd,
    discoverySource: 'filesystem',
    // 本地定义的自定义 Agent：同样扫描 cwd 的 AGENTS.md/CLAUDE.md 作为能力事实层。
    descriptor: cwd ? scanAgentDescriptor(cwd) : null,
  };
}

function sanitizeAgentName(value: string): string {
  return value.replace(/\s+/g, '-');
}

function readAdapterKind(value: unknown): string {
  return typeof value === 'string' && ['codex', 'claude-code', 'gemini', 'kimi-cli', 'hermes', 'openclaw'].includes(value)
    ? value
    : 'codex';
}

function readAgentCategory(value: unknown): DaemonScanSnapshot['agents'][number]['category'] {
  return value === 'agentos-hosted' ? 'agentos-hosted' : 'executor-hosted';
}

function defaultLocalAgentsDir(home: string): string {
  return join(home, '.agentbean', 'agents');
}

function runScannerCommand(options: BuiltinScannerOptions, command: string, args: string[]): Promise<string> {
  if (options.runCommand) {
    return options.runCommand(command, args);
  }
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: 10_000 }, (_error, stdout) => {
      resolve(stdout?.trim() ?? '');
    });
    child.on('error', () => resolve(''));
  });
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && isExecutable(path);
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

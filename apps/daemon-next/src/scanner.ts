import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DaemonScanProvider, DaemonScanSnapshot } from './index.js';

interface RuntimeSpec {
  bin: string;
  name: string;
  adapterKind: string;
  candidates?: string[];
}

export interface BuiltinScannerOptions {
  envPath?: string;
  homeDir?: string;
  findExecutable?: (bin: string, candidates: string[]) => Promise<string | null>;
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
  }

  return { runtimes, agents: [] };
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

function pathEntries(options: Pick<BuiltinScannerOptions, 'envPath' | 'homeDir'>): string[] {
  const home = options.homeDir ?? homedir();
  return [
    ...(options.envPath ?? process.env.PATH ?? '').split(':').filter(Boolean),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(home, '.local/bin'),
    join(home, '.bun/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.asdf/shims'),
    join(home, '.local/share/mise/shims'),
  ];
}

function claudeCandidates(home: string): string[] {
  return [
    join(home, '.local/share/claude-latest/current/claude'),
    join(home, '.local/share/claude/current/claude'),
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  ];
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

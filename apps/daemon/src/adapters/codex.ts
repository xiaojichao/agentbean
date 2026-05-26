import { spawn as spawnChild } from 'node:child_process';
import { spawn as spawnPty } from 'node-pty';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { CliAdapter, AskInput } from './adapter.js';

type RuntimeProcess = {
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
  kill(signal?: string): void;
};

export interface CodexAdapterOpts {
  command: string;
  args?: string[];
  cwd?: string;
  systemPrompt?: string;
}

function renderPayload(input: AskInput, systemPrompt?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`# system\n${systemPrompt}`);
  for (const turn of input.history) {
    parts.push(`# ${turn.role}: ${turn.speaker}\n${turn.body}`);
  }
  parts.push(`# user\n${input.prompt}`);
  return parts.join('\n\n');
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function removeEchoedPayload(output: string, payload?: string): string {
  if (!payload) return output;
  const normalizedPayload = payload.replace(/\r\n/g, '\n');
  const idx = output.lastIndexOf(normalizedPayload);
  if (idx < 0) return output;

  const boundaryBefore = idx === 0 || output[idx - 1] === '\n' || output[idx - 1] === '\r';
  if (!boundaryBefore) return output;
  const tail = output.slice(idx + normalizedPayload.length).trim();
  return tail || output;
}

export function extractCodexReply(output: string, payload?: string): string {
  const clean = removeEchoedPayload(stripAnsi(output).replace(/\r\n/g, '\n'), payload);
  // Match "codex" label followed by reply content, ending before next hook or end
  const match = clean.match(/(?:^|\n)codex\n([\s\S]*?)(?:\nhook:|$)/i);
  if (match) return match[1]!.trim();
  // Fallback: everything after last "user" prompt
  const userIdx = clean.lastIndexOf('\nuser\n');
  if (userIdx > 0) {
    const after = clean.slice(userIdx).split('\n').slice(2).join('\n').trim();
    if (after) return after;
  }
  return clean.trim();
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function flagValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    for (const flag of flags) {
      if (arg === flag) return args[i + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

function createOutputLastMessagePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentbean-codex-')), 'last-message.txt');
}

function normalizeExecArgs(args: string[] | undefined, outputLastMessagePath: string): { args: string[]; outputLastMessagePath?: string } {
  const baseArgs = args && args.length > 0 ? args : ['exec'];
  const subcommand = baseArgs[0];
  if (subcommand === 'exec' || subcommand === 'e') {
    const rest = baseArgs.slice(1);
    const normalized = [subcommand];
    if (!hasFlag(rest, '--skip-git-repo-check')) {
      normalized.push('--skip-git-repo-check');
    }
    const configuredOutputPath = flagValue(rest, '--output-last-message', '-o');
    if (!configuredOutputPath) {
      normalized.push('--output-last-message', outputLastMessagePath);
    }
    if (!hasFlag(rest, '--json', '--experimental-json')) {
      normalized.push('--json');
    }
    return {
      args: [...normalized, ...rest],
      outputLastMessagePath: configuredOutputPath ?? outputLastMessagePath,
    };
  }
  return { args: baseArgs };
}

function adapterTimeoutMs(): number {
  const fromEnv = Number.parseInt(process.env.AGENTBEAN_CODEX_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 900_000;
}

function buildRuntimeEnv(extra?: Record<string, string>): { [key: string]: string } {
  const pathEntries = [
    process.env.PATH,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
    join(homedir(), '.bun/bin'),
    join(homedir(), '.npm-global/bin'),
    join(homedir(), '.asdf/shims'),
    join(homedir(), '.local/share/mise/shims'),
  ].filter(Boolean).join(':');
  return { ...(process.env as { [key: string]: string }), PATH: pathEntries, ...(extra ?? {}) };
}

function assertExecutable(command: string, env: { [key: string]: string }, label: string): void {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error(`${label} command is empty`);
  }
  if (trimmed.includes('/')) {
    try {
      accessSync(trimmed, constants.X_OK);
      return;
    } catch {
      throw new Error(`${label} command is not executable: ${trimmed}`);
    }
  }

  const pathEntries = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    try {
      accessSync(join(dir, trimmed), constants.X_OK);
      return;
    } catch {}
  }
  throw new Error(`${label} command was not found on PATH: ${trimmed}. PATH=${env.PATH ?? ''}`);
}

function readOutputLastMessage(path?: string): string | null {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  return text || null;
}

function spawnRuntimeProcess(command: string, args: string[], opts: { cwd: string; env: { [key: string]: string } }): RuntimeProcess {
  try {
    const pty = spawnPty(command, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: opts.cwd,
      env: opts.env,
    });
    return {
      onData: (cb) => pty.onData(cb),
      onExit: (cb) => pty.onExit(({ exitCode }) => cb({ exitCode })),
      kill: (signal) => pty.kill(signal),
    };
  } catch (err) {
    const child = spawnChild(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const dataHandlers: Array<(data: string) => void> = [];
    const exitHandlers: Array<(event: { exitCode: number }) => void> = [];
    let exited = false;

    const emitExit = (exitCode: number) => {
      if (exited) return;
      exited = true;
      for (const handler of exitHandlers) handler({ exitCode });
    };

    child.stdout?.on('data', (data) => {
      for (const handler of dataHandlers) handler(String(data));
    });
    child.stderr?.on('data', (data) => {
      for (const handler of dataHandlers) handler(String(data));
    });
    child.on('error', (childErr) => {
      const message = childErr instanceof Error ? childErr.message : String(childErr);
      for (const handler of dataHandlers) handler(message);
      emitExit(1);
    });
    child.on('exit', (code) => emitExit(code ?? 1));

    return {
      onData: (cb) => { dataHandlers.push(cb); },
      onExit: (cb) => { exitHandlers.push(cb); },
      kill: (signal) => { child.kill(signal as NodeJS.Signals | undefined); },
    };
  }
}

export class CodexAdapter implements CliAdapter {
  readonly kind = 'codex' as const;
  constructor(private readonly opts: CodexAdapterOpts) {}

  async ask(input: AskInput, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const payload = renderPayload(input, this.opts.systemPrompt ?? input.systemPrompt);
      const cwd = input.workspace ?? this.opts.cwd ?? process.cwd();
      const baseCommand = this.opts.command || 'codex';
      const defaultOutputLastMessagePath = createOutputLastMessagePath();
      const normalizedExec = normalizeExecArgs(this.opts.args, defaultOutputLastMessagePath);
      const configuredArgs = normalizedExec.args;
      const baseArgs = [...configuredArgs, payload];
      const command = input.sandboxProfilePath ? 'sandbox-exec' : baseCommand;
      const args = input.sandboxProfilePath
        ? ['-f', input.sandboxProfilePath, '--', baseCommand, ...baseArgs]
        : baseArgs;
      const env = buildRuntimeEnv(input.env);

      try {
        assertExecutable(command, env, input.sandboxProfilePath ? 'Sandbox launcher' : 'Codex runtime');
        if (input.sandboxProfilePath) {
          assertExecutable(baseCommand, env, 'Codex runtime');
        }
      } catch (err) {
        reject(err);
        return;
      }

      const pty = spawnRuntimeProcess(command, args, { cwd, env });

      const chunks: string[] = [];
      let finished = false;
      const MAX_EXEC_MS = adapterTimeoutMs();

      const onAbort = () => {
        if (finished) return;
        finished = true;
        clearTimeout(maxTimer);
        signal.removeEventListener('abort', onAbort);
        pty.kill('SIGTERM');
        setTimeout(() => {
          try { pty.kill('SIGKILL'); } catch {}
        }, 2_000).unref();
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort);
      const maxTimer = setTimeout(() => {
        if (finished) return;
        finished = true;
        pty.kill('SIGKILL');
        signal.removeEventListener('abort', onAbort);
        reject(new Error('codex adapter timeout'));
      }, MAX_EXEC_MS).unref();

      pty.onData((data: string) => chunks.push(data));

      pty.onExit(({ exitCode }) => {
        clearTimeout(maxTimer);
        signal.removeEventListener('abort', onAbort);
        if (finished) return;
        finished = true;
        if (signal.aborted) return reject(new Error('aborted'));
        const raw = chunks.join('');
        if (exitCode !== 0) {
          const detail = stripAnsi(raw).trim();
          return reject(new Error(detail ? `codex exit ${exitCode}: ${detail}` : `codex exit ${exitCode}`));
        }
        const reply = readOutputLastMessage(normalizedExec.outputLastMessagePath) ?? extractCodexReply(raw, payload);
        resolve(reply || '(Codex 已完成处理)');
      });
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      try {
        const pty = spawnPty('bash', ['-c', 'codex --version'], {
          name: 'xterm-color', cols: 80, rows: 30,
          cwd: this.opts.cwd ?? process.cwd(),
          env: buildRuntimeEnv(),
        });
        pty.onExit(({ exitCode }) => resolve({ ok: exitCode === 0, detail: exitCode === 0 ? undefined : `exit ${exitCode}` }));
      } catch (err: any) {
        resolve({ ok: false, detail: err.message });
      }
    });
  }
}

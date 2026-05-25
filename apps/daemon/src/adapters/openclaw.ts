import { spawn } from 'node:child_process';
import type { CliAdapter, AskInput } from './adapter.js';

export interface OpenClawAdapterOpts {
  command: string;
  args?: string[];
  cwd?: string;
  systemPrompt?: string;
}

function runtimeArgs(args: string[] = []): string[] {
  if (args[0] === 'gateway' && args[1] === 'run') {
    return args.slice(2);
  }
  return args;
}

function hasMessageFlag(args: string[]): boolean {
  return args.includes('--message') || args.includes('-m');
}

function hasTargetSelector(args: string[]): boolean {
  return args.includes('--agent')
    || args.includes('--session-id')
    || args.includes('--session-key')
    || args.includes('--to')
    || args.includes('-t');
}

function ensureTargetSelector(args: string[]): string[] {
  if (hasTargetSelector(args)) return args;
  const messageIdx = args.findIndex((arg) => arg === '--message' || arg === '-m');
  if (messageIdx >= 0) {
    return [
      ...args.slice(0, messageIdx),
      '--agent',
      'main',
      ...args.slice(messageIdx),
    ];
  }
  return [...args, '--agent', 'main'];
}

function buildArgs(baseArgs: string[], prompt: string): string[] {
  // Current OpenClaw one-shot agent turns require an explicit session selector.
  // Preserve explicit custom args when the message flag is already configured.
  const agentArgs = baseArgs.includes('agent')
    ? ensureTargetSelector(baseArgs)
    : [...baseArgs, 'agent', '--agent', 'main'];
  if (hasMessageFlag(agentArgs)) {
    return [...agentArgs, prompt];
  }
  return [...agentArgs, '--message', prompt];
}

function buildPrompt(input: AskInput, systemPrompt?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(systemPrompt);
  for (const h of input.history.slice(-10)) {
    parts.push(`${h.speaker} (${h.role}): ${h.body}`);
  }
  parts.push(input.prompt);
  return parts.join('\n\n---\n\n');
}

export class OpenClawAdapter implements CliAdapter {
  readonly kind = 'openclaw' as const;
  constructor(private readonly opts: OpenClawAdapterOpts) {}

  async ask(input: AskInput, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const prompt = buildPrompt(input, this.opts.systemPrompt ?? input.systemPrompt);
      const cwd = input.workspace ?? this.opts.cwd ?? process.cwd();
      const child = spawn(this.opts.command, buildArgs(runtimeArgs(this.opts.args), prompt), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(input.env ?? {}) },
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let finished = false;
      const MAX_EXEC_MS = 600_000;

      const onAbort = () => {
        if (finished) return;
        finished = true;
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2_000).unref();
      };
      signal.addEventListener('abort', onAbort);
      const maxTimer = setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill('SIGKILL');
        signal.removeEventListener('abort', onAbort);
        reject(new Error('openclaw adapter timeout'));
      }, MAX_EXEC_MS).unref();

      child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
      child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));

      child.on('error', (err) => {
        clearTimeout(maxTimer);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(maxTimer);
        signal.removeEventListener('abort', onAbort);
        if (finished) return;
        finished = true;
        if (signal.aborted) return reject(new Error('aborted'));
        const out = Buffer.concat(stdoutChunks).toString('utf8');
        const err = Buffer.concat(stderrChunks).toString('utf8');
        const stdout = out.trim();
        const stderr = err.trim();
        if (code !== 0 && stdout.length === 0) {
          const detail = stderr.length > 0 ? stderr.slice(0, 400) : 'no stderr';
          return reject(new Error(`openclaw exit ${code}: ${detail}`));
        }
        const reply = stdout || stderr;
        if (!reply) {
          return reject(new Error('openclaw produced empty output'));
        }
        resolve(reply);
      });
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.command, ['--version'], { stdio: 'ignore' });
      child.on('error', (err) => resolve({ ok: false, detail: err.message }));
      child.on('exit', (code) => resolve({ ok: code === 0, detail: code === 0 ? undefined : `exit ${code}` }));
    });
  }
}

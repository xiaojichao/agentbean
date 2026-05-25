import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CliAdapter, AskInput } from './adapter.js';

export interface ClaudeCodeAdapterOpts {
  command: string;
  args?: string[];
  cwd?: string;
  systemPrompt?: string;
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

function normalizeClaudeArgs(args?: string[]): string[] {
  const filtered = (args ?? []).filter((arg) => arg !== '--bare');
  return ['-p', ...filtered];
}

export class ClaudeCodeAdapter implements CliAdapter {
  readonly kind = 'claude-code' as const;
  constructor(private readonly opts: ClaudeCodeAdapterOpts) {}

  async ask(input: AskInput, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const prompt = buildPrompt(input, this.opts.systemPrompt ?? input.systemPrompt);
      const cwd = input.workspace ?? this.opts.cwd ?? process.cwd();
      const baseArgs = normalizeClaudeArgs(this.opts.args);
      if (input.workspace) baseArgs.push('--add-dir', input.workspace);
      baseArgs.push('--add-dir', join(homedir(), '.codex', 'generated_images'));
      const command = input.sandboxProfilePath ? 'sandbox-exec' : this.opts.command;
      const args = input.sandboxProfilePath
        ? ['-f', input.sandboxProfilePath, '--', this.opts.command, ...baseArgs]
        : baseArgs;

      const child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(input.env ?? {}) },
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const MAX_EXEC_MS = 600_000;

      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      };
      signal.addEventListener('abort', onAbort);
      const maxTimer = setTimeout(() => {
        child.kill('SIGKILL');
        signal.removeEventListener('abort', onAbort);
        reject(new Error('claude-code adapter timeout'));
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
        if (signal.aborted) return reject(new Error('aborted'));
        const out = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const err = Buffer.concat(stderrChunks).toString('utf8').trim();
        if (code !== 0 && out.length === 0) {
          return reject(new Error(`claude-code exit ${code}: ${err.slice(0, 200)}`));
        }
        resolve(out);
      });
      child.stdin.write(prompt);
      child.stdin.end();
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

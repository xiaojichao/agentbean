import { spawn } from 'node:child_process';
import type { CliAdapter, AskInput } from './adapter.js';

export interface HermesAdapterOpts {
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

export class HermesAdapter implements CliAdapter {
  readonly kind = 'hermes' as const;
  constructor(private readonly opts: HermesAdapterOpts) {}

  async ask(input: AskInput, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const prompt = buildPrompt(input, this.opts.systemPrompt ?? input.systemPrompt);
      const cwd = input.workspace ?? this.opts.cwd ?? process.cwd();
      const child = spawn(this.opts.command, ['-z', prompt, ...(this.opts.args ?? [])], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
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
        reject(new Error('hermes adapter timeout'));
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
        if (code !== 0 && out.length === 0) {
          return reject(new Error(`hermes exit ${code}: ${err.slice(0, 400)}`));
        }
        resolve(out.trim() || err.trim());
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

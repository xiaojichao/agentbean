import { spawn } from 'node:child_process';
import type { CliAdapter, AskInput } from './adapter.js';

export interface OpenClawAdapterOpts {
  command: string;
  args?: string[];
  cwd?: string;
  systemPrompt?: string;
}

interface OpenClawReply {
  reply?: string;
  error?: string;
}

export class OpenClawAdapter implements CliAdapter {
  readonly kind = 'openclaw' as const;
  constructor(private readonly opts: OpenClawAdapterOpts) {}

  async ask(input: AskInput, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const payload = JSON.stringify({
        system: this.opts.systemPrompt ?? input.systemPrompt,
        history: input.history.slice(-10),
        user: input.prompt,
      });

      const child = spawn(this.opts.command, this.opts.args ?? [], {
        cwd: this.opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
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
        reject(new Error('openclaw adapter timeout'));
      }, MAX_EXEC_MS).unref();

      child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
      child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));
      child.stdin.end(payload);

      child.on('error', (err) => {
        clearTimeout(maxTimer);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(maxTimer);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return reject(new Error('aborted'));
        const out = Buffer.concat(stdoutChunks).toString('utf8');
        const err = Buffer.concat(stderrChunks).toString('utf8');
        if (code !== 0) {
          return reject(new Error(`openclaw exit ${code}: ${err.slice(0, 400)}`));
        }
        let parsed: OpenClawReply;
        try {
          parsed = JSON.parse(out);
        } catch {
          return reject(new Error(`openclaw produced non-JSON output: ${out.slice(0, 200)}`));
        }
        if (parsed.error) return reject(new Error(parsed.error));
        resolve((parsed.reply ?? '').trim());
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

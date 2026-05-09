import { spawn } from 'node-pty';
import type { CliAdapter, AskInput } from './adapter.js';

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

function extractReply(output: string): string {
  const clean = stripAnsi(output).replace(/\r\n/g, '\n');
  // Match "codex" label followed by reply content, ending before next hook or end
  const match = clean.match(/\ncodex\n([\s\S]*?)(?:\nhook:|$)/i);
  if (match) return match[1]!.trim();
  // Fallback: everything after last "user" prompt
  const userIdx = clean.lastIndexOf('\nuser\n');
  if (userIdx > 0) {
    const after = clean.slice(userIdx).split('\n').slice(2).join('\n').trim();
    if (after) return after;
  }
  return clean.trim();
}

export class CodexAdapter implements CliAdapter {
  readonly kind = 'codex' as const;
  constructor(private readonly opts: CodexAdapterOpts) {}

  async ask(input: AskInput, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const payload = renderPayload(input, this.opts.systemPrompt ?? input.systemPrompt);
      const cwd = input.workspace ?? this.opts.cwd ?? process.cwd();
      const baseCommand = this.opts.command || 'codex';
      const baseArgs = [...(this.opts.args ?? ['exec']), payload];
      const command = input.sandboxProfilePath ? 'sandbox-exec' : baseCommand;
      const args = input.sandboxProfilePath
        ? ['-f', input.sandboxProfilePath, '--', baseCommand, ...baseArgs]
        : baseArgs;

      const pty = spawn(command, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd,
        env: process.env as { [key: string]: string },
      });

      const chunks: string[] = [];
      let finished = false;
      const MAX_EXEC_MS = 600_000;

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
        if (exitCode !== 0 && raw.length === 0) {
          return reject(new Error(`codex exit ${exitCode}`));
        }
        const reply = extractReply(raw);
        resolve(reply || '(Codex 已完成处理)');
      });
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      try {
        const pty = spawn('bash', ['-c', 'codex --version'], {
          name: 'xterm-color', cols: 80, rows: 30,
          cwd: this.opts.cwd ?? process.cwd(),
          env: process.env as { [key: string]: string },
        });
        pty.onExit(({ exitCode }) => resolve({ ok: exitCode === 0, detail: exitCode === 0 ? undefined : `exit ${exitCode}` }));
      } catch (err: any) {
        resolve({ ok: false, detail: err.message });
      }
    });
  }
}

import { spawn } from 'node:child_process';
import type { CliAdapter, AskInput } from './adapter.js';

export interface HermesAdapterOpts {
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

function buildArgs(baseArgs: string[], prompt: string): string[] {
  // If user already configured args with chat -q, just append the prompt
  // Otherwise default to: hermes chat -q "<prompt>"
  const hasChat = baseArgs.includes('chat');
  const hasQ = baseArgs.includes('-q');
  if (hasChat && hasQ) {
    return [...baseArgs, prompt];
  }
  return [...baseArgs, 'chat', '-q', prompt];
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

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const BOX_ONLY_RE = /^[\s─━═╭╮╰╯│┃┌┐└┘├┤┬┴┼]+$/;

export function extractHermesReply(output: string): string {
  const lines = output
    .replace(ANSI_RE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const cleaned = lines
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.startsWith('Query:')) return false;
      if (trimmed === 'Initializing agent...' || trimmed === 'Initializing agent…') return false;
      if (trimmed.startsWith('Resume this session with:')) return false;
      if (/^hermes\s+--resume\b/.test(trimmed)) return false;
      if (/^(Session|Duration|Messages):\s+/.test(trimmed)) return false;
      if (trimmed.startsWith('╭') || trimmed.startsWith('╰')) return false;
      if (BOX_ONLY_RE.test(trimmed)) return false;
      return true;
    })
    .map((line) => line.replace(/^[│┃]\s?/, '').replace(/\s?[│┃]$/, '').replace(/^\s{2,}/, ''))
    .join('\n')
    .trim();

  return cleaned || output.trim();
}

export class HermesAdapter implements CliAdapter {
  readonly kind = 'hermes' as const;
  constructor(private readonly opts: HermesAdapterOpts) {}

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
        const stdout = out.trim();
        const stderr = err.trim();
        if (code !== 0 && stdout.length === 0) {
          const detail = stderr.length > 0 ? stderr.slice(0, 400) : 'no stderr';
          return reject(new Error(`hermes exit ${code}: ${detail}`));
        }
        const reply = extractHermesReply(stdout || stderr);
        if (!reply) {
          return reject(new Error('hermes produced empty output'));
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

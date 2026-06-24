// codex PTY executor for daemon-next.
//
// codex is an interactive TUI CLI: it cannot take its prompt via a closed stdin pipe (the generic
// executor path) — feeding stdin and closing it makes codex print a banner and exit 0 without
// running the query (silent failure). codex instead wants the prompt as a trailing argv
// positional, run under a PTY, in `exec` one-shot mode that writes the final reply to a file via
// `--output-last-message` (parsed as JSON via `--json`). This module owns that contract.
//
// node-pty is loaded lazily (see defaultPtySpawnLoader): it is an optional dependency so the daemon
// still boots and every other agent path works on platforms where node-pty has no usable native
// binary (notably the daemon-next CI, which installs with `--ignore-scripts` on Linux — no prebuilt,
// compilation skipped). When node-pty is unavailable, codex dispatch returns an explicit error
// rather than silently succeeding. Logic ported from apps/daemon/src/adapters/codex.ts.

import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterKind } from '../../../packages/contracts/src/index.js';
import type { DaemonDispatchResult, DispatchRequestPayload } from './index.js';
import { buildChildEnv, buildLogArtifactContent, buildLogExcerpt, formatCommand } from './executor-helpers.js';

// node-pty is loaded via createRequire (see defaultPtySpawnLoader), NOT a typed import, so tsc
// never resolves the module: its types are absent in the CI install (daemon-next tests run against
// apps/server's node_modules, which has no node-pty) and a typed import would also duplicate the
// real package's bundled types where node-pty is hoisted locally.

// ── codex argv normalization ──────────────────────────────────────────────────

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

// Normalize codex argv into a one-shot `exec` invocation: default to `exec`, force
// `--skip-git-repo-check`, ensure `--output-last-message <path>` (so the reply is recoverable from
// a file regardless of PTY noise), and force `--json`. User-supplied flags are honoured (not
// duplicated); the caller-provided outputPath is used only when the user did not configure one.
export function normalizeCodexExecArgs(
  args: string[] | undefined,
  outputLastMessagePath: string,
): { args: string[]; outputLastMessagePath?: string } {
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

// ── codex reply extraction ────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// A PTY echoes the typed payload (the joined prompt) back into the output stream before codex's
// reply. Strip that echo so it does not leak into the extracted reply. The match requires a line
// boundary before the payload to avoid removing a substring that merely coincides with it.
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

// Best-effort extraction of codex's reply from raw PTY output (ANSI + echoed payload + TUI noise).
// Preferred source is the --output-last-message file (readOutputLastMessage); this is the fallback
// when no file is available. Match the "codex" label's content first, then the tail after the last
// "user" marker, then the whole cleaned output.
export function extractCodexReply(output: string, payload?: string): string {
  const clean = removeEchoedPayload(stripAnsi(output).replace(/\r\n/g, '\n'), payload);
  const match = clean.match(/(?:^|\n)codex\n([\s\S]*?)(?:\nhook:|$)/i);
  if (match) return match[1]!.trim();
  const userIdx = clean.lastIndexOf('\nuser\n');
  if (userIdx > 0) {
    const after = clean.slice(userIdx).split('\n').slice(2).join('\n').trim();
    if (after) return after;
  }
  return clean.trim();
}

// ── codex payload rendering ───────────────────────────────────────────────────

// Render the prompt codex receives as a trailing argv positional. codex's reply parser and the
// echoed-payload stripping both key off these `# role` markers, so the format is part of the
// contract, not cosmetic. Mirrors buildAdapterPrompt's "last 10 turns" context window.
export function renderCodexPayload(input: {
  prompt: string;
  history?: ReadonlyArray<{ senderKind: string; body: string }>;
}): string {
  const parts: string[] = [];
  const history = input.history ?? [];
  for (const turn of history.slice(-10)) {
    const role = turn.senderKind === 'agent' ? 'assistant' : 'user';
    parts.push(`# ${role}\n${turn.body}`);
  }
  parts.push(`# user\n${input.prompt}`);
  return parts.join('\n\n');
}

// ── PTY runtime ───────────────────────────────────────────────────────────────

export interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type PtySpawnFn = (command: string, args: string[], options: PtySpawnOptions) => PtyProcess;

export interface PtyAdapterSpec {
  normalizeArgs: (baseArgs: string[], outputPath: string) => { args: string[]; outputLastMessagePath?: string };
  renderPayload: (input: { prompt: string; history?: ReadonlyArray<{ senderKind: string; body: string }> }) => string;
  extractReply: (ptyOutput: string, payload: string) => string;
  redactCommandArgs?: (args: string[]) => string[];
  timeoutMs?: number;
}

export interface RunPtyOptions {
  timeoutMs: number;
  killGraceMs: number;
  maxAccumulatedBytes: number;
  clock: { now(): number };
}

function createOutputLastMessagePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentbean-codex-')), 'last-message.txt');
}

function readOutputLastMessage(path?: string): string | null {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  return text || null;
}

const CODEX_PROMPT_PLACEHOLDER = '[prompt elided]';

// The payload is always the trailing positional appended in runPtyAgentCommand, so redaction is a
// simple tail swap — the prompt must never appear in the persisted workspace-run command.
function redactCodexArgs(args: string[]): string[] {
  if (args.length === 0) return args;
  return [...args.slice(0, -1), CODEX_PROMPT_PLACEHOLDER];
}

const requireNative = createRequire(import.meta.url);

// node-pty issue #850: the darwin spawn-helper binary ships in the npm tarball without the execute
// bit (mode 644), so the first posix_spawnp fails. Patch it at runtime before loading — this is
// the one native-module wart the lazy-import path has to paper over. Best-effort: if we cannot
// locate/patch it, the subsequent spawn surfaces an explicit failure.
function ensureSpawnHelperExecutable(): void {
  try {
    const ptyRoot = dirname(requireNative.resolve('node-pty/package.json'));
    const platformDir = join('prebuilds', `${process.platform}-${process.arch}`);
    const candidates = [
      join(ptyRoot, platformDir, 'spawn-helper'),
      join(ptyRoot, 'build', 'Release', 'spawn-helper'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try { chmodSync(candidate, 0o755); } catch { /* ignore */ }
      }
    }
  } catch {
    // node-pty not resolvable here — the require below will throw and be handled.
  }
}

// Lazily load node-pty and adapt its spawn to the PtySpawnFn shape. Loaded via require (not a
// typed import) so tsc never resolves node-pty's module — see the note above the imports. Throws
// when node-pty is missing or has no usable native binary; runPtyAgentCommand turns that into an
// explicit failure result.
export const defaultPtySpawnLoader = async (): Promise<PtySpawnFn> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
  const spawnPty: any = requireNative('node-pty').spawn;
  ensureSpawnHelperExecutable();
  return (command, args, options) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pty: any = spawnPty(command, args, {
      name: 'xterm-color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env: options.env,
    });
    return pty as unknown as PtyProcess;
  };
};

// Run a PTY-backed agent (codex). Mirrors the pipe executor's safety spine — SIGTERM→grace→SIGKILL,
// accumulated-byte cap, redacted log artifact, secrets-scoped env — while adapting to the PTY's
// single onData stream (no stderr separation) and the codex file-based reply contract.
export async function runPtyAgentCommand(
  request: DispatchRequestPayload,
  spec: PtyAdapterSpec,
  ptySpawnLoader: () => Promise<PtySpawnFn>,
  options: RunPtyOptions,
): Promise<DaemonDispatchResult> {
  const customAgent = request.customAgent;
  if (!customAgent?.command) {
    throw new Error('PTY adapter requires customAgent.command');
  }
  const startedAt = options.clock.now();
  const outputPath = createOutputLastMessagePath();
  const payload = spec.renderPayload(request);
  const normalized = spec.normalizeArgs(customAgent.args ?? [], outputPath);
  const args = [...normalized.args, payload];
  const cwd = customAgent.cwd;
  const persistedCommand = formatCommand(
    customAgent.command,
    spec.redactCommandArgs ? spec.redactCommandArgs(args) : args,
  );

  let spawn: PtySpawnFn;
  try {
    spawn = await ptySpawnLoader();
  } catch (err) {
    // No run happened, but the temp output dir was already created — clean it up so a node-pty-less
    // host does not leak a /tmp/agentbean-codex-* dir on every codex dispatch.
    try { rmSync(dirname(outputPath), { recursive: true, force: true }); } catch { /* ignore */ }
    const detail = err instanceof Error ? err.message : String(err);
    return ptyFailure(request, persistedCommand, startedAt, options.clock.now(),
      `Codex 需要 PTY 运行时(node-pty)，当前环境不可用：${detail}`, '');
  }

  return new Promise<DaemonDispatchResult>((resolve) => {
    let output = '';
    let bytes = 0;
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;

    let pty: PtyProcess;
    try {
      pty = spawn(customAgent.command as string, args, {
        cwd,
        env: buildChildEnv(process.env, customAgent.env ?? undefined),
        cols: 80,
        rows: 30,
      });
    } catch (err) {
      try { rmSync(dirname(outputPath), { recursive: true, force: true }); } catch { /* ignore */ }
      const detail = err instanceof Error ? err.message : String(err);
      resolve(ptyFailure(request, persistedCommand, startedAt, options.clock.now(),
        `codex PTY 启动失败：${detail}`, output));
      return;
    }

    const timeoutMs = spec.timeoutMs ?? options.timeoutMs;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { pty.kill('SIGTERM'); } catch { /* already exited */ }
      killTimer = setTimeout(() => { try { pty.kill('SIGKILL'); } catch { /* ignore */ } }, options.killGraceMs);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      resolve(ptyFailure(request, persistedCommand, startedAt, options.clock.now(),
        `codex 超时（${timeoutMs}ms）`, output));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    pty.onData((data) => {
      output += data;
      bytes += Buffer.byteLength(data);
      // Cap accumulation to protect the daemon from a looping/malicious child.
      if (bytes > options.maxAccumulatedBytes) {
        try { pty.kill('SIGKILL'); } catch { /* ignore */ }
      }
    });

    pty.onExit(({ exitCode }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const completedAt = options.clock.now();
      // Read the reply file BEFORE cleaning up the temp dir it lives in.
      const fileReply = readOutputLastMessage(normalized.outputLastMessagePath);
      // Clean up the temp output dir regardless of outcome.
      try { rmSync(dirname(outputPath), { recursive: true, force: true }); } catch { /* ignore */ }
      const body = exitCode === 0
        ? (fileReply ?? (spec.extractReply(output, payload) || '(Codex 已完成处理)'))
        : `codex exit ${exitCode}: ${stripAnsi(output).trim().slice(0, 2000) || '(无输出)'}`;

      resolve({
        body,
        artifacts: [logArtifact(request.id, output)],
        workspaceRun: {
          status: exitCode === 0 ? 'succeeded' : 'failed',
          cwd,
          command: persistedCommand,
          exitCode,
          startedAt,
          completedAt,
          logExcerpt: buildLogExcerpt(output, ''),
        },
      });
    });
  });
}

function logArtifact(requestId: string, output: string): DaemonDispatchResult['artifacts'] extends (infer U)[] | undefined ? U : never {
  return {
    id: `workspace-log-${requestId}`,
    filename: 'workspace-run.log',
    mimeType: 'text/plain',
    relativePath: 'logs/workspace-run.log',
    pathKind: 'workspace',
    contentBase64: Buffer.from(buildLogArtifactContent(output, ''), 'utf8').toString('base64'),
  };
}

function ptyFailure(
  request: DispatchRequestPayload,
  command: string,
  startedAt: number,
  completedAt: number,
  body: string,
  output: string,
): DaemonDispatchResult {
  return {
    body,
    artifacts: output ? [logArtifact(request.id, output)] : [],
    workspaceRun: {
      status: 'failed',
      command,
      exitCode: 1,
      startedAt,
      completedAt,
      logExcerpt: buildLogExcerpt(output, ''),
    },
  };
}

// PTY-backed agent invocation contracts. Symmetric to ARGV_MODE_ADAPTERS (pipe path) in
// executor.ts: codex is the only member today; future PTY agents register here.
export const PTY_ADAPTERS: Partial<Record<AdapterKind, PtyAdapterSpec>> = {
  codex: {
    normalizeArgs: normalizeCodexExecArgs,
    renderPayload: renderCodexPayload,
    extractReply: extractCodexReply,
    redactCommandArgs: redactCodexArgs,
    timeoutMs: 900_000,
  },
};

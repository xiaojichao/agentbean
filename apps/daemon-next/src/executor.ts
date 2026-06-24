import { spawn } from 'node:child_process';
import type { AdapterKind } from '../../../packages/contracts/src/index.js';
import type { DaemonDispatchResult, DispatchRequestPayload, StubExecutor } from './index.js';
import { buildChildEnv, buildLogArtifactContent, buildLogExcerpt, formatCommand } from './executor-helpers.js';
import { PTY_ADAPTERS, defaultPtySpawnLoader, runPtyAgentCommand } from './executor-pty.js';
import type { PtySpawnFn } from './executor-pty.js';

export { buildChildEnv };

export interface CommandExecutorOptions {
  fallbackPrefix?: string;
  timeoutMs?: number;
  /** Grace period (ms) between SIGTERM and the follow-up SIGKILL when a command times out. */
  killGraceMs?: number;
  /** Max combined stdout+stderr bytes buffered in memory before the command is force-killed. */
  maxAccumulatedBytes?: number;
  clock?: { now(): number };
  /**
   * Loader for the PTY spawner used by PTY-backed agents (codex). Defaults to a lazy import of
   * node-pty. Inject a fake in tests so they never touch the real native module.
   */
  ptySpawnLoader?: () => Promise<PtySpawnFn>;
}

// Trust model: the daemon executes whatever command the authenticated server-next dispatches
// via customAgent.command. daemon trusts server-next — authorizing/validating the command is the
// server's responsibility. buildChildEnv (in ./executor-helpers.js) is the hard boundary on this
// side: the host environment (e.g. secrets exported in ~/.zshrc) must NOT leak into the child,
// because the child's stdout/stderr (and PTY output) are captured and uploaded as downloadable log
// artifacts.

export function createCommandExecutor(options: CommandExecutorOptions = {}): StubExecutor {
  const fallbackPrefix = options.fallbackPrefix ?? 'daemon-next:';
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const killGraceMs = options.killGraceMs ?? 5000;
  const maxAccumulatedBytes = options.maxAccumulatedBytes ?? 8 * 1024 * 1024;
  const clock = options.clock ?? { now: () => Date.now() };
  const ptySpawnLoader = options.ptySpawnLoader ?? defaultPtySpawnLoader;

  return async (request) => {
    if (!request.customAgent?.command) {
      return `${fallbackPrefix}${request.prompt}`;
    }
    return runCustomAgentCommand(request, { timeoutMs, killGraceMs, maxAccumulatedBytes, clock, ptySpawnLoader });
  };
}

interface RunOptions {
  timeoutMs: number;
  killGraceMs: number;
  maxAccumulatedBytes: number;
  clock: { now(): number };
  ptySpawnLoader: () => Promise<PtySpawnFn>;
}

async function runCustomAgentCommand(
  request: DispatchRequestPayload,
  options: RunOptions,
): Promise<DaemonDispatchResult> {
  const customAgent = request.customAgent;
  if (!customAgent?.command) {
    throw new Error('custom agent command is required');
  }

  // PTY-backed agents (codex) cannot use the pipe spine — they need a real TTY. Delegate before
  // touching stdin or consuming the clock so the PTY path manages its own lifecycle.
  const ptySpec = customAgent.adapterKind ? PTY_ADAPTERS[customAgent.adapterKind as AdapterKind] : undefined;
  if (ptySpec) {
    return runPtyAgentCommand(request, ptySpec, options.ptySpawnLoader, options);
  }

  // Some agents are interactive TUIs/REPLs by default: feeding the prompt via stdin and closing
  // the pipe makes them echo the input then exit on EOF (Hermes prints "Goodbye!") without ever
  // running the query. Such agents expose a one-shot mode that carries the prompt on argv
  // instead (Hermes: `chat -Q -q`, OpenClaw: `agent --agent <id> --message`). ARGV_MODE_ADAPTERS
  // registers each agent's invocation contract; registered agents either put the prompt (plus
  // joined history) on argv or keep it on stdin while adding non-interactive flags.
  // Unregistered agents (codex, gemini, kimi-cli, …) keep the generic stdin contract.
  const adapter = customAgent.adapterKind ? ARGV_MODE_ADAPTERS[customAgent.adapterKind] : undefined;
  const argvMode = adapter !== undefined;
  // Adapters that read their prompt from stdin (e.g. claude-code -p) still want joined history,
  // so the payload is shared; whether it lands on argv or stdin is decided by promptOnStdin.
  const promptPayload = argvMode ? buildAdapterPrompt(request) : request.prompt;
  const promptOnStdin = argvMode && adapter.promptOnStdin === true;
  const finalArgs = argvMode
    ? adapter.buildArgs(customAgent.args ?? [], promptPayload)
    : customAgent.args ?? [];

  return new Promise((resolve, reject) => {
    const startedAt = options.clock.now();
    const child = spawn(customAgent.command as string, finalArgs, {
      cwd: customAgent.cwd,
      env: buildChildEnv(process.env, customAgent.env ?? undefined),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killTimer: NodeJS.Timeout | undefined;

    // SIGTERM first, then escalate to SIGKILL after a grace period so a child that traps/ignores
    // SIGTERM cannot run forever (which would also let stdout/stderr grow unbounded in memory).
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // child may have already exited
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, options.killGraceMs);
      if (typeof killTimer.unref === 'function') {
        killTimer.unref();
      }
      reject(new Error(`custom agent command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    const appendOutput = (kind: 'stdout' | 'stderr', chunk: string) => {
      if (kind === 'stdout') {
        stdout += chunk;
        stdoutBytes += Buffer.byteLength(chunk);
      } else {
        stderr += chunk;
        stderrBytes += Buffer.byteLength(chunk);
      }
      // Cap in-memory accumulation to protect the daemon from a malicious/looping child.
      if (stdoutBytes + stderrBytes > options.maxAccumulatedBytes) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => appendOutput('stdout', chunk));
    child.stdout.on('error', () => {
      // swallow stream errors (e.g. read after kill) so they don't crash the daemon
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => appendOutput('stderr', chunk));
    child.stderr.on('error', () => {
      // swallow
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      const completedAt = options.clock.now();
      const exitCode = code ?? 1;
      const command = formatCommand(
        customAgent.command as string,
        argvMode && adapter.redactCommandArgs ? adapter.redactCommandArgs(finalArgs) : finalArgs,
      );
      const logContent = buildLogArtifactContent(stdout, stderr);
      const body = argvMode && adapter.extractReply
        ? adapter.extractReply(stdout, code ?? null, stderr)
        : code === 0 ? stdout.trimEnd() : `custom agent command exited with code ${exitCode}`;
      resolve({
        body,
        artifacts: [
          {
            id: `workspace-log-${request.id}`,
            filename: 'workspace-run.log',
            mimeType: 'text/plain',
            relativePath: 'logs/workspace-run.log',
            pathKind: 'workspace',
            contentBase64: Buffer.from(logContent, 'utf8').toString('base64'),
          },
        ],
        workspaceRun: {
          status: code === 0 ? 'succeeded' : 'failed',
          cwd: customAgent.cwd,
          command,
          exitCode,
          startedAt,
          completedAt,
          logExcerpt: buildLogExcerpt(stdout, stderr),
        },
      });
    });

    // A missing/invalid prompt (e.g. an unvalidated cast at the caller) must surface as a clean
    // empty write rather than an opaque Node ERR_INVALID_ARG_TYPE via the stdin stream.
    if (child.stdin) {
      child.stdin.on('error', () => {
        // swallow
      });
      // Argv-mode agents carry the prompt on argv, so stdin stays empty — unless the adapter
      // opts into promptOnStdin (e.g. claude-code -p), in which case the joined-history payload
      // is written to stdin and argv only carries flags. Generic agents write the raw prompt.
      const stdinPayload = argvMode && !promptOnStdin
        ? ''
        : (typeof promptPayload === 'string' ? promptPayload : '');
      child.stdin.end(stdinPayload);
    }
  });
}

// ── Argv-mode adapter helpers ─────────────────────────────────────────────────
// daemon-next runs every agent through the same spawn+capture spine. Agents that cannot take
// their prompt via stdin (interactive TUIs/REPLs) register a one-shot argv contract in
// ARGV_MODE_ADAPTERS; the helpers below implement each contract (Hermes, OpenClaw, …).

function hermesRuntimeArgs(args: string[]): string[] {
  // A `gateway run` preamble selects the gateway-managed runtime; strip it so the chat subcommand
  // can be appended cleanly.
  if (args[0] === 'gateway' && args[1] === 'run') {
    return args.slice(2);
  }
  return args;
}

function buildHermesArgs(baseArgs: string[], prompt: string): string[] {
  const runtime = hermesRuntimeArgs(baseArgs);
  const hasChat = runtime.includes('chat');
  const hasQuery = runtime.includes('-q') || runtime.includes('--query');
  const hasQuiet = runtime.includes('-Q') || runtime.includes('--quiet');
  // Default scanner-supplied config (empty args) → a clean one-shot quiet query.
  if (!hasChat && !hasQuery) {
    return [...runtime, 'chat', '-Q', '-q', prompt];
  }
  // Operator already parameterised the chat subcommand: honour it, force quiet mode, and append
  // the prompt value (after a -q flag if none is present). -Q is inserted right after `chat` so
  // it can never become a stray -q value.
  let args = runtime;
  if (!hasQuiet) {
    const chatIdx = args.indexOf('chat');
    args = chatIdx >= 0
      ? [...args.slice(0, chatIdx + 1), '-Q', ...args.slice(chatIdx + 1)]
      : ['-Q', ...args];
  }
  return hasQuery ? replaceHermesQueryArg(args, prompt) : [...args, '-q', prompt];
}

function replaceHermesQueryArg(args: string[], prompt: string): string[] {
  const replaced: string[] = [];
  let queryWritten = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '-q' || arg === '--query') {
      if (!queryWritten) {
        replaced.push(arg, prompt);
        queryWritten = true;
      }
      const nextArg = args[index + 1];
      if (nextArg !== undefined && !nextArg.startsWith('-')) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--query=')) {
      if (!queryWritten) {
        replaced.push('--query', prompt);
        queryWritten = true;
      }
      continue;
    }
    replaced.push(arg);
  }
  return queryWritten ? replaced : [...replaced, '-q', prompt];
}

const HERMES_QUERY_PLACEHOLDER = '[query elided]';

function redactHermesCommandArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '-q' || arg === '--query') {
      redacted.push(arg, HERMES_QUERY_PLACEHOLDER);
      if (args[index + 1] !== undefined) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--query=')) {
      redacted.push('--query', HERMES_QUERY_PLACEHOLDER);
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

// Shared by all argv-mode adapters: join recent history (User/Assistant turns) ahead of the
// current prompt so single-shot invocations still carry conversational context.
function buildAdapterPrompt(request: DispatchRequestPayload): string {
  const history = request.history ?? [];
  if (history.length === 0) {
    return request.prompt;
  }
  const turns = history.slice(-10).map((message) => ({
    role: message.senderKind === 'agent' ? 'Assistant' : 'User',
    body: message.body,
  }));
  return [...turns.map((turn) => `${turn.role}: ${turn.body}`), `User: ${request.prompt}`].join('\n\n');
}

// Hermes' -Q quiet mode prints a few `key: value` session-metadata lines (session_id, etc.)
// before the reply; strip those so only the model's response reaches the user.
const HERMES_QUIET_META_LINE_RE = /^(session_id|session|duration|messages|model|provider|cost|tokens)[:：]/i;

function extractHermesReply(stdout: string, code: number | null, stderr: string): string {
  const reply = stdout
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !HERMES_QUIET_META_LINE_RE.test(trimmed);
    })
    .join('\n')
    .trim();
  if (reply) {
    return reply;
  }
  // Empty reply on a failed run: surface stderr / exit code so the user sees why (e.g. HTTP 429)
  // instead of a bare empty body.
  if (code !== 0) {
    const detail = stderr.trim();
    return detail ? detail.slice(0, 2000) : `custom agent command exited with code ${code ?? 1}`;
  }
  return stdout.trim();
}

function openclawRuntimeArgs(args: string[]): string[] {
  if (args[0] === 'gateway' && args[1] === 'run') {
    return args.slice(2);
  }
  return args;
}

function splitOpenClawRuntimeArgs(args: string[]): { prefix: string[]; runtime: string[] } {
  const first = args[0];
  if (first !== undefined && first !== 'agent' && !first.startsWith('-')) {
    return { prefix: [first], runtime: args.slice(1) };
  }
  return { prefix: [], runtime: args };
}

function isOpenClawTargetSelectorArg(arg: string): boolean {
  return arg === '--agent'
    || arg.startsWith('--agent=')
    || arg === '--session-id'
    || arg.startsWith('--session-id=')
    || arg === '--session-key'
    || arg.startsWith('--session-key=')
    || arg === '--to'
    || arg.startsWith('--to=')
    || arg === '-t';
}

function hasOpenClawTargetSelector(args: string[]): boolean {
  return args.some(isOpenClawTargetSelectorArg);
}

function isOpenClawMessageArg(arg: string): boolean {
  return arg === '--message'
    || arg === '-m'
    || arg.startsWith('--message=')
    || arg === '--message-file'
    || arg.startsWith('--message-file=');
}

function findOpenClawMessageArgIndex(args: string[]): number {
  return args.findIndex(isOpenClawMessageArg);
}

function insertDefaultOpenClawTarget(args: string[]): string[] {
  const agentIdx = args.indexOf('agent');
  const messageIdx = findOpenClawMessageArgIndex(args);
  const insertIdx = messageIdx >= 0 ? messageIdx : agentIdx + 1;
  return [
    ...args.slice(0, insertIdx),
    '--agent',
    'main',
    ...args.slice(insertIdx),
  ];
}

function buildOpenClawArgs(baseArgs: string[], prompt: string): string[] {
  const { prefix, runtime } = splitOpenClawRuntimeArgs(openclawRuntimeArgs(baseArgs));
  const hasAgent = runtime.includes('agent');
  const hasMessage = runtime.some(isOpenClawMessageArg);
  const hasTarget = hasOpenClawTargetSelector(runtime);
  // OpenClaw one-shot agent turns need an `agent` subcommand plus a session selector. The
  // scanner supplies ['agent', '--agent', <id>]; honour operator config and only fill gaps.
  let args = runtime;
  if (!hasAgent) {
    args = hasTarget ? ['agent', ...args] : ['agent', '--agent', 'main', ...args];
  } else if (!hasTarget) {
    args = insertDefaultOpenClawTarget(args);
  }
  const messageArgs = hasMessage ? replaceOpenClawMessageArg(args, prompt) : [...args, '--message', prompt];
  return [...prefix, ...messageArgs];
}

function replaceOpenClawMessageArg(args: string[], prompt: string): string[] {
  const replaced: string[] = [];
  let written = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--message' || arg === '-m' || arg === '--message-file') {
      if (!written) {
        replaced.push('--message', prompt);
        written = true;
      }
      const nextArg = args[index + 1];
      if (nextArg !== undefined && !nextArg.startsWith('-')) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--message=') || arg.startsWith('--message-file=')) {
      if (!written) {
        replaced.push('--message', prompt);
        written = true;
      }
      continue;
    }
    replaced.push(arg);
  }
  return written ? replaced : [...replaced, '--message', prompt];
}

const OPENCLAW_MESSAGE_PLACEHOLDER = '[message elided]';

function redactOpenClawCommandArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--message' || arg === '-m') {
      redacted.push(arg, OPENCLAW_MESSAGE_PLACEHOLDER);
      if (args[index + 1] !== undefined) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--message=')) {
      redacted.push('--message', OPENCLAW_MESSAGE_PLACEHOLDER);
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

function claudeCodeRuntimeArgs(args: string[]): string[] {
  if (args[0] === 'gateway' && args[1] === 'run') {
    return args.slice(2);
  }
  return args;
}

function buildClaudeCodeArgs(baseArgs: string[], _prompt: string): string[] {
  const runtime = claudeCodeRuntimeArgs(baseArgs);
  const hasPrint = runtime.includes('-p') || runtime.includes('--print');
  // claude-code defaults to an interactive TUI; -p puts it in print (non-interactive) mode so it
  // reads the prompt from stdin and exits after replying. The prompt itself travels on stdin
  // (see promptOnStdin), so buildArgs only ensures the flag is present.
  return hasPrint ? runtime : [...runtime, '-p'];
}

interface AgentAdapterSpec {
  // Build the one-shot argv from base args + prompt (prompt already includes joined history).
  // For argv-mode adapters the prompt is placed on argv here; for promptOnStdin adapters the
  // prompt travels on stdin and buildArgs only contributes flags/subcommand.
  buildArgs: (baseArgs: string[], prompt: string) => string[];
  // When true, the joined-history prompt is written to stdin instead of argv. Optional; default
  // false (argv-mode). claude-code uses this with `-p` (print mode reads stdin, exits on reply).
  promptOnStdin?: boolean;
  // Redact the prompt-bearing args used for the persisted workspace-run command. Optional.
  redactCommandArgs?: (args: string[]) => string[];
  // Extract the reply from captured stdout. Optional; defaults to the generic stdout/exit rule.
  extractReply?: (stdout: string, code: number | null, stderr: string) => string;
}

// Custom invocation contracts for agents that cannot use the generic stdin path. Argv-mode
// adapters (hermes, openclaw) put the prompt on argv; stdin-mode adapters (claude-code) keep it
// on stdin but inject a non-interactive flag. Unregistered adapterKinds (codex, gemini, kimi-cli)
// keep the generic stdin contract — audit pending.
const ARGV_MODE_ADAPTERS: Partial<Record<AdapterKind, AgentAdapterSpec>> = {
  hermes: {
    buildArgs: buildHermesArgs,
    redactCommandArgs: redactHermesCommandArgs,
    extractReply: extractHermesReply,
  },
  openclaw: {
    buildArgs: buildOpenClawArgs,
    redactCommandArgs: redactOpenClawCommandArgs,
  },
  'claude-code': {
    buildArgs: buildClaudeCodeArgs,
    promptOnStdin: true,
  },
};

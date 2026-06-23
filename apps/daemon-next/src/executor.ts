import { spawn } from 'node:child_process';
import type { DaemonDispatchResult, DispatchRequestPayload, StubExecutor } from './index.js';

export interface CommandExecutorOptions {
  fallbackPrefix?: string;
  timeoutMs?: number;
  /** Grace period (ms) between SIGTERM and the follow-up SIGKILL when a command times out. */
  killGraceMs?: number;
  /** Max combined stdout+stderr bytes buffered in memory before the command is force-killed. */
  maxAccumulatedBytes?: number;
  clock?: { now(): number };
}

// Trust model: the daemon executes whatever command the authenticated server-next dispatches
// via customAgent.command. daemon trusts server-next — authorizing/validating the command is the
// server's responsibility. buildChildEnv is the hard boundary on this side: the host environment
// (e.g. secrets exported in ~/.zshrc) must NOT leak into the child, because the child's
// stdout/stderr are captured and uploaded as downloadable log artifacts.

const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'SHELL',
]);

export function buildChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  customEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }
    if (SAFE_ENV_KEYS.has(key) || key.startsWith('LC_')) {
      env[key] = value;
    }
  }
  return { ...env, ...(customEnv ?? {}) };
}

export function createCommandExecutor(options: CommandExecutorOptions = {}): StubExecutor {
  const fallbackPrefix = options.fallbackPrefix ?? 'daemon-next:';
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const killGraceMs = options.killGraceMs ?? 5000;
  const maxAccumulatedBytes = options.maxAccumulatedBytes ?? 8 * 1024 * 1024;
  const clock = options.clock ?? { now: () => Date.now() };

  return async (request) => {
    if (!request.customAgent?.command) {
      return `${fallbackPrefix}${request.prompt}`;
    }
    return runCustomAgentCommand(request, { timeoutMs, killGraceMs, maxAccumulatedBytes, clock });
  };
}

interface RunOptions {
  timeoutMs: number;
  killGraceMs: number;
  maxAccumulatedBytes: number;
  clock: { now(): number };
}

async function runCustomAgentCommand(
  request: DispatchRequestPayload,
  options: RunOptions,
): Promise<DaemonDispatchResult> {
  const customAgent = request.customAgent;
  if (!customAgent?.command) {
    throw new Error('custom agent command is required');
  }

  // Hermes is an interactive TUI by default. The generic path feeds the prompt via stdin and
  // closes the pipe immediately, which makes Hermes echo the input then exit on EOF ("Goodbye!")
  // without ever running the query. Hermes exposes a programmatic one-shot mode —
  // `hermes chat -Q -q "<query>"` — where -Q suppresses the banner/spinner and -q carries the
  // query on argv. So for Hermes we put the prompt (plus joined history) on argv and leave
  // stdin ignored.
  const isHermes = customAgent.adapterKind === 'hermes';
  const finalArgs = isHermes
    ? buildHermesArgs(customAgent.args ?? [], buildHermesPrompt(request))
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
      const command = formatCommand(customAgent.command as string, finalArgs);
      const logContent = buildLogArtifactContent(stdout, stderr);
      const body = isHermes
        ? extractHermesReply(stdout, code ?? null, stderr)
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
      // Hermes receives its prompt via argv (see buildHermesArgs); close stdin empty so the
      // process never blocks on a pipe it does not read.
      child.stdin.end(isHermes ? '' : (typeof request.prompt === 'string' ? request.prompt : ''));
    }
  });
}

const LOG_EXCERPT_MAX_CHARS = 16000;
const LOG_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const SENSITIVE_LOG_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`]+)/gi;

function buildRedactedLog(stdout: string, stderr: string): string {
  return [
    stdout ? `stdout:\n${stdout.trimEnd()}` : '',
    stderr ? `stderr:\n${stderr.trimEnd()}` : '',
  ].filter(Boolean).join('\n\n').replace(SENSITIVE_LOG_ASSIGNMENT_RE, '$1=[redacted]');
}

function buildLogExcerpt(stdout: string, stderr: string): string {
  const redacted = buildRedactedLog(stdout, stderr);
  if (redacted.length <= LOG_EXCERPT_MAX_CHARS) {
    return redacted;
  }
  return redacted.slice(redacted.length - LOG_EXCERPT_MAX_CHARS);
}

function buildLogArtifactContent(stdout: string, stderr: string): string {
  const redacted = buildRedactedLog(stdout, stderr);
  const content = Buffer.from(redacted, 'utf8');
  if (content.length <= LOG_ARTIFACT_MAX_BYTES) {
    return redacted;
  }
  const tail = content.subarray(content.length - LOG_ARTIFACT_MAX_BYTES).toString('utf8');
  return `[workspace run log truncated to last ${LOG_ARTIFACT_MAX_BYTES} bytes]\n\n${tail}`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

// ── Hermes adapter helpers ────────────────────────────────────────────────────
// daemon-next runs every agent through the same spawn+capture spine. Only Hermes needs a
// non-stdin invocation contract, so its specifics live here rather than behind a full adapter
// abstraction.

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
  return hasQuery ? [...args, prompt] : [...args, '-q', prompt];
}

function buildHermesPrompt(request: DispatchRequestPayload): string {
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

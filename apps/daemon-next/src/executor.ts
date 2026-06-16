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

  return new Promise((resolve, reject) => {
    const startedAt = options.clock.now();
    const child = spawn(customAgent.command as string, customAgent.args ?? [], {
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
      const command = formatCommand(customAgent.command as string, customAgent.args ?? []);
      const logContent = buildLogArtifactContent(stdout, stderr);
      resolve({
        body: code === 0 ? stdout.trimEnd() : `custom agent command exited with code ${exitCode}`,
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
    child.stdin.on('error', () => {
      // swallow
    });
    child.stdin.end(typeof request.prompt === 'string' ? request.prompt : '');
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

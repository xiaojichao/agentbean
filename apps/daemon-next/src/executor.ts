import { spawn } from 'node:child_process';
import type { DaemonDispatchResult, DispatchRequestPayload, StubExecutor } from './index.js';

export interface CommandExecutorOptions {
  fallbackPrefix?: string;
  timeoutMs?: number;
  clock?: { now(): number };
}

export function createCommandExecutor(options: CommandExecutorOptions = {}): StubExecutor {
  const fallbackPrefix = options.fallbackPrefix ?? 'daemon-next:';
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const clock = options.clock ?? { now: () => Date.now() };

  return async (request) => {
    if (!request.customAgent?.command) {
      return `${fallbackPrefix}${request.prompt}`;
    }
    return runCustomAgentCommand(request, timeoutMs, clock);
  };
}

async function runCustomAgentCommand(
  request: DispatchRequestPayload,
  timeoutMs: number,
  clock: { now(): number },
): Promise<DaemonDispatchResult> {
  const customAgent = request.customAgent;
  if (!customAgent?.command) {
    throw new Error('custom agent command is required');
  }

  return new Promise((resolve, reject) => {
    const startedAt = clock.now();
    const child = spawn(customAgent.command as string, customAgent.args ?? [], {
      cwd: customAgent.cwd,
      env: { ...process.env, ...(customAgent.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`custom agent command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const completedAt = clock.now();
      const exitCode = code ?? 1;
      const command = formatCommand(customAgent.command as string, customAgent.args ?? []);
      resolve({
        body: code === 0 ? stdout.trimEnd() : `custom agent command exited with code ${exitCode}`,
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

    child.stdin.end(request.prompt);
  });
}

const LOG_EXCERPT_MAX_CHARS = 16000;
const SENSITIVE_LOG_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`]+)/gi;

function buildLogExcerpt(stdout: string, stderr: string): string {
  const combined = [
    stdout ? `stdout:\n${stdout.trimEnd()}` : '',
    stderr ? `stderr:\n${stderr.trimEnd()}` : '',
  ].filter(Boolean).join('\n\n');
  const redacted = combined.replace(SENSITIVE_LOG_ASSIGNMENT_RE, '$1=[redacted]');
  if (redacted.length <= LOG_EXCERPT_MAX_CHARS) {
    return redacted;
  }
  return redacted.slice(redacted.length - LOG_EXCERPT_MAX_CHARS);
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

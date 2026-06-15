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
      if (code === 0) {
        resolve({
          body: stdout.trimEnd(),
          workspaceRun: {
            cwd: customAgent.cwd,
            command: formatCommand(customAgent.command as string, customAgent.args ?? []),
            exitCode: 0,
            startedAt,
            completedAt,
            logExcerpt: buildLogExcerpt(stdout, stderr),
          },
        });
        return;
      }
      reject(new Error(stderr.trim() || `custom agent command exited with code ${code ?? 'unknown'}`));
    });

    child.stdin.end(request.prompt);
  });
}

const LOG_EXCERPT_MAX_CHARS = 16000;
const SENSITIVE_LOG_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi;

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

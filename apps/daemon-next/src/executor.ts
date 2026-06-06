import { spawn } from 'node:child_process';
import type { DispatchRequestPayload, StubExecutor } from './index';

export interface CommandExecutorOptions {
  fallbackPrefix?: string;
  timeoutMs?: number;
}

export function createCommandExecutor(options: CommandExecutorOptions = {}): StubExecutor {
  const fallbackPrefix = options.fallbackPrefix ?? 'daemon-next:';
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  return async (request) => {
    if (!request.customAgent?.command) {
      return `${fallbackPrefix}${request.prompt}`;
    }
    return runCustomAgentCommand(request, timeoutMs);
  };
}

async function runCustomAgentCommand(request: DispatchRequestPayload, timeoutMs: number): Promise<string> {
  const customAgent = request.customAgent;
  if (!customAgent?.command) {
    throw new Error('custom agent command is required');
  }

  return new Promise((resolve, reject) => {
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
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(new Error(stderr.trim() || `custom agent command exited with code ${code ?? 'unknown'}`));
    });

    child.stdin.end(request.prompt);
  });
}

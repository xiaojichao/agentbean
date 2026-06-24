// Shared helpers between the pipe-path executor (executor.ts) and the PTY-path executor
// (executor-pty.ts). Extracted to a leaf module so neither executor imports the other — both
// depend only on this. Keeping buildChildEnv here is load-bearing: it is the secrets boundary.
// The host environment (e.g. tokens exported in ~/.zshrc) must NOT leak into the child process,
// because child stdout/stderr (and PTY output) are captured and uploaded as downloadable log
// artifacts. Every spawn path — pipe or PTY — must go through buildChildEnv.

export const SAFE_ENV_KEYS = new Set([
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

export const LOG_EXCERPT_MAX_CHARS = 16000;
export const LOG_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const SENSITIVE_LOG_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`]+)/gi;

export function buildRedactedLog(stdout: string, stderr: string): string {
  return [
    stdout ? `stdout:\n${stdout.trimEnd()}` : '',
    stderr ? `stderr:\n${stderr.trimEnd()}` : '',
  ].filter(Boolean).join('\n\n').replace(SENSITIVE_LOG_ASSIGNMENT_RE, '$1=[redacted]');
}

export function buildLogExcerpt(stdout: string, stderr: string): string {
  const redacted = buildRedactedLog(stdout, stderr);
  if (redacted.length <= LOG_EXCERPT_MAX_CHARS) {
    return redacted;
  }
  return redacted.slice(redacted.length - LOG_EXCERPT_MAX_CHARS);
}

export function buildLogArtifactContent(stdout: string, stderr: string): string {
  const redacted = buildRedactedLog(stdout, stderr);
  const content = Buffer.from(redacted, 'utf8');
  if (content.length <= LOG_ARTIFACT_MAX_BYTES) {
    return redacted;
  }
  const tail = content.subarray(content.length - LOG_ARTIFACT_MAX_BYTES).toString('utf8');
  return `[workspace run log truncated to last ${LOG_ARTIFACT_MAX_BYTES} bytes]\n\n${tail}`;
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

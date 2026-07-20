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

// Codex model_providers often declare `env_key = "SOME_API_KEY"`. When that process env is
// missing, codex emits JSON events with `Missing environment variable: NAME.` and exits non-zero.
// Daemon only injects secrets via customAgent.env (see buildChildEnv), so host shell exports never
// reach the child — surface that contract next to the raw codex detail so channel replies are actionable.
const MISSING_ENV_VAR_RE = /Missing environment variable:\s*([A-Za-z_][A-Za-z0-9_]*)/i;

export function formatCodexExitFailureBody(exitCode: number, rawOutput: string): string {
  const detail = rawOutput.trim().slice(0, 2000) || '(无输出)';
  const base = `codex exit ${exitCode}: ${detail}`;
  const match = detail.match(MISSING_ENV_VAR_RE);
  if (!match) {
    return base;
  }
  const envName = match[1]!;
  return [
    base,
    '',
    `提示：Codex 需要环境变量 ${envName}，但 AgentBean daemon 不会把宿主机 shell 中的密钥传给子进程（避免写入 workspace 日志）。`,
    `请在该自定义 Agent 的「环境变量」中配置 ${envName}=<你的 API Key> 后重试。若 Agent 不是 custom，请改为自定义 Agent 并填写环境变量。`,
  ].join('\n');
}

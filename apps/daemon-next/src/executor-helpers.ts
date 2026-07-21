// Shared helpers between the pipe-path executor (executor.ts) and the PTY-path executor
// (executor-pty.ts). Extracted to a leaf module so neither executor imports the other — both
// depend only on this. Keeping buildChildEnv here is load-bearing: it is the secrets boundary.
// The host environment (e.g. tokens exported in ~/.zshrc) must NOT indiscriminately leak into the
// child process, because child stdout/stderr (and PTY output) are captured and uploaded as
// downloadable log artifacts. Every spawn path — pipe or PTY — must go through buildChildEnv.

import { spawnSync } from 'node:child_process';

export const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'SHELL',
]);

// Coding CLI adapters (codex / claude-code / gemini / …) often read provider keys from process
// env via model_providers.env_key (e.g. CRS_OAI_KEY from CC Switch). Those keys are intentionally
// allowed when `includeCodingRuntimeSecrets` is set — not the full host environment.
const CODING_RUNTIME_ENV_PREFIX_RE = /^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|CODEX|CRS|CLAUDE|DASHSCOPE|MOONSHOT|DEEPSEEK|GROQ|MISTRAL|TOGETHER|FIREWORKS|XAI|ZAI|MINIMAX|SILICONFLOW|VOLC|ARK)_/i;
const CODING_RUNTIME_ENV_SUFFIX_RE = /_(API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET_KEY|AUTH_TOKEN|OAI_KEY)$/i;

export function isCodingRuntimeSecretEnvKey(key: string): boolean {
  if (SAFE_ENV_KEYS.has(key) || key.startsWith('LC_')) {
    return false;
  }
  return CODING_RUNTIME_ENV_PREFIX_RE.test(key) || CODING_RUNTIME_ENV_SUFFIX_RE.test(key);
}

export interface BuildChildEnvOptions {
  /**
   * When true, forward host/login-shell keys that look like coding-runtime provider secrets
   * (CRS_OAI_KEY, OPENAI_API_KEY, …). Still does NOT forward GH_TOKEN / DATABASE_URL / AWS_*.
   * customEnv always wins on key collision.
   */
  includeCodingRuntimeSecrets?: boolean;
  /**
   * Extra host env source (typically login-shell env). Used so LaunchAgent processes that only
   * have a minimal PATH still pick up keys the user exported in ~/.zshrc. Test injects a stub.
   */
  extraHostEnv?: NodeJS.ProcessEnv | Record<string, string>;
  /**
   * Absolute path of the agent command (e.g. `/Users/x/Library/pnpm/codex`). Used only to
   * derive nearby bin dirs (pnpm global shim dir) when repairing PATH for `node`.
   */
  commandPath?: string;
}

/**
 * LaunchAgent / systemd user services typically only inherit system dirs
 * (`/usr/bin:/bin:/usr/sbin:/sbin`). npm-installed CLIs use `#!/usr/bin/env node`
 * and fail with `env: node: No such file or directory` (exit 127) unless PATH
 * includes nvm/homebrew/local bins from the user's login shell.
 */
const SYSTEM_PATH_DIRS = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

export function isLaunchAgentMinimalPath(pathValue: string | undefined): boolean {
  if (pathValue === undefined || pathValue.trim() === '') {
    return true;
  }
  const dirs = pathValue.split(':').map((part) => part.trim()).filter(Boolean);
  if (dirs.length === 0) {
    return true;
  }
  return dirs.every((dir) => SYSTEM_PATH_DIRS.has(dir));
}

function mergeHostEnvSources(
  sourceEnv: NodeJS.ProcessEnv,
  options: BuildChildEnvOptions,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...sourceEnv };
  if (options.extraHostEnv) {
    for (const [key, value] of Object.entries(options.extraHostEnv)) {
      if (value !== undefined && merged[key] === undefined) {
        merged[key] = value;
      }
    }
    return merged;
  }
  // Lazy login-shell load: needed for coding secrets and/or LaunchAgent PATH repair.
  // Failures are empty — never block spawn.
  if (!options.includeCodingRuntimeSecrets && !isLaunchAgentMinimalPath(sourceEnv.PATH)) {
    return merged;
  }
  const loginEnv = readLoginShellEnv();
  for (const [key, value] of Object.entries(loginEnv)) {
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  // PATH is special: LaunchAgent always sets a *value*, so "undefined fill" never
  // picks up login PATH. Prefer the richer login PATH whenever the process PATH is
  // system-only (typical LaunchAgent / systemd user service default).
  if (loginEnv.PATH && isLaunchAgentMinimalPath(sourceEnv.PATH)) {
    merged.PATH = loginEnv.PATH;
  }
  return merged;
}

/**
 * True when `node` is resolvable via PATH (using /usr/bin/env for parity with shebangs).
 */
export function pathResolvesNode(pathValue: string | undefined): boolean {
  if (!pathValue || pathValue.trim() === '') {
    return false;
  }
  try {
    const result = spawnSync('/usr/bin/env', ['node', '-e', 'process.exit(0)'], {
      env: { PATH: pathValue },
      encoding: 'utf8',
      timeout: 3_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function candidateNodeBinDirs(home: string | undefined, commandPath: string | undefined): string[] {
  const dirs: string[] = [];
  const push = (dir: string | undefined) => {
    if (dir && dir.length > 0 && !dirs.includes(dir)) dirs.push(dir);
  };
  if (commandPath) {
    // pnpm global shims live in ~/Library/pnpm; nearby node is often there or in nodejs/*
    const lastSlash = Math.max(commandPath.lastIndexOf('/'), commandPath.lastIndexOf('\\'));
    if (lastSlash > 0) {
      push(commandPath.slice(0, lastSlash));
    }
  }
  if (home) {
    push(`${home}/Library/pnpm`);
    push(`${home}/.local/share/pnpm`);
    push(`${home}/.local/bin`);
    push(`${home}/.nvm/current/bin`);
    // nvm versions: pick newest-ish by scanning shallowly without throwing
    try {
      const nvmVersions = `${home}/.nvm/versions/node`;
      // Lazy require-free fs via spawnSync ls — keep this module free of fs import churn.
      const listed = spawnSync('/bin/ls', ['-1', nvmVersions], { encoding: 'utf8', timeout: 2_000 });
      if (listed.status === 0 && listed.stdout) {
        const versions = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort().reverse();
        for (const v of versions.slice(0, 5)) {
          push(`${nvmVersions}/${v}/bin`);
        }
      }
    } catch {
      // ignore
    }
    push(`${home}/.fnm/current/bin`);
    push(`${home}/.volta/bin`);
    push(`${home}/.asdf/shims`);
    push(`${home}/.local/share/mise/shims`);
  }
  push('/opt/homebrew/bin');
  push('/usr/local/bin');
  return dirs;
}

/**
 * Ensure PATH can resolve `node` for npm/pnpm shims (`exec: node: not found` / `env: node: ...`).
 * Prefers login-shell `command -v node`, then well-known install locations under HOME.
 */
export function ensureNodeOnPath(
  pathValue: string | undefined,
  home: string | undefined,
  options: { commandPath?: string; loginPath?: string } = {},
): string {
  const base = pathValue && pathValue.length > 0 ? pathValue : '/usr/bin:/bin:/usr/sbin:/sbin';
  if (pathResolvesNode(base)) {
    return base;
  }

  // Prefer node discovered from a full login PATH (nvm hooks often only expand there).
  const loginPath = options.loginPath;
  if (loginPath && loginPath !== base) {
    try {
      const which = spawnSync('/bin/sh', ['-c', 'command -v node'], {
        env: { PATH: loginPath, HOME: home ?? '' },
        encoding: 'utf8',
        timeout: 3_000,
      });
      if (which.status === 0 && which.stdout?.trim()) {
        const nodePath = which.stdout.trim();
        const dir = nodePath.includes('/') ? nodePath.slice(0, nodePath.lastIndexOf('/')) : '';
        if (dir) {
          const next = `${dir}:${base}`;
          if (pathResolvesNode(next)) return next;
        }
      }
    } catch {
      // ignore
    }
    if (pathResolvesNode(loginPath)) {
      return loginPath;
    }
  }

  // Also ask login shell directly (loads nvm/fnm hooks that plain PATH may miss).
  try {
    const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/zsh';
    const which = spawnSync(shell, ['-lic', 'command -v node'], {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        HOME: home ?? process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        PATH: loginPath ?? base,
        TERM: 'dumb',
      },
    });
    if (which.status === 0 && which.stdout?.trim()) {
      const nodePath = which.stdout.trim().split('\n').pop()!.trim();
      const dir = nodePath.includes('/') ? nodePath.slice(0, nodePath.lastIndexOf('/')) : '';
      if (dir) {
        const next = `${dir}:${base}`;
        if (pathResolvesNode(next)) return next;
      }
    }
  } catch {
    // ignore
  }

  for (const dir of candidateNodeBinDirs(home, options.commandPath)) {
    const next = `${dir}:${base}`;
    if (pathResolvesNode(next)) {
      return next;
    }
  }
  return base;
}

export function buildChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  customEnv?: Record<string, string>,
  options: BuildChildEnvOptions = {},
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

  const mergedHost = mergeHostEnvSources(sourceEnv, options);

  // Always repair LaunchAgent-minimal PATH for every adapter (codex / hermes / …).
  // Does not leak secrets — PATH only.
  const preferredPath = mergedHost.PATH;
  if (typeof preferredPath === 'string' && preferredPath.length > 0
    && isLaunchAgentMinimalPath(env.PATH)) {
    env.PATH = preferredPath;
  }

  if (options.includeCodingRuntimeSecrets) {
    for (const [key, value] of Object.entries(mergedHost)) {
      if (value === undefined) continue;
      if (isCodingRuntimeSecretEnvKey(key)) {
        env[key] = value;
      }
    }
  }

  const merged = { ...env, ...(customEnv ?? {}) };
  // After customEnv: ensure `node` is resolvable. Covers pnpm shims that do `exec node`
  // even when login PATH was applied but nvm/pnpm node dir was missing.
  const loginPath = typeof mergedHost.PATH === 'string' ? mergedHost.PATH : undefined;
  merged.PATH = ensureNodeOnPath(merged.PATH, merged.HOME ?? sourceEnv.HOME, {
    commandPath: options.commandPath,
    loginPath,
  });
  return merged;
}

export const LOG_EXCERPT_MAX_CHARS = 16000;
export const LOG_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
// Include bare *_KEY (CRS_OAI_KEY) in addition to TOKEN/SECRET/PASSWORD/API_KEY.
const SENSITIVE_LOG_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`]+)/gi;

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

// Channel-facing codex failure formatting. Prefer classified Chinese guidance over raw JSONL
// dumps so the chat bubble is actionable even when PI LLM is not configured yet.
const MISSING_ENV_VAR_RE = /Missing environment variable:\s*([A-Za-z_][A-Za-z0-9_]*)/i;
const NODE_NOT_ON_PATH_RE = /env:\s*node:\s*No such file or directory/i;
const EXEC_NODE_NOT_FOUND_RE = /exec:\s*node:\s*not found/i;
const USAGE_LIMIT_RE = /hit your usage limit|usage limit|rate limit|配额|额度/i;
const AUTH_EXPIRED_RE = /refresh token|401 Unauthorized|not logged in|authentication|auth\.json|login required/i;
const PTY_UNAVAILABLE_RE = /需要 PTY 运行时|node-pty|PTY 启动失败/i;
const CODEX_TIMEOUT_RE = /codex 超时|timed? ?out after|AGENTBEAN_CODEX_TIMEOUT/i;

function extractCodexJsonlMessages(detail: string): string[] {
  const messages: string[] = [];
  for (const line of detail.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const event = JSON.parse(trimmed) as {
        message?: unknown;
        error?: { message?: unknown } | unknown;
        item?: { message?: unknown };
      };
      if (typeof event.message === 'string' && event.message.trim()) messages.push(event.message.trim());
      if (event.error && typeof event.error === 'object' && event.error !== null) {
        const errMsg = (event.error as { message?: unknown }).message;
        if (typeof errMsg === 'string' && errMsg.trim()) messages.push(errMsg.trim());
      }
      if (event.item && typeof event.item === 'object' && event.item !== null) {
        const itemMsg = (event.item as { message?: unknown }).message;
        if (typeof itemMsg === 'string' && itemMsg.trim()) messages.push(itemMsg.trim());
      }
    } catch {
      // ignore non-JSON noise
    }
  }
  return messages;
}

function classifyCodexFailureText(text: string): { summary: string; guidance: string } | null {
  const envMatch = text.match(MISSING_ENV_VAR_RE);
  if (envMatch?.[1]) {
    const envName = envMatch[1];
    return {
      summary: `Agent 缺少环境变量 ${envName}`,
      guidance: [
        `请在该自定义 Agent 的「环境变量」中配置 ${envName}=<密钥>（推荐，可跨 LaunchAgent 重启保留）；`,
        `或在登录 shell（~/.zshrc）export ${envName} 后执行 agentbean device restart；`,
        '也可确认 Device Service 进程本身能读到该变量（launchctl print 查看）。',
      ].join(''),
    };
  }
  if (
    NODE_NOT_ON_PATH_RE.test(text)
    || EXEC_NODE_NOT_FOUND_RE.test(text)
    || (/\bnode\b/i.test(text) && /not found|No such file or directory/i.test(text))
  ) {
    return {
      summary: '设备上找不到 Node，无法启动 Codex',
      guidance: [
        'Codex 启动时找不到 `node`（npm/pnpm 安装的 codex 会 `exec node` / `#!/usr/bin/env node`）。',
        'Device Service 由 LaunchAgent 启动时 PATH 极简，常不含 nvm / pnpm / Homebrew。',
        '处理方式：升级 daemon 后 `agentbean device restart`，或在 Agent 环境变量中设置包含 node 的 PATH。',
      ].join(''),
    };
  }
  if (USAGE_LIMIT_RE.test(text)) {
    return {
      summary: 'Codex / ChatGPT 用量或额度已用尽',
      guidance: '请到 ChatGPT/Codex 用量页检查额度，或切换可用模型 / 本地 provider 后再试。',
    };
  }
  if (AUTH_EXPIRED_RE.test(text)) {
    return {
      summary: 'Codex 登录态失效，需要重新登录',
      guidance: '请在目标设备本机执行 codex login，确认 ~/.codex/auth.json 有效后重试。',
    };
  }
  if (PTY_UNAVAILABLE_RE.test(text)) {
    return {
      summary: '本机 Codex 运行环境不可用（缺少 PTY）',
      guidance: '请确认 daemon 已安装可用的 node-pty，并在目标设备桌面会话中重启 Device Service。',
    };
  }
  if (CODEX_TIMEOUT_RE.test(text)) {
    return {
      summary: 'Agent 处理超时，Codex 未在时限内完成',
      guidance: '可缩短任务、检查模型/网络，或稍后重试；复杂任务建议拆成更小步骤。',
    };
  }
  return null;
}

export function formatCodexExitFailureBody(exitCode: number, rawOutput: string): string {
  const detail = rawOutput.trim().slice(0, 2000) || '(无输出)';
  const candidates = [...extractCodexJsonlMessages(detail), detail];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const classified = classifyCodexFailureText(candidates[i]!);
    if (classified) {
      // Keep a compact technical breadcrumb for support, but lead with Chinese guidance.
      return [
        classified.summary,
        classified.guidance,
        '',
        `技术细节：codex exit ${exitCode}`,
      ].join('\n');
    }
  }
  if (detail === '(无输出)') {
    return [
      'Codex 执行失败，且未返回可读错误输出',
      '请在设备本机运行 `codex exec --json "Hello"` 验证 Codex 是否可用，并检查 Device Service 日志。',
      '',
      `技术细节：codex exit ${exitCode}: (无输出)`,
    ].join('\n');
  }
  return [
    'Codex 执行失败',
    '请查看该消息的执行记录获取完整日志；若持续失败，先在设备本机验证 Codex CLI。',
    '',
    `技术细节：codex exit ${exitCode}: ${detail.slice(0, 400)}`,
  ].join('\n');
}

// ── login-shell env (LaunchAgent has a minimal PATH and no user exports) ──────

let loginShellEnvCache: Record<string, string> | undefined;
let loginShellEnvLoader: (() => Record<string, string>) | undefined;

/** Test-only: inject or clear the login-shell env loader / cache. */
export function setLoginShellEnvLoaderForTests(loader: (() => Record<string, string>) | undefined): void {
  loginShellEnvLoader = loader;
  loginShellEnvCache = undefined;
}

export function readLoginShellEnv(): Record<string, string> {
  if (loginShellEnvCache) {
    return loginShellEnvCache;
  }
  if (loginShellEnvLoader) {
    loginShellEnvCache = loginShellEnvLoader();
    return loginShellEnvCache;
  }
  loginShellEnvCache = loadLoginShellEnvFromShell();
  return loginShellEnvCache;
}

function loadLoginShellEnvFromShell(): Record<string, string> {
  try {
    const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/zsh';
    // `env -0` is null-delimited so values may contain newlines. Timeout keeps a broken
    // interactive shell from hanging every codex dispatch on first use.
    const result = spawnSync(shell, ['-lic', '/usr/bin/env -0'], {
      encoding: 'buffer',
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        // Keep a minimal PATH so `env` itself resolves if SHELL is a full login path.
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        TERM: 'dumb',
      },
    });
    if (result.status !== 0 || !result.stdout) {
      return {};
    }
    const parsed: Record<string, string> = {};
    for (const entry of result.stdout.toString('utf8').split('\0')) {
      if (!entry) continue;
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      const key = entry.slice(0, eq);
      const value = entry.slice(eq + 1);
      if (key) parsed[key] = value;
    }
    return parsed;
  } catch {
    return {};
  }
}

/** Adapters that should receive coding-runtime provider secrets from host/login env. */
export function adapterNeedsCodingRuntimeSecrets(adapterKind: string | undefined): boolean {
  if (!adapterKind) return false;
  switch (adapterKind) {
    case 'codex':
    case 'codex-cli':
    case 'claude-code':
    case 'gemini':
    case 'kimi-cli':
      return true;
    default:
      return false;
  }
}

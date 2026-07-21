/**
 * Channel-facing classification for Agent dispatch failures / timeouts.
 *
 * PI / product surfaces should show these Chinese summaries instead of bare
 * "处理失败" / "处理超时", and should not dump raw JSONL / stack traces.
 *
 * Deterministic rules first (usage limit, missing env, node PATH, auth).
 * Unknown failures still get a short Chinese fallback; raw detail stays in
 * workspace-run logs for diagnosis. PI can later reuse this same classifier.
 */

export type DispatchFailureCategory =
  | 'usage_limit'
  | 'auth_expired'
  | 'missing_env'
  | 'node_not_found'
  | 'codex_timeout'
  | 'dispatch_timeout'
  | 'pty_unavailable'
  | 'workspace_run_failed'
  | 'workspace_run_cancelled'
  | 'unknown';

export interface ClassifiedDispatchFailure {
  readonly category: DispatchFailureCategory;
  /** Short Chinese summary for channel UI badges / system hints. */
  readonly summary: string;
  /** Optional action-oriented guidance for the user. */
  readonly guidance?: string;
  /** Extracted env var name when category is missing_env. */
  readonly envName?: string;
}

export interface ClassifyDispatchFailureInput {
  readonly status?: 'failed' | 'timed_out' | string;
  /** DispatchDto.error codes such as DISPATCH_TIMEOUT / WORKSPACE_RUN_FAILED. */
  readonly errorCode?: string;
  /**
   * Agent reply body, workspace log excerpt, or codex exit detail.
   * May contain JSONL events from `codex exec --json`.
   */
  readonly detail?: string;
}

const MISSING_ENV_VAR_RE = /Missing environment variable:\s*([A-Za-z_][A-Za-z0-9_]*)/i;
const NODE_NOT_ON_PATH_RE = /env:\s*node:\s*No such file or directory/i;
const EXEC_NODE_NOT_FOUND_RE = /exec:\s*node:\s*not found/i;
const USAGE_LIMIT_RE = /hit your usage limit|usage limit|rate limit|配额|额度/i;
const AUTH_EXPIRED_RE = /refresh token|401 Unauthorized|not logged in|authentication|auth\.json|login required/i;
const PTY_UNAVAILABLE_RE = /需要 PTY 运行时|node-pty|PTY 启动失败/i;
const CODEX_TIMEOUT_RE = /codex 超时|timed? ?out after|AGENTBEAN_CODEX_TIMEOUT/i;

function extractJsonlMessages(detail: string): string[] {
  const messages: string[] = [];
  for (const line of detail.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        message?: unknown;
        error?: { message?: unknown } | unknown;
        item?: { type?: unknown; message?: unknown };
      };
      if (typeof event.message === 'string' && event.message.trim()) {
        messages.push(event.message.trim());
      }
      if (event.error && typeof event.error === 'object' && event.error !== null) {
        const errMsg = (event.error as { message?: unknown }).message;
        if (typeof errMsg === 'string' && errMsg.trim()) messages.push(errMsg.trim());
      }
      if (event.item && typeof event.item === 'object' && event.item !== null) {
        const itemMsg = (event.item as { message?: unknown }).message;
        if (typeof itemMsg === 'string' && itemMsg.trim()) messages.push(itemMsg.trim());
      }
    } catch {
      // ignore non-JSON noise from PTY / ANSI logs
    }
  }
  return messages;
}

function classifyFromText(text: string): ClassifiedDispatchFailure | null {
  const envMatch = text.match(MISSING_ENV_VAR_RE);
  if (envMatch?.[1]) {
    const envName = envMatch[1];
    return {
      category: 'missing_env',
      envName,
      summary: `Agent 缺少环境变量 ${envName}`,
      guidance: `请在该自定义 Agent 的「环境变量」中配置 ${envName}，或在登录 shell 导出后执行 agentbean device restart。`,
    };
  }
  if (
    NODE_NOT_ON_PATH_RE.test(text)
    || EXEC_NODE_NOT_FOUND_RE.test(text)
    || (/\bnode\b/i.test(text) && /not found|No such file or directory/i.test(text) && /exit\s*127|codex exit 127/i.test(text))
  ) {
    return {
      category: 'node_not_found',
      summary: '设备上找不到 Node，无法启动 Codex',
      guidance: 'Device Service 的 PATH 可能过短。请升级 daemon 后执行 agentbean device restart，或在 Agent 环境变量中设置包含 node 的 PATH。',
    };
  }
  if (USAGE_LIMIT_RE.test(text)) {
    return {
      category: 'usage_limit',
      summary: 'Codex / ChatGPT 用量或额度已用尽',
      guidance: '请到 ChatGPT/Codex 用量页检查额度，或切换可用模型 / 本地 provider 后再试。',
    };
  }
  if (AUTH_EXPIRED_RE.test(text)) {
    return {
      category: 'auth_expired',
      summary: 'Codex 登录态失效，需要重新登录',
      guidance: '请在目标设备本机执行 codex login，确认 ~/.codex/auth.json 有效后重试。',
    };
  }
  if (PTY_UNAVAILABLE_RE.test(text)) {
    return {
      category: 'pty_unavailable',
      summary: '本机 Codex 运行环境不可用（缺少 PTY）',
      guidance: '请确认 daemon 已安装可用的 node-pty，并在目标设备桌面会话中重启 Device Service。',
    };
  }
  if (CODEX_TIMEOUT_RE.test(text)) {
    return {
      category: 'codex_timeout',
      summary: 'Agent 处理超时，Codex 未在时限内完成',
      guidance: '可缩短任务、检查模型/网络，或稍后重试；复杂任务建议拆成更小步骤。',
    };
  }
  return null;
}

/**
 * Classify a failed / timed-out dispatch into a Chinese user-facing hint.
 * Safe for both server (DispatchDto.error) and daemon (codex PTY body) inputs.
 */
export function classifyDispatchFailure(
  input: ClassifyDispatchFailureInput,
): ClassifiedDispatchFailure {
  const errorCode = input.errorCode?.trim() ?? '';
  const detail = input.detail?.trim() ?? '';
  const status = input.status;

  if (status === 'timed_out' || errorCode === 'DISPATCH_TIMEOUT') {
    return {
      category: 'dispatch_timeout',
      summary: 'Agent 处理超时，系统已停止等待',
      guidance: '可点重试；若频繁超时，请检查设备在线状态、模型响应速度或缩小任务范围。',
    };
  }
  if (errorCode === 'WORKSPACE_RUN_CANCELLED') {
    return {
      category: 'workspace_run_cancelled',
      summary: 'Agent 执行已被取消',
    };
  }

  const jsonlMessages = detail ? extractJsonlMessages(detail) : [];
  // Prefer the last JSONL message — codex usually ends with the real failure reason.
  for (let i = jsonlMessages.length - 1; i >= 0; i -= 1) {
    const classified = classifyFromText(jsonlMessages[i]!);
    if (classified) return classified;
  }
  if (detail) {
    const classified = classifyFromText(detail);
    if (classified) return classified;
  }

  if (errorCode === 'WORKSPACE_RUN_FAILED') {
    return {
      category: 'workspace_run_failed',
      summary: 'Agent 执行失败',
      guidance: '可打开该条消息的执行记录查看详情；常见原因包括模型额度、鉴权、环境变量或工作区命令失败。',
    };
  }

  if (detail.startsWith('codex exit') || /codex exit\s+\d+/i.test(detail)) {
    return {
      category: 'unknown',
      summary: 'Codex 执行失败',
      guidance: '请查看执行记录中的详细日志；若持续失败，先在设备本机用 `codex exec --json "Hello"` 验证 Codex 本身是否可用。',
    };
  }

  return {
    category: 'unknown',
    summary: status === 'timed_out' ? 'Agent 处理超时' : 'Agent 处理失败',
    guidance: '请稍后重试；若反复出现，打开执行记录或设备日志排查。',
  };
}

/** One-line channel badge text. */
export function formatDispatchFailureSummary(input: ClassifyDispatchFailureInput): string {
  return classifyDispatchFailure(input).summary;
}

/**
 * Multi-line body for agent reply / system message when we want summary + guidance.
 * Does not include raw JSONL dumps.
 */
export function formatDispatchFailureBody(input: ClassifyDispatchFailureInput): string {
  const classified = classifyDispatchFailure(input);
  return classified.guidance
    ? `${classified.summary}\n${classified.guidance}`
    : classified.summary;
}

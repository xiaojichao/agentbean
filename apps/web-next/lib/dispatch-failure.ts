// 频道 dispatch 失败/超时 → 中文可执行提示。
//
// 规则分类放在 @agentbean/contracts，web 只做展示适配。
// PI Agent 后续可复用同一分类结果，不依赖 LLM 也能生效。

import {
  classifyDispatchFailure,
  formatDispatchFailureBody,
  formatDispatchFailureSummary,
  type DispatchStatus,
} from '@agentbean/contracts';

export function formatChannelDispatchFailureHint(input: {
  status?: DispatchStatus | string;
  errorCode?: string;
  detail?: string;
}): string {
  return formatDispatchFailureSummary({
    status: input.status,
    errorCode: input.errorCode,
    detail: input.detail,
  });
}

export function classifyChannelDispatchFailure(input: {
  status?: DispatchStatus | string;
  errorCode?: string;
  detail?: string;
}) {
  return classifyDispatchFailure({
    status: input.status,
    errorCode: input.errorCode,
    detail: input.detail,
  });
}

export function formatChannelDispatchFailureBody(input: {
  status?: DispatchStatus | string;
  errorCode?: string;
  detail?: string;
}): string {
  return formatDispatchFailureBody({
    status: input.status,
    errorCode: input.errorCode,
    detail: input.detail,
  });
}

/** Older daemons may still post raw `codex exit ...` bodies. Only rewrite those machine formats. */
export function rewriteLegacyCodexFailureBody(body: string): string {
  const trimmed = body.trim();
  const looksLikeMachineFailure = /^(?:Codex 执行失败|Agent 缺少环境变量|设备上找不到 Node|Codex \/ ChatGPT 用量|Codex 登录态失效|本机 Codex 运行环境不可用|Agent 处理超时|codex exit\s+\d+)/m.test(body)
    || /^codex exit\s+\d+/i.test(trimmed);
  if (!looksLikeMachineFailure) return body;
  return formatDispatchFailureBody({ status: 'failed', detail: body });
}

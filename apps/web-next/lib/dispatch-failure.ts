// 频道 dispatch 失败/超时 → 中文可执行提示。
//
// 规则分类放在 @agentbean/contracts，web 只做展示适配。
// PI Agent 后续可复用同一分类结果，不依赖 LLM 也能生效。

import {
  classifyDispatchFailure,
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

/**
 * 把频道里一条 `failed` dispatch 的可用字段映射成 classifyDispatchFailure 的输入。
 *
 * 设计背景:server 把失败原因写进 `dispatches.error_message`，经 socket 以 `dispatch.error` 下发，
 * 前端存进 `msg.dispatchError`。该值可能是 errorCode 风格串（WORKSPACE_RUN_FAILED 等），也可能是
 * 诊断文本（Missing environment variable … / usage limit … / node not found …）。
 *
 * 关键：classifyDispatchFailure 的诊断正则只作用于 `detail`，`errorCode` 只匹配少数已知码。因此
 * dispatchError 必须同时有机会进入 `detail`，分类器才能识别诊断文本——否则永远兜底「Agent 处理失败」。
 * 把 errorCode 串也喂给 detail 是安全的：它不会被正则误判（classifyFromText 返回 null，再由 errorCode
 * 分支命中）。
 */
export function buildFailedDispatchHintInput(input: {
  dispatchError?: string;
  metaDispatchErrorDetail?: string;
}): { status: 'failed'; errorCode?: string; detail?: string } {
  return {
    status: 'failed',
    errorCode: input.dispatchError,
    // server 未来显式下发的结构化 detail 优先；否则用 dispatchError 兜底，让诊断文本能被正则识别。
    detail: input.metaDispatchErrorDetail ?? input.dispatchError,
  };
}

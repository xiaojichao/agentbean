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

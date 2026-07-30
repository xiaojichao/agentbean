/**
 * ADR-0064 #948-F allocation_blocked 脱敏建议 —— 纯规则。
 *
 * 职责：当前频道无合格候选时，把「频道外能力」收敛为**脱敏建议**——只告诉有权人类
 * 「有 N 个频道外 agent 可胜任（建议把这类 agent 加入频道）」或「频道内外都无人可胜任
 * （须修订要求）」，**绝不泄露频道外 agent 身份**（ADR-0064：「频道外能力只以脱敏建议
 * 交给有权人类决定」）。
 *
 * 关键不变量（脱敏）：
 * - 输入 `AllocationCandidateDiagnosticView` 已是匿名诊断（hasRequiredCapabilities /
 *   channelForbidden），**不含 agentId**；调用方（broker）须在投影成诊断视图时即丢弃身份。
 * - 输出 `AllocationBlockedSuggestion` 只携带 cause + 匿名计数，类型层面无 agent 身份字段。
 * - 「频道外可胜任」= hasRequiredCapabilities && channelForbidden（有能力但被频道门禁挡）；
 *   频道内可胜任（channelForbidden=false）不计入外部（它在频道内，应已 eligible）。
 *
 * 无 server 依赖、无 IO。UnallocatableCause 来自 task-coverage-policy（#715 AC#2）。
 */
import type { UnallocatableCause } from './task-coverage-policy.js';

/** 单个候选的匿名诊断视图（broker 投影时丢弃 agentId）。 */
export interface AllocationCandidateDiagnosticView {
  /** 该候选具备 Task requiredCapabilities（即 CAPABILITY_MISSING 缺失）。 */
  readonly hasRequiredCapabilities: boolean;
  /** 该候选被频道门禁挡住（TASK_CHANNEL_FORBIDDEN，即「频道外」）。 */
  readonly channelForbidden: boolean;
}

export interface DesensitizeAllocationInput {
  readonly cause: UnallocatableCause;
  readonly candidates: readonly AllocationCandidateDiagnosticView[];
}

export type AllocationBlockedSuggestion =
  | { readonly kind: 'escalate_no_capability'; readonly cause: UnallocatableCause }
  | { readonly kind: 'escalate_external_capability'; readonly cause: UnallocatableCause; readonly externalAgentCount: number };

/**
 * 把无候选诊断脱敏为面向有权人类的建议。
 * - 存在频道外可胜任 agent → escalate_external_capability（匿名计数，建议加入频道）。
 * - 否则 → escalate_no_capability（频道内外都无人可胜任，须修订要求 / 新 DAG revision）。
 */
export function desensitizeAllocationSuggestion(input: DesensitizeAllocationInput): AllocationBlockedSuggestion {
  const externalAgentCount = input.candidates.filter(
    (candidate) => candidate.hasRequiredCapabilities && candidate.channelForbidden,
  ).length;
  if (externalAgentCount > 0) {
    return { kind: 'escalate_external_capability', cause: input.cause, externalAgentCount };
  }
  return { kind: 'escalate_no_capability', cause: input.cause };
}

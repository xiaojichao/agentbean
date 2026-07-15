import type { MemoryCandidateStatus } from '@agentbean/contracts';

/**
 * Memory Candidate 状态机（P3-10/11，issue #583）。
 *
 * 外部 Agent 提交的新结论以 `candidate` 进入，由用户/系统决定接受、拒绝或合并。domain 层只
 * 裁定"哪些 from→to 转移合法"；业务条件（accept 遇冲突须改走 merge、merge 须指定合法冲突目标
 * 等）由 service 层（memory-candidate-service）在调用本函数之外施加。
 *
 * 状态语义：
 * - `candidate`：刚提交，待冲突检测与决策。
 * - `conflict`：detectConflicts 标记的中间警示态——与现有 active Memory 来源冲突，不可自动 accept。
 * - `accepted` / `rejected` / `merged`：终态。
 *   accepted = 接受为独立新 active；merged = 经 supersede 取代冲突项；rejected = 丢弃。
 *
 * 合法转移：candidate → {accepted|rejected|merged|conflict}；conflict → {accepted|rejected|merged}。
 * 非法：终态迁出、自迁、conflict → candidate（中间警示态不可回退为未决）。
 */

const TERMINAL_CANDIDATE_STATUS: ReadonlySet<MemoryCandidateStatus> = new Set([
  'accepted',
  'rejected',
  'merged',
]);

export type CandidateTransitionDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'CANDIDATE_INVALID_TRANSITION' };

export function evaluateCandidateTransition(
  from: MemoryCandidateStatus,
  to: MemoryCandidateStatus,
): CandidateTransitionDecision {
  if (TERMINAL_CANDIDATE_STATUS.has(from)) {
    return { ok: false, reason: 'CANDIDATE_INVALID_TRANSITION' };
  }
  if (from === to) {
    return { ok: false, reason: 'CANDIDATE_INVALID_TRANSITION' };
  }
  if (from === 'conflict' && to === 'candidate') {
    return { ok: false, reason: 'CANDIDATE_INVALID_TRANSITION' };
  }
  return { ok: true };
}

/**
 * #1065 AC11 交付视图共享文本标签。
 *
 * Chat/Task/Files 三处 surface 消费同一组 Server 投影,标签语义也必须一致;
 * 状态一律有文本标签,不只依赖颜色/图标/悬停。
 */

/** 成员 review 状态(Server 的 ProjectArtifactVersionReviewState)。 */
export const REVIEW_STATE_LABELS: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  changes_requested: '要求修改',
  rejected: '已拒绝',
};

/** 整包引用投影策略(OutputPackageProjectionPolicy)。 */
export const POLICY_LABELS: Record<string, string> = {
  delivered: '交付版',
  current: '当前版',
  final: '最终版',
};

/** Task 责任焦点(TaskResponsibilityFocusKind)。 */
export const FOCUS_LABELS: Record<string, string> = {
  none: '等待分配',
  offer_wait: '等待 Agent 响应 Offer',
  claim_active: 'Agent 已建立执行 claim',
  execution_active: 'Agent 正在执行',
  review_wait: '等待人类验收/审核',
};

/** 执行链事件种类(TaskTimelineEventKind)。 */
export const TIMELINE_KIND_LABELS: Record<string, string> = {
  offer: '发布 Offer',
  acceptance: '接受 Offer',
  claim: '建立执行 claim',
  execution_start: '开始执行',
  delivery: '交付',
  human_revision: '人工修订',
  review: '审核',
  finalization: '设为最终版',
  reject_delivery: '退回交付',
  handoff: 'Agent 交接',
};

export function reviewStateLabel(state: string): string {
  return REVIEW_STATE_LABELS[state] ?? state;
}

export function policyLabel(policy: string): string {
  return POLICY_LABELS[policy] ?? policy;
}

export function focusLabel(kind: string): string {
  return FOCUS_LABELS[kind] ?? kind;
}

export function timelineKindLabel(kind: string): string {
  return TIMELINE_KIND_LABELS[kind] ?? kind;
}

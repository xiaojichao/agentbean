import type { FormalMemoryKind, FormalMemoryScopeType } from '@agentbean/contracts';

/** Formal Memory 四类产品标签（AC#2：新建入口只提供这四类）。 */
export const FORMAL_KIND_LABELS: Record<FormalMemoryKind, string> = {
  fact: '事实',
  decision: '决策',
  rule: '规则',
  preference: '偏好',
};

export const FORMAL_KIND_OPTIONS: ReadonlyArray<{ value: FormalMemoryKind; label: string }> = [
  { value: 'fact', label: '事实' },
  { value: 'decision', label: '决策' },
  { value: 'rule', label: '规则' },
  { value: 'preference', label: '偏好' },
];

export const FORMAL_SCOPE_OPTIONS: ReadonlyArray<{ value: FormalMemoryScopeType; label: string }> = [
  { value: 'team', label: 'Team' },
  { value: 'channel', label: '频道' },
];

/**
 * AC#3 停用语义：Formal Memory 的 expired 状态表达「管理员手动停用」，
 * 与「时间过期」共用 status 但靠 changeReason 区分。
 */
export function isDeactivated(status: string): boolean {
  return status === 'expired';
}

/** AC#8：这些状态的 Formal Memory 已退出有效检索。 */
export function isInactiveForRetrieval(status: string): boolean {
  return status === 'expired' || status === 'superseded' || status === 'deleted';
}

/** 友好的状态文案（区分「已停用」与「已过期」需结合 changeReason）。 */
export function formalStatusLabel(status: string, changeReason?: string): string {
  switch (status) {
    case 'active': return '生效中';
    case 'candidate': return '待审批';
    case 'expired': return changeReason ? '已停用' : '已过期';
    case 'superseded': return '已被取代';
    case 'deleted': return '已删除';
    case 'rejected': return '已驳回';
    default: return status;
  }
}

export interface FormalMemoryFormValues {
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason?: string;
}

/** 校验新建/修订表单；返回错误文案或 null。 */
export function validateFormalMemoryForm(values: FormalMemoryFormValues): string | null {
  if (!values.content.trim()) return '请填写 Formal Memory 正文';
  return null;
}

/** 校验纠错申请；返回错误文案或 null。 */
export function validateCorrectionForm(values: { content: string; reason: string }): string | null {
  if (!values.reason.trim()) return '请填写纠错理由';
  if (!values.content.trim()) return '请填写提议内容';
  return null;
}

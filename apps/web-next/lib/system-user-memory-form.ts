import type { FormalMemoryKind } from '@agentbean/contracts';

/**
 * System Knowledge 与 User Memory 的 web 表单纯函数（issue #717）。
 *
 * 与 Formal Memory（#716）共用 4 类产品 kind（ADR 0047），但状态机简化为
 * active/expired/superseded（无 candidate）。作用域由 socket 前缀（system-knowledge:/
 * user-memory:）与 UI data-scope 标记区分（AC#7）。
 */

/** 四类产品 kind 选项（复用 Formal Memory 类型，ADR 0047）。 */
export const SYSTEM_USER_KIND_OPTIONS: ReadonlyArray<{ value: FormalMemoryKind; label: string }> = [
  { value: 'fact', label: '事实' },
  { value: 'decision', label: '决策' },
  { value: 'rule', label: '规则' },
  { value: 'preference', label: '偏好' },
];

/**
 * User Memory 新建默认 kind（AC#4：个人偏好为主）。
 * System Knowledge 不设默认（管理员按需选）。
 */
export const DEFAULT_USER_MEMORY_KIND: FormalMemoryKind = 'preference';

/** 友好状态文案（三态：active/expired/superseded）。 */
export function systemUserStatusLabel(status: string, changeReason?: string): string {
  switch (status) {
    case 'active': return '生效中';
    case 'expired': return changeReason ? '已停用' : '已过期';
    case 'superseded': return '已被取代';
    default: return status;
  }
}

/** 退出有效检索/展示的状态（AC#8 语义：这些状态不再影响决策）。 */
export function isInactiveForRetrieval(status: string): boolean {
  return status === 'expired' || status === 'superseded';
}

export interface SystemUserMemoryFormValues {
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason?: string;
}

/** 校验新建/修订表单；返回错误文案或 null。 */
export function validateSystemUserMemoryForm(values: SystemUserMemoryFormValues): string | null {
  if (!values.content.trim()) return '请填写正文';
  if (!values.kind) return '请选择类型';
  return null;
}

/** 校验停用/删除原因（ADR 0046：记录变更原因）。 */
export function validateDeactivationReason(reason: string): string | null {
  if (!reason.trim()) return '请填写变更原因';
  return null;
}

/**
 * AC#4：评估 User Memory 内容是否符合「稳定个人偏好/工作习惯」约束。
 *
 * User Memory 不得保存 Team 业务事实、频道摘要、客户数据或其他用户信息。技术上无法
 * 精确判断内容性质，这里用启发式给出引导提示（不硬性阻塞创建），最终靠用户自觉 +
 * 审计（createdByUserId）兜底。
 *
 * 返回 { ok, hint }：ok=true 表示可创建；hint 为展示给用户的引导/警示文案。
 */
export interface UserMemoryContentAssessment {
  readonly ok: boolean;
  readonly hint?: string;
}

/**
 * AC#4 内容策略：纯文案引导（有意的产品决策，非 TODO）。
 *
 * 不做硬性内容校验——技术上无法可靠区分「个人偏好」与「业务事实」，启发式关键词
 * 检测会误判合法偏好。改为在创建表单实时展示通用引导 hint，靠用户自觉 + 审计
 * （createdByUserId）兜底。Team/业务记忆应进 Team Formal Memory（#716）。
 */
export function assessUserMemoryContentFit(content: string): UserMemoryContentAssessment {
  void content;
  return {
    ok: true,
    hint: '只记录稳定的个人偏好与工作习惯；Team 业务事实、客户数据、频道摘要请放 Team Memory。',
  };
}

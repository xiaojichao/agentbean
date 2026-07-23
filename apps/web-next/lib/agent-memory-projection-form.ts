/**
 * #718 Agent Memory Projection 草稿表单纯逻辑（web-next 约定：只测纯函数）。
 * 不含 IO/socket；组件负责调用 socket 并把结果喂给这些函数。
 */
import type { FormalMemoryKind } from '@agentbean/contracts';

export interface ProjectionDraftFormState {
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly validUntil: number | null;
}

export const EMPTY_PROJECTION_DRAFT_FORM: ProjectionDraftFormState = {
  kind: 'fact',
  content: '',
  summary: '',
  tags: [],
  validUntil: null,
};

export const PROJECTION_KIND_LABELS: Record<FormalMemoryKind, string> = {
  fact: '事实',
  decision: '决策',
  rule: '规则',
  preference: '偏好',
};

/** 状态 → 中文标签（owner 视图与消费视图共用）。 */
export function projectionStatusLabel(status: string): string {
  switch (status) {
    case 'draft': return '草稿';
    case 'active': return '生效中';
    case 'superseded': return '已取代';
    case 'expired': return '已过期';
    case 'withdrawn': return '已撤回';
    default: return status;
  }
}

/** 从 active/最近 projection 导出表单初值（「基于当前发布新建草稿」场景）。空 → 空表单。 */
export function draftFormFromProjection(
  projection: {
    readonly kind: FormalMemoryKind;
    readonly content: string;
    readonly summary?: string;
    readonly tags?: readonly string[];
    readonly validUntil: number | null;
  } | null,
): ProjectionDraftFormState {
  if (!projection) return { ...EMPTY_PROJECTION_DRAFT_FORM };
  return {
    kind: projection.kind,
    content: projection.content,
    summary: projection.summary ?? '',
    tags: projection.tags ? [...projection.tags] : [],
    validUntil: projection.validUntil,
  };
}

/**
 * 表单本地校验（与服务端 domain 校验对齐的子集，用于即时反馈）。
 * 返回错误文案或 null。tag 格式/长度、kind 枚举等由服务端兜底。
 */
export function validateProjectionDraftForm(form: ProjectionDraftFormState): string | null {
  if (!form.content.trim()) return '投影内容不能为空';
  return null;
}

/** tag 输入即时规范化（lowercase + trim）；非法字符/长度由服务端 domain 兜底 fail-closed。 */
export function normalizeTagInput(raw: string): string {
  return raw.toLowerCase().trim();
}

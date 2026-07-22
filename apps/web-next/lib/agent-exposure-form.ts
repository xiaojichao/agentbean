/**
 * #710 Agent Exposure 草稿表单纯逻辑（web-next 约定：只测纯函数）。
 * 不含 IO/socket；组件负责调用 socket 并把结果喂给这些函数。
 */

export interface ExposureCapabilityInput {
  readonly name: string;
  readonly description: string;
}

export interface ExposureDraftFormState {
  readonly capabilities: readonly ExposureCapabilityInput[];
  readonly skills: readonly ExposureCapabilityInput[];
  readonly validUntil: number | null;
  readonly available: boolean;
}

export const EMPTY_DRAFT_FORM: ExposureDraftFormState = {
  capabilities: [],
  skills: [],
  validUntil: null,
  available: true,
};

/** 从 active 投影导出表单初值（「基于当前发布新建草稿」场景）。投影为空 → 空表单。 */
export function draftFormFromProjection(
  projection: {
    readonly capabilities: readonly { name: string; description: string }[];
    readonly skills: readonly { name: string; description: string }[];
    readonly availability: { status: string };
    readonly validUntil: number | null;
  } | null,
): ExposureDraftFormState {
  if (!projection) return { ...EMPTY_DRAFT_FORM };
  return {
    capabilities: projection.capabilities.map((capability) => ({ name: capability.name, description: capability.description })),
    skills: projection.skills.map((skill) => ({ name: skill.name, description: skill.description })),
    validUntil: projection.validUntil,
    available: projection.availability.status === 'available',
  };
}

/** 增删 capability/skill 行的纯辅助（不可变）。 */
export function updateRow(
  rows: readonly ExposureCapabilityInput[],
  index: number,
  patch: Partial<ExposureCapabilityInput>,
): readonly ExposureCapabilityInput[] {
  return rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

/**
 * 表单本地校验（与服务端 domain 校验对齐的子集，用于即时反馈）。
 * 返回错误文案或 null。名称仅做trim/非空/去重检查；长度等由服务端兜底。
 */
export function validateDraftForm(form: ExposureDraftFormState): string | null {
  if (form.capabilities.length === 0) return '至少需要 1 个 Capability';
  for (const capability of form.capabilities) {
    if (!capability.name.trim()) return 'Capability 名称不能为空';
  }
  const names = form.capabilities.map((capability) => capability.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return 'Capability 名称不能重复';
  const skillNames = form.skills.map((skill) => skill.name.trim().toLowerCase()).filter(Boolean);
  if (new Set(skillNames).size !== skillNames.length) return 'Skill 名称不能重复';
  return null;
}

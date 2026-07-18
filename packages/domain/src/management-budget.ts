// Phase 4 第二阶段切片3（#648）：Team 预算覆盖的钳制与合并。
// 钳制只发生在 updatePolicy 写路径（非法整体拒绝 → VALIDATION_ERROR）；
// 读路径（route 消费）信任已钳制值，merge 逐字段 fallback，未配置覆盖的 Team 与 Phase 默认逐比特一致。

export const MANAGEMENT_BUDGET_LIMITS = {
  maxSubtasks: { min: 1, max: 50 },
  maxDepth: { min: 1, max: 5 },
  maxExternalInvocations: { min: 1, max: 100 },
} as const;

export interface ManagementBudgetShape {
  readonly maxSubtasks: number;
  readonly maxDepth: number;
  readonly maxExternalInvocations: number;
}

export type ManagementBudgetOverridesInput = {
  readonly [K in keyof ManagementBudgetShape]?: unknown;
};

export type ManagementBudgetOverrides = Partial<ManagementBudgetShape>;

function clampField(field: keyof ManagementBudgetShape, value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  const limits = MANAGEMENT_BUDGET_LIMITS[field];
  return Math.min(limits.max, Math.max(limits.min, value));
}

/**
 * 把用户提交的预算覆盖钳到上下限。任一字段非法（非整数/非有限数/非 number）→ 整体 null
 * （不留半个被信任的覆盖对象，由写路径映射为 VALIDATION_ERROR）。
 */
export function clampManagementBudgetOverrides(input: ManagementBudgetOverridesInput): ManagementBudgetOverrides | null {
  const result: { -readonly [K in keyof ManagementBudgetShape]?: number } = {};
  for (const field of Object.keys(MANAGEMENT_BUDGET_LIMITS) as Array<keyof ManagementBudgetShape>) {
    const clamped = clampField(field, input[field]);
    if (clamped === null) return null;
    if (clamped !== undefined) result[field] = clamped;
  }
  return result;
}

/** 覆盖合并：逐字段 ?? fallback，undefined/空覆盖与 base 逐比特一致。 */
export function mergeManagementBudget(base: ManagementBudgetShape, overrides: ManagementBudgetOverrides | undefined): ManagementBudgetShape {
  return {
    maxSubtasks: overrides?.maxSubtasks ?? base.maxSubtasks,
    maxDepth: overrides?.maxDepth ?? base.maxDepth,
    maxExternalInvocations: overrides?.maxExternalInvocations ?? base.maxExternalInvocations,
  };
}

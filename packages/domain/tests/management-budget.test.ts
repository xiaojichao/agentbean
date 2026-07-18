import { describe, expect, test } from 'vitest';

import {
  clampManagementBudgetOverrides,
  mergeManagementBudget,
  MANAGEMENT_BUDGET_LIMITS,
} from '../src/index.js';

// Phase 4 第二阶段切片3（#648）：Team 预算覆盖的钳制与合并。
// 钳制只发生在 updatePolicy 写路径；读路径（route 消费）信任已钳制值。
// 合并必须逐字段 fallback：未配置覆盖的 Team 行为与 Phase 默认逐比特一致。

describe('clampManagementBudgetOverrides', () => {
  test('空输入 → 空覆盖（无字段，回落 Phase 默认）', () => {
    expect(clampManagementBudgetOverrides({})).toEqual({});
    expect(clampManagementBudgetOverrides({ maxSubtasks: undefined })).toEqual({});
  });

  test('范围内值原样保留', () => {
    expect(clampManagementBudgetOverrides({ maxSubtasks: 10, maxDepth: 3, maxExternalInvocations: 50 }))
      .toEqual({ maxSubtasks: 10, maxDepth: 3, maxExternalInvocations: 50 });
  });

  test('低于下限钳到下限，高于上限钳到上限', () => {
    expect(clampManagementBudgetOverrides({ maxSubtasks: 0 })).toEqual({ maxSubtasks: MANAGEMENT_BUDGET_LIMITS.maxSubtasks.min });
    expect(clampManagementBudgetOverrides({ maxSubtasks: 9999 })).toEqual({ maxSubtasks: MANAGEMENT_BUDGET_LIMITS.maxSubtasks.max });
    expect(clampManagementBudgetOverrides({ maxDepth: 0 })).toEqual({ maxDepth: MANAGEMENT_BUDGET_LIMITS.maxDepth.min });
    expect(clampManagementBudgetOverrides({ maxDepth: 99 })).toEqual({ maxDepth: MANAGEMENT_BUDGET_LIMITS.maxDepth.max });
    expect(clampManagementBudgetOverrides({ maxExternalInvocations: -5 })).toEqual({ maxExternalInvocations: MANAGEMENT_BUDGET_LIMITS.maxExternalInvocations.min });
    expect(clampManagementBudgetOverrides({ maxExternalInvocations: 100000 })).toEqual({ maxExternalInvocations: MANAGEMENT_BUDGET_LIMITS.maxExternalInvocations.max });
  });

  test('非整数/非数值 → 整体拒绝（null，由写路径映射 VALIDATION_ERROR）', () => {
    expect(clampManagementBudgetOverrides({ maxSubtasks: 2.5 })).toBeNull();
    expect(clampManagementBudgetOverrides({ maxDepth: Number.NaN })).toBeNull();
    expect(clampManagementBudgetOverrides({ maxExternalInvocations: '20' as unknown as number })).toBeNull();
    expect(clampManagementBudgetOverrides({ maxSubtasks: Number.POSITIVE_INFINITY })).toBeNull();
  });

  test('单字段非法整体拒绝（不留半个被信任的覆盖对象）', () => {
    expect(clampManagementBudgetOverrides({ maxSubtasks: 10, maxDepth: 2.5 })).toBeNull();
  });

  test('上下限常量与规格一致（maxDepth 1–5 / maxSubtasks 1–50 / maxExternalInvocations 1–100）', () => {
    expect(MANAGEMENT_BUDGET_LIMITS).toEqual({
      maxSubtasks: { min: 1, max: 50 },
      maxDepth: { min: 1, max: 5 },
      maxExternalInvocations: { min: 1, max: 100 },
    });
  });
});

describe('mergeManagementBudget', () => {
  const phaseDefault = { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 };

  test('无覆盖 → 逐比特等于 Phase 默认（回归红线）', () => {
    expect(mergeManagementBudget(phaseDefault, undefined)).toEqual(phaseDefault);
    expect(mergeManagementBudget(phaseDefault, {})).toEqual(phaseDefault);
  });

  test('部分覆盖逐字段 fallback，未覆盖字段保持默认', () => {
    expect(mergeManagementBudget(phaseDefault, { maxSubtasks: 50 }))
      .toEqual({ maxSubtasks: 50, maxDepth: 3, maxExternalInvocations: 20 });
    expect(mergeManagementBudget(phaseDefault, { maxDepth: 5, maxExternalInvocations: 100 }))
      .toEqual({ maxSubtasks: 20, maxDepth: 5, maxExternalInvocations: 100 });
  });
});

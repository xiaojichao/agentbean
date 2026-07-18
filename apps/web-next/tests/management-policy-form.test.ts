import { describe, expect, test } from 'vitest';
import {
  AUTO_PLACEMENT_NOTICE,
  buildBudgetOverridesPayload,
  buildPlacementPolicyPayload,
  budgetDefaultsForPhase,
  budgetFormStateFromOverrides,
  MANAGED_PLACEMENT_PRIVACY_NOTICE,
  placementFormStateFromPolicy,
  placementOnModeChange,
  validatePlacementForm,
  type PlacementFormState,
} from '../lib/management-policy-form';

// Phase 4 第二阶段切片1（#646）：PI 管理面板的 placement 表单纯逻辑。
// 校验规则必须与 server 端对齐：management-router.ts updatePolicy（managed 要求 mode=managed 且 phase≥2；
// managed 模式下 placement='device' 必须有 allowedDeviceIds，auto 无此强制）与 normalizePlacementPolicy
//（managed 强制 allowServerContext=true / requireLocalModelCredentials=false / 无 allowedDeviceIds；
// device/auto 分支保留客户端的 allowServerContext / requireLocalModelCredentials）。
// 授权字段与已有 auto policy 必须原样往返，不允许表单丢弃后硬编码回写（PR#651 review 回归修复）。
// 沿用 web-next 惯例：只测 lib 纯函数，不测组件。

const baseState: PlacementFormState = {
  mode: 'managed',
  maxManagementPhase: 2,
  placement: 'device',
  allowedDeviceIds: ['device-1'],
  allowServerContext: false,
  requireLocalModelCredentials: true,
  preferredProvider: '',
  preferredModel: '',
};

describe('placementFormStateFromPolicy', () => {
  test('无 policy（从未配置）→ 安全默认：direct + Phase 1 + device placement', () => {
    const state = placementFormStateFromPolicy(null);
    expect(state.mode).toBe('direct');
    expect(state.maxManagementPhase).toBe(1);
    expect(state.placement).toBe('device');
    expect(state.allowedDeviceIds).toEqual([]);
    expect(state.allowServerContext).toBe(false);
    expect(state.requireLocalModelCredentials).toBe(true);
    expect(state.preferredProvider).toBe('');
    expect(state.preferredModel).toBe('');
  });

  test('device policy → 回填 placement / allowedDeviceIds / provider 偏好', () => {
    const state = placementFormStateFromPolicy({
      mode: 'managed',
      maxManagementPhase: 2,
      placementPolicy: {
        placement: 'device',
        allowedDeviceIds: ['device-a', 'device-b'],
        allowServerContext: false,
        requireLocalModelCredentials: true,
        preferredProvider: 'anthropic',
        preferredModel: 'claude-fable-5',
      },
    });
    expect(state.placement).toBe('device');
    expect(state.allowedDeviceIds).toEqual(['device-a', 'device-b']);
    expect(state.preferredProvider).toBe('anthropic');
    expect(state.preferredModel).toBe('claude-fable-5');
  });

  test('managed policy → placement 回填为 managed（面板不再把它压回 device）', () => {
    const state = placementFormStateFromPolicy({
      mode: 'managed',
      maxManagementPhase: 3,
      placementPolicy: {
        placement: 'managed',
        allowServerContext: true,
        requireLocalModelCredentials: false,
      },
    });
    expect(state.placement).toBe('managed');
    expect(state.allowedDeviceIds).toEqual([]);
  });

  test('device policy 的授权字段原样回填（缺省字段与 server normalize 一致：false / true）', () => {
    const state = placementFormStateFromPolicy({
      mode: 'managed',
      maxManagementPhase: 2,
      placementPolicy: {
        placement: 'device',
        allowedDeviceIds: ['device-a'],
        allowServerContext: true,
        requireLocalModelCredentials: false,
      },
    });
    expect(state.allowServerContext).toBe(true);
    expect(state.requireLocalModelCredentials).toBe(false);

    const defaulted = placementFormStateFromPolicy({
      mode: 'direct',
      maxManagementPhase: 1,
      placementPolicy: { placement: 'device' },
    });
    expect(defaulted.allowServerContext).toBe(false);
    expect(defaulted.requireLocalModelCredentials).toBe(true);
  });

  test('auto policy → placement 原样保留为 auto，不折叠成 device（切片2 前的保留透传）', () => {
    const state = placementFormStateFromPolicy({
      mode: 'managed',
      maxManagementPhase: 2,
      placementPolicy: {
        placement: 'auto',
        allowedDeviceIds: ['device-a'],
        allowServerContext: true,
        requireLocalModelCredentials: false,
      },
    });
    expect(state.placement).toBe('auto');
    expect(state.allowedDeviceIds).toEqual(['device-a']);
    expect(state.allowServerContext).toBe(true);
    expect(state.requireLocalModelCredentials).toBe(false);
  });
});

describe('buildPlacementPolicyPayload', () => {
  test('managed → 满足 server 约束：allowServerContext=true / requireLocalModelCredentials=false / 无 allowedDeviceIds', () => {
    const payload = buildPlacementPolicyPayload({
      ...baseState,
      placement: 'managed',
      allowedDeviceIds: ['device-1'], // 表单残留也必须剥掉，否则 server normalize 拒绝
    });
    expect(payload).toEqual({
      placement: 'managed',
      allowServerContext: true,
      requireLocalModelCredentials: false,
    });
  });

  test('managed + provider 偏好 → trim 后保留；空白偏好省略字段', () => {
    const withPrefs = buildPlacementPolicyPayload({
      ...baseState,
      placement: 'managed',
      preferredProvider: '  anthropic  ',
      preferredModel: 'claude-fable-5',
    });
    expect(withPrefs.preferredProvider).toBe('anthropic');
    expect(withPrefs.preferredModel).toBe('claude-fable-5');

    const blank = buildPlacementPolicyPayload({
      ...baseState,
      placement: 'managed',
      preferredProvider: '   ',
      preferredModel: '',
    });
    expect('preferredProvider' in blank).toBe(false);
    expect('preferredModel' in blank).toBe(false);
  });

  test('device → 保留 allowedDeviceIds 且去重，授权字段透传表单原值（不硬编码）', () => {
    const payload = buildPlacementPolicyPayload({
      ...baseState,
      allowedDeviceIds: ['device-1', 'device-1', 'device-2'],
    });
    expect(payload.placement).toBe('device');
    expect(payload.allowedDeviceIds).toEqual(['device-1', 'device-2']);
    expect(payload.requireLocalModelCredentials).toBe(true);
    expect(payload.allowServerContext).toBe(false);
  });

  test('device + 已有授权（allowServerContext=true）→ 保存不回写为 false（PR#651 review 回归）', () => {
    const payload = buildPlacementPolicyPayload({
      ...baseState,
      allowServerContext: true,
      requireLocalModelCredentials: false,
    });
    expect(payload.allowServerContext).toBe(true);
    expect(payload.requireLocalModelCredentials).toBe(false);
  });

  test('auto → payload 保留 placement=auto 与全部原字段，不折叠成 device（PR#651 review 回归）', () => {
    const payload = buildPlacementPolicyPayload({
      ...baseState,
      placement: 'auto',
      allowServerContext: true,
      requireLocalModelCredentials: false,
    });
    expect(payload.placement).toBe('auto');
    expect(payload.allowedDeviceIds).toEqual(['device-1']);
    expect(payload.allowServerContext).toBe(true);
    expect(payload.requireLocalModelCredentials).toBe(false);
  });

  test('device 无勾选 device → allowedDeviceIds 字段省略（而非空数组，与 server normalize 一致）', () => {
    const payload = buildPlacementPolicyPayload({ ...baseState, allowedDeviceIds: [] });
    expect('allowedDeviceIds' in payload).toBe(false);
  });
});

describe('validatePlacementForm（与 server updatePolicy 规则对齐的可读提示）', () => {
  test('managed placement + mode=direct → 错误（server: managed 要求 mode=managed）', () => {
    const message = validatePlacementForm({ ...baseState, mode: 'direct', placement: 'managed' });
    expect(message).toContain('managed');
    expect(message).not.toBeNull();
  });

  test('managed placement + Phase 1 → 错误（server: managed 要求 phase≥2）', () => {
    const message = validatePlacementForm({ ...baseState, maxManagementPhase: 1, placement: 'managed' });
    expect(message).not.toBeNull();
    expect(message).toContain('Phase 2');
  });

  test('managed placement + mode=managed + Phase 2 → 合法', () => {
    expect(validatePlacementForm({ ...baseState, placement: 'managed' })).toBeNull();
  });

  test('managed 模式 + device placement + 无勾选 device → 错误（server: 至少一个 allowedDeviceIds）', () => {
    const message = validatePlacementForm({ ...baseState, allowedDeviceIds: [] });
    expect(message).not.toBeNull();
    expect(message).toContain('Device');
  });

  test('managed 模式 + device placement + 有勾选 → 合法', () => {
    expect(validatePlacementForm(baseState)).toBeNull();
  });

  test('direct 模式 + device placement + 无勾选 → 合法（server 只在 managed 模式要求 device 列表）', () => {
    expect(validatePlacementForm({ ...baseState, mode: 'direct', allowedDeviceIds: [] })).toBeNull();
  });

  test('managed 模式 + auto placement + 无勾选 → 合法（server 的 device 列表强制仅针对 placement=device）', () => {
    expect(validatePlacementForm({ ...baseState, placement: 'auto', allowedDeviceIds: [] })).toBeNull();
  });
});

describe('placementOnModeChange（mode 往返不丢 managed placement 选择）', () => {
  test('切出 managed → placement 归位 device（可保存的安全默认）并记住原选择', () => {
    const result = placementOnModeChange('managed', 'managed', 'direct');
    expect(result.placement).toBe('device');
    expect(result.remembered).toBe('managed');
  });

  test('切回 managed → 恢复记忆的 placement（往返不丢选择）', () => {
    // 初始 placement=managed，切到 direct（记忆 managed），再切回 managed
    const away = placementOnModeChange('managed', 'managed', 'direct');
    const back = placementOnModeChange(away.placement, away.remembered, 'managed');
    expect(back.placement).toBe('managed');
  });

  test('切出前就是 device → 记忆 device，切回后仍是 device', () => {
    const away = placementOnModeChange('device', 'device', 'shadow');
    const back = placementOnModeChange(away.placement, away.remembered, 'managed');
    expect(back.placement).toBe('device');
  });

  test('auto 不依赖 managed 模式 → mode 切换原样保留，不参与记忆恢复', () => {
    const away = placementOnModeChange('auto', 'device', 'direct');
    expect(away.placement).toBe('auto');
    expect(away.remembered).toBe('device');
    const back = placementOnModeChange(away.placement, away.remembered, 'managed');
    expect(back.placement).toBe('auto');
  });
});

describe('MANAGED_PLACEMENT_PRIVACY_NOTICE', () => {
  test('隐私提示覆盖关键事实：发送至 Server provider / 最小授权范围 / 审计 / Device 本地内容不上传', () => {
    expect(MANAGED_PLACEMENT_PRIVACY_NOTICE).toContain('Server');
    expect(MANAGED_PLACEMENT_PRIVACY_NOTICE).toContain('审计');
    expect(MANAGED_PLACEMENT_PRIVACY_NOTICE).toContain('不会上传');
  });
});

describe('AUTO_PLACEMENT_NOTICE（#647）', () => {
  test('auto 说明覆盖决策语义：本地优先 / Server 兜底 / 冻结可审计', () => {
    expect(AUTO_PLACEMENT_NOTICE).toContain('本地优先');
    expect(AUTO_PLACEMENT_NOTICE).toContain('Server Worker 兜底');
    expect(AUTO_PLACEMENT_NOTICE).toContain('审计');
  });
});

describe('预算表单（#648）', () => {
  test('budgetFormStateFromOverrides：无覆盖 → 全空串（留空回落默认）；有覆盖 → 回填字符串', () => {
    expect(budgetFormStateFromOverrides(undefined)).toEqual({ maxSubtasks: '', maxDepth: '', maxExternalInvocations: '' });
    expect(budgetFormStateFromOverrides({ maxSubtasks: 30, maxDepth: 2 }))
      .toEqual({ maxSubtasks: '30', maxDepth: '2', maxExternalInvocations: '' });
  });

  test('buildBudgetOverridesPayload：全空 → 空对象（清空覆盖回落默认）', () => {
    expect(buildBudgetOverridesPayload({ maxSubtasks: '', maxDepth: '', maxExternalInvocations: '' }))
      .toEqual({ payload: {} });
  });

  test('buildBudgetOverridesPayload：部分填写 → 仅含所填字段的 number', () => {
    expect(buildBudgetOverridesPayload({ maxSubtasks: '30', maxDepth: '', maxExternalInvocations: '80' }))
      .toEqual({ payload: { maxSubtasks: 30, maxExternalInvocations: 80 } });
  });

  test('buildBudgetOverridesPayload：非整数/负数输入 → 错误提示（server clamp 前的 UI 层拦截）', () => {
    expect(buildBudgetOverridesPayload({ maxSubtasks: 'abc', maxDepth: '', maxExternalInvocations: '' }).error).toContain('正整数');
    expect(buildBudgetOverridesPayload({ maxSubtasks: '', maxDepth: '2.5', maxExternalInvocations: '' }).error).toContain('正整数');
    expect(buildBudgetOverridesPayload({ maxSubtasks: '-3', maxDepth: '', maxExternalInvocations: '' }).error).toContain('正整数');
  });

  test('budgetDefaultsForPhase：phase 1 为 1/1/1，phase 2/3 为 20/3/20（与 server PHASE_*_BUDGET 一致）', () => {
    expect(budgetDefaultsForPhase(1)).toEqual({ maxSubtasks: 1, maxDepth: 1, maxExternalInvocations: 1 });
    expect(budgetDefaultsForPhase(2)).toEqual({ maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 });
    expect(budgetDefaultsForPhase(3)).toEqual({ maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 });
  });
});

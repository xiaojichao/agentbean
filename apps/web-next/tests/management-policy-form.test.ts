import { describe, expect, test } from 'vitest';
import {
  buildPlacementPolicyPayload,
  MANAGED_PLACEMENT_PRIVACY_NOTICE,
  placementFormStateFromPolicy,
  placementOnModeChange,
  validatePlacementForm,
  type PlacementFormState,
} from '../lib/management-policy-form';

// Phase 4 第二阶段切片1（#646）：PI 管理面板的 placement 表单纯逻辑。
// 校验规则必须与 server 端对齐：management-router.ts updatePolicy（managed 要求 mode=managed 且 phase≥2；
// managed 模式下 device placement 必须有 allowedDeviceIds）与 normalizePlacementPolicy（managed 强制
// allowServerContext=true / requireLocalModelCredentials=false / 无 allowedDeviceIds）。
// 沿用 web-next 惯例：只测 lib 纯函数，不测组件。

const baseState: PlacementFormState = {
  mode: 'managed',
  maxManagementPhase: 2,
  placement: 'device',
  allowedDeviceIds: ['device-1'],
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

  test('device → 保留 allowedDeviceIds 且去重，requireLocalModelCredentials 默认 true', () => {
    const payload = buildPlacementPolicyPayload({
      ...baseState,
      allowedDeviceIds: ['device-1', 'device-1', 'device-2'],
    });
    expect(payload.placement).toBe('device');
    expect(payload.allowedDeviceIds).toEqual(['device-1', 'device-2']);
    expect(payload.requireLocalModelCredentials).toBe(true);
    expect(payload.allowServerContext).toBe(false);
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
});

describe('MANAGED_PLACEMENT_PRIVACY_NOTICE', () => {
  test('隐私提示覆盖关键事实：发送至 Server provider / 最小授权范围 / 审计 / Device 本地内容不上传', () => {
    expect(MANAGED_PLACEMENT_PRIVACY_NOTICE).toContain('Server');
    expect(MANAGED_PLACEMENT_PRIVACY_NOTICE).toContain('审计');
    expect(MANAGED_PLACEMENT_PRIVACY_NOTICE).toContain('不会上传');
  });
});

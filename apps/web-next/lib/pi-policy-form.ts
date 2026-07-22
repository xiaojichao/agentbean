/**
 * PI 自动协调开关的纯表单逻辑（#707）。
 * 默认开启；从 socket 读取失败或缺失时回落默认开启（AC#2）。
 */

export interface PiPolicyFormState {
  readonly autoCoordinationEnabled: boolean;
}

/** 新 Team / 未读取时默认开启自动协调（AC#2）。 */
export const DEFAULT_PI_POLICY_STATE: PiPolicyFormState = { autoCoordinationEnabled: true };

/** 从 socket get 结果导出开关状态；缺失/失败时回落默认开启。 */
export function piPolicyStateFromResult(
  result: { ok: boolean; autoCoordinationEnabled?: boolean },
): PiPolicyFormState {
  if (result.ok && typeof result.autoCoordinationEnabled === 'boolean') {
    return { autoCoordinationEnabled: result.autoCoordinationEnabled };
  }
  return DEFAULT_PI_POLICY_STATE;
}

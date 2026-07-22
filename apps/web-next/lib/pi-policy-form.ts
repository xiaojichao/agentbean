/**
 * PI 自动协调开关的纯表单逻辑（#707）。
 * 新 Team 的默认开启由 Server policy 默认值保证；Web 只展示 Server 返回的可信状态。
 */

export interface PiPolicyFormState {
  readonly autoCoordinationEnabled: boolean | null;
}

/** 未读取、读取失败或响应缺字段时保持未知，避免把失败误报为“已开启”。 */
export const UNKNOWN_PI_POLICY_STATE: PiPolicyFormState = { autoCoordinationEnabled: null };

/** 从 socket get 结果导出开关状态；只有明确的 boolean 响应才是可信状态。 */
export function piPolicyStateFromResult(
  result: { ok: boolean; autoCoordinationEnabled?: boolean },
): PiPolicyFormState {
  if (result.ok && typeof result.autoCoordinationEnabled === 'boolean') {
    return { autoCoordinationEnabled: result.autoCoordinationEnabled };
  }
  return UNKNOWN_PI_POLICY_STATE;
}

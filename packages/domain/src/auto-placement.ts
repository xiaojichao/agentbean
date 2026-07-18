// Phase 4 第二阶段切片2（#647）：auto placement 决策。
// 总设计 §8.1：auto 根据隐私、在线状态选择；「不会在未授权情况下把 Device-only 上下文迁移到 Server」。
// 决策为布尔级信号（第一版不做排队深度/成本加权），纯函数，决策矩阵见 tests/auto-placement.test.ts。

export interface ResolveAutoPlacementInput {
  /** Team policy 是否授权内容进入 Server（placementPolicy.allowServerContext）。 */
  readonly allowServerContext: boolean;
  /** 是否存在在线、已授权、credential ready 的 Device Worker。 */
  readonly deviceAvailable: boolean;
  /** Server Worker 池是否有已连接 worker + 余量容量 + credential production_ready。 */
  readonly serverAvailable: boolean;
}

export type AutoPlacementSuccessReason =
  /** device 可用：本地优先（隐私默认），无论是否授权 server。 */
  | 'device-preferred'
  /** device 不可用且已授权 server：server 兜底。 */
  | 'server-fallback-device-unavailable';

export type AutoPlacementFailureReason =
  /** 红线：device 不可用且未授权 server，fail closed，不静默迁移。 */
  | 'unavailable-device-offline-server-disallowed'
  /** 两侧都不可用（已授权但 server 无可用容量/credential）。 */
  | 'unavailable-no-capacity';

export type AutoPlacementReason = AutoPlacementSuccessReason | AutoPlacementFailureReason;

export type AutoPlacementResolution =
  | { readonly ok: true; readonly placement: 'device' | 'managed'; readonly reasonCode: AutoPlacementSuccessReason }
  | { readonly ok: false; readonly reasonCode: AutoPlacementFailureReason };

/**
 * 把 placement='auto' 解析为确定性的 device|managed（或明确失败）。
 * 安全不变量：
 * - allowServerContext=false → 永不返回 managed；
 * - serverAvailable=false → 永不返回 managed；
 * - 失败永远显式（ok:false + 理由码），不静默回退任何 placement。
 */
export function resolveAutoPlacement(input: ResolveAutoPlacementInput): AutoPlacementResolution {
  if (input.deviceAvailable) {
    return { ok: true, placement: 'device', reasonCode: 'device-preferred' };
  }
  if (!input.allowServerContext) {
    return { ok: false, reasonCode: 'unavailable-device-offline-server-disallowed' };
  }
  if (input.serverAvailable) {
    return { ok: true, placement: 'managed', reasonCode: 'server-fallback-device-unavailable' };
  }
  return { ok: false, reasonCode: 'unavailable-no-capacity' };
}

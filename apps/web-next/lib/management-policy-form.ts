// Phase 4 第二阶段切片1（#646）：PI 管理面板的 placement 表单纯逻辑。
// 校验规则与 server 端对齐（management-router.ts）：
// - updatePolicy：placement='managed' 要求 mode='managed' 且 maxManagementPhase≥2；
//   mode='managed' + placement='device' 必须至少一个 allowedDeviceIds（auto 无此强制）。
// - normalizePlacementPolicy：managed 强制 allowServerContext=true / requireLocalModelCredentials=false /
//   不允许 allowedDeviceIds；device/auto 分支**保留客户端的 allowServerContext /
//   requireLocalModelCredentials**；preferred* 仅 trim 后非空才保留。
// UI 在保存前用 validatePlacementForm 给出可读提示，避免裸 server VALIDATION_ERROR。
// `auto` 属于切片2（#647），UI 不提供该选项；但已有 auto policy 必须原样保留往返，
// 不允许读入时折叠成 device 后在保存时静默回写（隐私相关设置，静默变更不可接受）。

import type { ManagementMode, ManagerPlacementPolicyDto } from '@agentbean/contracts';

/** placement 合同值全集；UI 只开放 device/managed，auto 仅作保留透传。 */
export type PlacementChoice = ManagerPlacementPolicyDto['placement'];

export interface PlacementFormState {
  mode: ManagementMode;
  maxManagementPhase: 1 | 2 | 3;
  placement: PlacementChoice;
  allowedDeviceIds: readonly string[];
  /**
   * 透传字段：UI 不暴露编辑，但必须随 policy 原样往返——server device/auto 分支保留
   * 客户端值，表单若丢弃后在 payload 里硬编码，会把已有授权静默改写。
   */
  allowServerContext: boolean;
  requireLocalModelCredentials: boolean;
  /** 输入框原始字符串；提交时 trim，空白视为未填。 */
  preferredProvider: string;
  preferredModel: string;
}

export interface ManagementPolicyLike {
  mode: ManagementMode;
  maxManagementPhase: 1 | 2 | 3;
  placementPolicy: ManagerPlacementPolicyDto;
}

/** managed placement 的知情授权文案（与 #626 审计投影范围对齐）。 */
export const MANAGED_PLACEMENT_PRIVACY_NOTICE =
  'managed placement 下，Server Worker 将以你的身份在 Server 端执行任务：完成任务所需的最小授权内容（根消息、根任务、可见讨论串与管理状态）会发送至 Server provider，每次访问均写入审计。Device 本地 Memory、本地文件与凭据不会上传。';

/** 从 server policy 推导表单状态；无 policy 时给安全默认（direct + Phase 1 + device）。 */
export function placementFormStateFromPolicy(policy: ManagementPolicyLike | null): PlacementFormState {
  if (!policy) {
    return {
      mode: 'direct',
      maxManagementPhase: 1,
      placement: 'device',
      allowedDeviceIds: [],
      allowServerContext: false,
      requireLocalModelCredentials: true,
      preferredProvider: '',
      preferredModel: '',
    };
  }
  const { placementPolicy } = policy;
  return {
    mode: policy.mode,
    maxManagementPhase: policy.maxManagementPhase,
    // placement 原样保留（含 auto）；缺省值与 server normalize 一致（absent → false / true）。
    placement: placementPolicy.placement,
    allowedDeviceIds: placementPolicy.allowedDeviceIds ? [...placementPolicy.allowedDeviceIds] : [],
    allowServerContext: placementPolicy.allowServerContext ?? false,
    requireLocalModelCredentials: placementPolicy.requireLocalModelCredentials ?? true,
    preferredProvider: placementPolicy.preferredProvider ?? '',
    preferredModel: placementPolicy.preferredModel ?? '',
  };
}

/** 表单状态 → 提交 payload，与 server normalizePlacementPolicy 的规范化结果对齐。 */
export function buildPlacementPolicyPayload(state: PlacementFormState): ManagerPlacementPolicyDto {
  const preferredProvider = state.preferredProvider.trim();
  const preferredModel = state.preferredModel.trim();
  const preferred = {
    ...(preferredProvider ? { preferredProvider } : {}),
    ...(preferredModel ? { preferredModel } : {}),
  };
  if (state.placement === 'managed') {
    // server 硬约束：managed 必须 allowServerContext=true / requireLocalModelCredentials=false，
    // 且不允许携带 allowedDeviceIds（表单残留也要剥掉，否则 server 拒绝）。
    return {
      placement: 'managed',
      allowServerContext: true,
      requireLocalModelCredentials: false,
      ...preferred,
    };
  }
  // device / auto 共用分支：与 server normalize 一致——allowedDeviceIds 空则省略字段，
  // allowServerContext / requireLocalModelCredentials 保留表单持有的原值（不硬编码）。
  const allowedDeviceIds = [...new Set(state.allowedDeviceIds.filter((id) => id.length > 0))];
  return {
    placement: state.placement,
    ...(allowedDeviceIds.length ? { allowedDeviceIds } : {}),
    allowServerContext: state.allowServerContext,
    requireLocalModelCredentials: state.requireLocalModelCredentials,
    ...preferred,
  };
}

/**
 * mode 切换时的 placement 联动：切出 managed 时 placement 归位 device（可保存的安全默认）
 * 并记住原选择；切回 managed 时恢复记忆值，避免「mode 往返」静默丢弃用户已选的
 * managed placement（placement 是隐私相关设置，静默变更不可接受）。
 * auto 不依赖 managed 模式（server 无此约束），mode 切换原样保留、不参与记忆恢复。
 */
export function placementOnModeChange(
  currentPlacement: PlacementChoice,
  rememberedPlacement: 'device' | 'managed',
  nextMode: ManagementMode,
): { placement: PlacementChoice; remembered: 'device' | 'managed' } {
  if (currentPlacement === 'auto') {
    return { placement: 'auto', remembered: rememberedPlacement };
  }
  if (nextMode === 'managed') {
    return { placement: rememberedPlacement, remembered: rememberedPlacement };
  }
  return { placement: 'device', remembered: currentPlacement };
}

/** 保存前校验：返回可读错误消息，合法返回 null。规则与 server updatePolicy 一一对应。 */
export function validatePlacementForm(state: PlacementFormState): string | null {
  if (state.placement === 'managed') {
    if (state.mode !== 'managed') {
      return 'managed placement 要求路由模式为 managed（Server Worker 只承接 PI Manager 接管的请求）';
    }
    if (state.maxManagementPhase < 2) {
      return 'managed placement 要求最高管理阶段至少为 Phase 2';
    }
    return null;
  }
  // server 的 device 列表强制仅针对 placement==='device'；auto 无额外约束（决策语义属切片2）。
  if (state.placement === 'device' && state.mode === 'managed' && state.allowedDeviceIds.length === 0) {
    return 'managed 模式下使用 device placement 需至少勾选一个允许承载的 Device';
  }
  return null;
}

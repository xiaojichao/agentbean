import type { UnixMs } from './common.js';

/**
 * Capability Registry 首版使用的稳定契约版本。
 * registry reference 由 Server 生成，Agent/PI 不能自报或临时创造。
 */
export const CAPABILITY_REGISTRY_VERSION = 1 as const;

export interface CapabilityRegistryReferenceDto {
  readonly capabilityId: string;
  readonly registryVersion: typeof CAPABILITY_REGISTRY_VERSION;
}

export type CapabilityEvidenceSource =
  | 'descriptor_scan'
  | 'descriptor_summary'
  | 'owner_attestation'
  | 'runtime_verification';

export type CapabilityEvidenceStatus =
  | 'observed'
  | 'owner_confirmed'
  | 'runtime_verified'
  | 'failed'
  | 'stale';

/**
 * 可公开的 Capability Evidence 投影。
 * provenance 只能使用 Server 注册的稳定来源码，不得包含本地路径、工具清单或原始文档。
 */
export interface CapabilityEvidenceDto {
  readonly source: CapabilityEvidenceSource;
  readonly status: CapabilityEvidenceStatus;
  readonly provenance: string;
  /** Evidence 被 Server 绑定到 Manifest 的时间；不伪装成原始扫描发生时间。 */
  readonly recordedAt: UnixMs;
  /** 只有 adapter 能证明真实观察时间时才提供。 */
  readonly observedAt?: UnixMs | null;
  readonly validUntil: UnixMs | null;
  readonly failureReason?: string | null;
}

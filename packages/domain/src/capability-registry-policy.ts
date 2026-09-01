import {
  CAPABILITY_REGISTRY_VERSION,
  type AgentExposureCapabilityDto,
  type CapabilityEvidenceDto,
  type CapabilityRegistryReferenceDto,
} from '@agentbean/contracts';

const DESCRIPTOR_SCAN_PROVENANCE = 'agent-descriptor-capabilities-v1';
const DESCRIPTOR_SUMMARY_PROVENANCE = 'agent-descriptor-summary-v1';
const OWNER_ATTESTATION_PROVENANCE = 'agent-exposure-owner-review-v1';

function normalizedCapabilityName(name: string): string {
  const normalized = name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) throw new Error('Capability name cannot be empty');
  return normalized;
}

/**
 * 首版 Registry identity：由清理后的公开 capability 名确定性生成。
 * 同名（忽略大小写、空白与 Unicode 宽度差异）能力得到同一 ID；只有 Server 调用本函数。
 */
export function capabilityRegistryReferenceForName(name: string): CapabilityRegistryReferenceDto {
  const normalized = normalizedCapabilityName(name);
  return {
    capabilityId: `capability:v${CAPABILITY_REGISTRY_VERSION}:${encodeURIComponent(normalized)}`,
    registryVersion: CAPABILITY_REGISTRY_VERSION,
  };
}

function containsCandidate(candidates: readonly string[], name: string): boolean {
  const expected = normalizedCapabilityName(name);
  return candidates.some((candidate) => {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) return false;
    return normalizedCapabilityName(candidate) === expected;
  });
}

export interface BindAgentExposureCapabilityInput {
  readonly capability: Pick<AgentExposureCapabilityDto, 'name' | 'description'>;
  readonly deterministicCandidates: readonly string[];
  readonly summarizedCandidates: readonly string[];
  readonly recordedAt: number;
}

/**
 * 把 owner 已选择的公开 capability 绑定到 Registry，并生成不泄漏本地路径的 Evidence。
 * 无论候选来自扫描、AI 总结还是手工输入，owner review 都是公开的必要证据。
 */
export function bindAgentExposureCapability(
  input: BindAgentExposureCapabilityInput,
): AgentExposureCapabilityDto {
  const evidence: CapabilityEvidenceDto[] = [];
  if (containsCandidate(input.deterministicCandidates, input.capability.name)) {
    evidence.push({
      source: 'descriptor_scan',
      status: 'observed',
      provenance: DESCRIPTOR_SCAN_PROVENANCE,
      recordedAt: input.recordedAt,
      validUntil: null,
    });
  }
  if (containsCandidate(input.summarizedCandidates, input.capability.name)) {
    evidence.push({
      source: 'descriptor_summary',
      status: 'observed',
      provenance: DESCRIPTOR_SUMMARY_PROVENANCE,
      recordedAt: input.recordedAt,
      validUntil: null,
    });
  }
  evidence.push({
    source: 'owner_attestation',
    status: 'owner_confirmed',
    provenance: OWNER_ATTESTATION_PROVENANCE,
    recordedAt: input.recordedAt,
    validUntil: null,
  });
  return {
    name: input.capability.name,
    description: input.capability.description,
    registry: capabilityRegistryReferenceForName(input.capability.name),
    evidence,
  };
}

/**
 * 读取历史 Manifest 时补齐 Registry/Evidence，不回写历史 revision。
 * 新 Manifest 已持久化这些字段；旧 Manifest 以 publishedAt 形成兼容 owner evidence。
 */
export function materializeAgentExposureCapability(
  capability: AgentExposureCapabilityDto,
  publishedAt: number,
): Required<AgentExposureCapabilityDto> {
  const registry = capability.registry?.registryVersion === CAPABILITY_REGISTRY_VERSION
    ? capability.registry
    : capabilityRegistryReferenceForName(capability.name);
  const evidence = capability.evidence && capability.evidence.length > 0
    ? capability.evidence
    : [{
        source: 'owner_attestation' as const,
        status: 'owner_confirmed' as const,
        provenance: OWNER_ATTESTATION_PROVENANCE,
        recordedAt: publishedAt,
        validUntil: null,
      }];
  return { ...capability, registry, evidence };
}

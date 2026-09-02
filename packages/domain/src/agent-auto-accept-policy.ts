import type {
  AgentAutoAcceptPolicyDto,
  AgentExposureManifestRevisionDto,
  TaskOfferObjectiveDto,
} from '@agentbean/contracts';

import { capabilityRegistryReferenceForName } from './capability-registry-policy.js';

export type AgentAutoAcceptDenialReason =
  | 'policy_disabled'
  | 'policy_expired'
  | 'manifest_mismatch'
  | 'manifest_not_active'
  | 'offer_manifest_mismatch'
  | 'risk_not_allowed'
  | 'capability_not_allowed'
  | 'capability_restricted'
  | 'unspecified_capability_not_allowed'
  | 'preview_incomplete'
  | 'frozen_inputs_not_allowed'
  | 'capacity_exhausted'
  | 'requirement_confirmation';

export type AgentAutoAcceptDecision =
  | { readonly kind: 'auto_accept' }
  | { readonly kind: 'manual_response_required'; readonly reason: AgentAutoAcceptDenialReason };

export interface EvaluateAgentAutoAcceptInput {
  readonly policy: AgentAutoAcceptPolicyDto;
  readonly manifest: Pick<AgentExposureManifestRevisionDto, 'id' | 'revision' | 'status' | 'validUntil'> &
    Pick<Partial<AgentExposureManifestRevisionDto>, 'capabilities'>;
  readonly offerManifestRevision: number;
  readonly objective: TaskOfferObjectiveDto;
  readonly disabledCapabilityIds: readonly string[];
  readonly frozenInputCount: number;
  readonly requirementConfirmation: boolean;
  readonly activeClaimCount: number;
  readonly now: number;
}

/**
 * 机器接受的纯策略门禁。任何不完整或漂移状态都保留 open Offer，等待 Agent 显式响应；
 * 本函数只给出是否可代表既有 owner 预授权提交 accepted，不创建 Claim。
 */
export function evaluateAgentAutoAccept(
  input: EvaluateAgentAutoAcceptInput,
): AgentAutoAcceptDecision {
  const { policy, manifest, objective } = input;
  if (!policy.enabled) return denied('policy_disabled');
  if (policy.validUntil !== null && policy.validUntil <= input.now) return denied('policy_expired');
  if (manifest.status !== 'active' || (manifest.validUntil !== null && manifest.validUntil <= input.now)) {
    return denied('manifest_not_active');
  }
  if (policy.manifestId !== manifest.id || policy.manifestRevision !== manifest.revision) {
    return denied('manifest_mismatch');
  }
  if (input.offerManifestRevision !== manifest.revision) return denied('offer_manifest_mismatch');
  if (input.requirementConfirmation) return denied('requirement_confirmation');
  if (!policy.allowedRiskLevels.includes(objective.riskLevel)) return denied('risk_not_allowed');
  if (!objective.objective.trim()
    || (policy.requireCompletePreview && objective.deliverables.length === 0)) {
    return denied('preview_incomplete');
  }
  if (input.frozenInputCount > 0 && !policy.allowFrozenProjectInputs) {
    return denied('frozen_inputs_not_allowed');
  }
  if (input.activeClaimCount >= policy.maxActiveClaims) return denied('capacity_exhausted');

  if (objective.requiredCapabilities.length === 0) {
    return policy.allowUnspecifiedCapabilities
      ? { kind: 'auto_accept' }
      : denied('unspecified_capability_not_allowed');
  }
  const allowed = new Set(policy.allowedCapabilityIds);
  const disabled = new Set(input.disabledCapabilityIds);
  if (objective.requiredCapabilities.some((name) => {
    const publishedId = resolvePublishedCapabilityId(manifest, name);
    const legacyId = capabilityRegistryReferenceForName(name).capabilityId;
    return disabled.has(publishedId) || disabled.has(legacyId);
  })) {
    return denied('capability_restricted');
  }
  const allAllowed = objective.requiredCapabilities.every((name) =>
    allowed.has(resolvePublishedCapabilityId(manifest, name)));
  return allAllowed ? { kind: 'auto_accept' } : denied('capability_not_allowed');
}

function resolvePublishedCapabilityId(
  manifest: EvaluateAgentAutoAcceptInput['manifest'],
  requiredName: string,
): string {
  const normalized = requiredName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const published = manifest.capabilities?.find((capability) =>
    capability.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() === normalized);
  return published?.registry?.capabilityId
    ?? capabilityRegistryReferenceForName(requiredName).capabilityId;
}

function denied(reason: AgentAutoAcceptDenialReason): AgentAutoAcceptDecision {
  return { kind: 'manual_response_required', reason };
}

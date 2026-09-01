import { describe, expect, test } from 'vitest';

import type { AgentAutoAcceptPolicyDto, TaskOfferObjectiveDto } from '@agentbean/contracts';
import { capabilityRegistryReferenceForName, evaluateAgentAutoAccept } from '../src/index.js';

const objective: TaskOfferObjectiveDto = {
  objective: '审查变更',
  inputs: [],
  deliverables: ['给出审查结论'],
  constraints: [],
  riskLevel: 'low',
  requiredCapabilities: ['code-review'],
  requiredSkills: [],
  preferredSkills: [],
};

const policy: AgentAutoAcceptPolicyDto = {
  id: 'policy-1',
  teamId: 'team-1',
  agentId: 'agent-1',
  manifestId: 'manifest-1',
  manifestRevision: 2,
  revision: 1,
  enabled: true,
  allowedCapabilityIds: [capabilityRegistryReferenceForName('code-review').capabilityId],
  allowUnspecifiedCapabilities: false,
  allowedRiskLevels: ['low'],
  allowFrozenProjectInputs: false,
  requireCompletePreview: true,
  maxActiveClaims: 2,
  validUntil: null,
  updatedBy: 'owner-1',
  createdAt: 10,
  updatedAt: 10,
};

function decide(overrides: Partial<Parameters<typeof evaluateAgentAutoAccept>[0]> = {}) {
  return evaluateAgentAutoAccept({
    policy,
    manifest: { id: 'manifest-1', revision: 2, status: 'active', validUntil: null },
    offerManifestRevision: 2,
    objective,
    disabledCapabilityIds: [],
    frozenInputCount: 0,
    requirementConfirmation: false,
    activeClaimCount: 0,
    now: 20,
    ...overrides,
  });
}

describe('evaluateAgentAutoAccept (#1270)', () => {
  test('仅在 owner 预授权、Manifest fence、risk、capability、preview 与容量都满足时允许', () => {
    expect(decide()).toEqual({ kind: 'auto_accept' });
  });

  test.each([
    [{ policy: { ...policy, enabled: false } }, 'policy_disabled'],
    [{ policy: { ...policy, validUntil: 20 } }, 'policy_expired'],
    [{ manifest: { id: 'manifest-2', revision: 3, status: 'active' as const, validUntil: null } }, 'manifest_mismatch'],
    [{ offerManifestRevision: 1 }, 'offer_manifest_mismatch'],
    [{ objective: { ...objective, riskLevel: 'high' as const } }, 'risk_not_allowed'],
    [{ disabledCapabilityIds: policy.allowedCapabilityIds }, 'capability_restricted'],
    [{ activeClaimCount: 2 }, 'capacity_exhausted'],
    [{ frozenInputCount: 1 }, 'frozen_inputs_not_allowed'],
    [{ requirementConfirmation: true }, 'requirement_confirmation'],
  ] as const)('不满足策略时保留人工响应：%s', (overrides, reason) => {
    expect(decide(overrides)).toEqual({ kind: 'manual_response_required', reason });
  });

  test('无 required capability 只有显式允许时才可自动接受', () => {
    const noCapability = { ...objective, requiredCapabilities: [] };
    expect(decide({ objective: noCapability })).toMatchObject({ reason: 'unspecified_capability_not_allowed' });
    expect(decide({
      objective: noCapability,
      policy: { ...policy, allowUnspecifiedCapabilities: true },
    })).toEqual({ kind: 'auto_accept' });
  });

  test('完整 preview 策略拒绝没有 deliverable 的 Offer', () => {
    expect(decide({ objective: { ...objective, deliverables: [] } }))
      .toMatchObject({ reason: 'preview_incomplete' });
  });

  test('能力名称与 Registry ID 不同构时，以当前 Manifest 已发布 ID 匹配策略', () => {
    const registryId = 'capability:v1:review-contract';
    expect(decide({
      objective: { ...objective, requiredCapabilities: ['Code Review'] },
      manifest: {
        id: 'manifest-1', revision: 2, status: 'active', validUntil: null,
        capabilities: [{
          name: 'code review', description: 'review',
          registry: { capabilityId: registryId, registryVersion: 1 }, evidence: [],
        }],
      },
      policy: { ...policy, allowedCapabilityIds: [registryId] },
    })).toEqual({ kind: 'auto_accept' });
  });

  test('Manifest 使用自定义 Registry ID 时，历史名称型 restriction 仍能收紧自动认领', () => {
    const registryId = 'capability:v1:review-contract';
    expect(decide({
      objective: { ...objective, requiredCapabilities: ['Code Review'] },
      manifest: {
        id: 'manifest-1', revision: 2, status: 'active', validUntil: null,
        capabilities: [{
          name: 'code review', description: 'review',
          registry: { capabilityId: registryId, registryVersion: 1 }, evidence: [],
        }],
      },
      policy: { ...policy, allowedCapabilityIds: [registryId] },
      disabledCapabilityIds: [capabilityRegistryReferenceForName('Code Review').capabilityId],
    })).toEqual({ kind: 'manual_response_required', reason: 'capability_restricted' });
  });
});

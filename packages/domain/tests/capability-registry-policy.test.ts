import { describe, expect, test } from 'vitest';

import {
  bindAgentExposureCapability,
  capabilityRegistryReferenceForName,
  materializeAgentExposureCapability,
} from '../src/capability-registry-policy.js';

describe('capabilityRegistryReferenceForName (#1270)', () => {
  test('同名能力忽略大小写、空白和 Unicode 宽度差异后得到稳定 ID', () => {
    expect(capabilityRegistryReferenceForName(' Code   Review ')).toEqual(
      capabilityRegistryReferenceForName('code review'),
    );
    expect(capabilityRegistryReferenceForName('Ｃｏｄｅ Review')).toEqual(
      capabilityRegistryReferenceForName('code review'),
    );
  });

  test('不同能力得到不同 ID，并固定 registry version', () => {
    expect(capabilityRegistryReferenceForName('code review')).not.toEqual(
      capabilityRegistryReferenceForName('deploy'),
    );
    expect(capabilityRegistryReferenceForName('code review').registryVersion).toBe(1);
  });
});

describe('bindAgentExposureCapability (#1270)', () => {
  test('机械扫描候选经 owner 选择后同时保留扫描和 owner evidence', () => {
    const capability = bindAgentExposureCapability({
      capability: { name: 'code-review', description: '审查代码' },
      deterministicCandidates: ['Code-Review'],
      summarizedCandidates: [],
      recordedAt: 100,
    });
    expect(capability.registry?.capabilityId).toContain('code-review');
    expect(capability.evidence?.map((item) => [item.source, item.status])).toEqual([
      ['descriptor_scan', 'observed'],
      ['owner_attestation', 'owner_confirmed'],
    ]);
    expect(JSON.stringify(capability)).not.toContain('sourcePath');
  });

  test('手工 capability 只有 owner evidence，不伪造扫描或 runtime verification', () => {
    const capability = bindAgentExposureCapability({
      capability: { name: 'planning', description: '计划' },
      deterministicCandidates: [],
      summarizedCandidates: [],
      recordedAt: 100,
    });
    expect(capability.evidence).toEqual([
      expect.objectContaining({ source: 'owner_attestation', status: 'owner_confirmed' }),
    ]);
  });

  test('旧 Manifest 读取时只补兼容 owner evidence，不改写名称和描述', () => {
    expect(materializeAgentExposureCapability(
      { name: 'legacy-capability', description: 'legacy' },
      88,
    )).toMatchObject({
      name: 'legacy-capability',
      description: 'legacy',
      registry: { registryVersion: 1 },
      evidence: [{ source: 'owner_attestation', recordedAt: 88 }],
    });
  });
});

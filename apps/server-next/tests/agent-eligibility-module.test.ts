import { describe, expect, test } from 'vitest';
import { createAgentEligibilityModule } from '../src/application/agent-eligibility-module.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('AgentEligibilityModule', () => {
  test('普通 Task 候选优先使用受 Team restriction 约束的 Exposure', async () => {
    const repositories = createInMemoryRepositories();
    const agent = await seedAgent(repositories, {
      id: 'agent-1',
      deviceId: 'device-1',
      legacyCapabilities: ['legacy-only'],
    });
    await seedManifest(repositories, {
      id: 'manifest-1',
      agentId: agent.id,
      capabilities: ['code-review', 'write'],
    });
    await repositories.agentExposure.restrictions.upsert({
      id: 'restriction-1',
      teamId: 'team-1',
      agentId: agent.id,
      manifestId: 'manifest-1',
      disabledCapabilities: ['CODE-REVIEW'],
      disabledSkills: [],
      updatedBy: 'user-1',
      now: 5,
    });

    const eligibility = createAgentEligibilityModule({
      repositories,
      clock: { now: () => 10 },
    });

    await expect(eligibility.resolveTaskCandidateCapabilities({
      teamId: 'team-1',
      agent,
    })).resolves.toEqual(new Set(['write']));
  });

  test('过期 Exposure 原子标记 expired 后保持 legacy capability 兼容', async () => {
    const repositories = createInMemoryRepositories();
    const agent = await seedAgent(repositories, {
      id: 'agent-1',
      deviceId: 'device-1',
      legacyCapabilities: ['legacy-only'],
    });
    await seedManifest(repositories, {
      id: 'manifest-1',
      agentId: agent.id,
      capabilities: ['code-review'],
      validUntil: 10,
    });
    const eligibility = createAgentEligibilityModule({
      repositories,
      clock: { now: () => 10 },
    });

    await expect(eligibility.resolveTaskCandidateCapabilities({
      teamId: 'team-1',
      agent,
    })).resolves.toEqual(new Set(['legacy-only']));
    await expect(repositories.agentExposure.manifests.getById('manifest-1'))
      .resolves.toMatchObject({ status: 'expired' });
  });

  test('严格项目阶段资格只接受有效 Exposure，并同时校验 Agent 与 Device InputSet', async () => {
    const repositories = createInMemoryRepositories();
    await seedDevice(repositories, 'device-eligible', [1]);
    await seedDevice(repositories, 'device-missing-contract', []);
    await seedAgent(repositories, {
      id: 'eligible',
      deviceId: 'device-eligible',
      inputSetVersions: [1],
    });
    await seedAgent(repositories, {
      id: 'missing-contract',
      deviceId: 'device-missing-contract',
      inputSetVersions: [1],
    });
    await seedAgent(repositories, {
      id: 'legacy-only',
      deviceId: 'device-eligible',
      legacyCapabilities: ['code-review'],
      inputSetVersions: [1],
    });
    await seedManifest(repositories, {
      id: 'manifest-eligible',
      agentId: 'eligible',
      capabilities: ['code-review'],
    });
    await seedManifest(repositories, {
      id: 'manifest-missing-contract',
      agentId: 'missing-contract',
      capabilities: ['code-review'],
    });
    const eligibility = createAgentEligibilityModule({
      repositories,
      clock: { now: () => 10 },
    });

    await expect(eligibility.filterStrictProjectStageAgentIds({
      teamId: 'team-1',
      candidateAgentIds: ['legacy-only', 'missing-contract', 'eligible'],
      requiredCapabilities: ['CODE-REVIEW'],
      requiredProjectDocumentInputSetVersion: 1,
      now: 10,
    })).resolves.toEqual(['eligible']);
  });
});

async function seedAgent(
  repositories: ServerNextRepositories,
  input: {
    id: string;
    deviceId: string;
    legacyCapabilities?: readonly string[];
    inputSetVersions?: readonly number[];
  },
) {
  return repositories.agents.upsert({
    id: input.id,
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    name: input.id,
    adapterKind: 'codex',
    category: 'executor-hosted',
    source: 'custom',
    status: 'online',
    deviceId: input.deviceId,
    ...(input.legacyCapabilities
      ? {
          skills: input.legacyCapabilities.map((name) => ({
            name,
            description: name,
            scope: 'user' as const,
            sourcePath: `/${name}`,
            adapterKind: 'codex' as const,
          })),
        }
      : {}),
    ...(input.inputSetVersions
      ? { projectDocumentInputSetVersions: [...input.inputSetVersions] }
      : {}),
  });
}

async function seedDevice(
  repositories: ServerNextRepositories,
  id: string,
  inputSetVersions: readonly number[],
) {
  return repositories.devices.upsertHello({
    id,
    teamId: 'team-1',
    ownerId: 'user-1',
    status: 'online',
    capabilities: { projectDocumentInputSetVersions: [...inputSetVersions] },
    createdAt: 1,
    updatedAt: 1,
  });
}

async function seedManifest(
  repositories: ServerNextRepositories,
  input: {
    id: string;
    agentId: string;
    capabilities: readonly string[];
    validUntil?: number;
  },
) {
  return repositories.agentExposure.manifests.create({
    id: input.id,
    teamId: 'team-1',
    agentId: input.agentId,
    revision: 1,
    status: 'active',
    capabilities: input.capabilities.map((name) => ({ name, description: name })),
    skills: [],
    constraints: [],
    availability: { status: 'available' },
    validFrom: 0,
    validUntil: input.validUntil ?? null,
    createdBy: 'user-1',
    now: 0,
  });
}

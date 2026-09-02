import type { AgentExposureActiveProjectionDto } from '../../../../packages/contracts/src/index.js';
import {
  evaluateAgentEligibility,
  evaluateExecutableSubtaskCoverage,
  type AgentEligibilityState,
} from '../../../../packages/domain/src/index.js';
import type { AgentRecord, ServerNextRepositories } from './repositories.js';

export interface StrictProjectStageEligibilityInput {
  readonly teamId: string;
  readonly candidateAgentIds: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly requiredProjectDocumentInputSetVersion?: number;
  readonly now: number;
}

/**
 * Agent 资格判定的事实边界。
 *
 * 调用方仍负责通道成员、设备在线、依赖和 targeted policy 等业务诊断；本模块只统一
 * Exposure / Restriction / legacy capability 与 InputSet 合同的读取和解释。
 */
export interface AgentEligibilityModule {
  /** 普通 Task 路由兼容路径：有效 Exposure 优先，无可用 active manifest 时回退 legacy skill 名。 */
  resolveTaskCandidateCapabilities(input: {
    readonly teamId: string;
    readonly agent: AgentRecord;
  }): Promise<ReadonlySet<string>>;

  /** 项目阶段自动推进的严格路径：只接受当前有效、available 的 Team Exposure。 */
  filterStrictProjectStageAgentIds(input: StrictProjectStageEligibilityInput): Promise<string[]>;
}

export interface ResolveDecompositionAllocatabilityInput {
  readonly parentTaskId: string;
  readonly subtaskSkillReqs: readonly {
    readonly clientKey: string;
    readonly requiredCapabilities: readonly string[];
    readonly requiredSkills?: readonly string[];
  }[];
  readonly teamId: string;
  readonly broker: {
    resolveCandidates(taskId: string): Promise<{
      readonly candidates: readonly {
        readonly agentId: string;
        readonly eligible: boolean;
      }[];
    }>;
  };
  readonly resolveManifest: (teamId: string, agentId: string, now: number) =>
    Promise<AgentExposureActiveProjectionDto | null>;
  readonly clock: { now(): number };
}

export function createAgentEligibilityModule(input: {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
}): AgentEligibilityModule {
  return {
    async resolveTaskCandidateCapabilities({ teamId, agent }) {
      const exposure = input.repositories.agentExposure;
      const now = input.clock.now();
      const active = await exposure.manifests.getActiveByTeamAgent(teamId, agent.id);
      if (active) {
        if (active.validUntil !== null && active.validUntil <= now) {
          await exposure.manifests.setStatus({ id: active.id, status: 'expired', now });
        } else {
          const restriction = await exposure.restrictions.getByTeamAgent(teamId, agent.id);
          const disabled = restriction?.manifestId === active.id
            ? restriction.disabledCapabilities
            : [];
          const disabledSet = new Set(disabled.map(normalizeCapability));
          return new Set(active.capabilities
            .map((capability) => normalizeCapability(capability.name))
            .filter((name) => !disabledSet.has(name)));
        }
      }
      return new Set((agent.skills ?? []).map((skill) => normalizeCapability(skill.name)));
    },

    async filterStrictProjectStageAgentIds(eligibilityInput) {
      const eligible: string[] = [];
      for (const agentId of eligibilityInput.candidateAgentIds) {
        const manifest = await input.repositories.agentExposure.manifests
          .getActiveByTeamAgent(eligibilityInput.teamId, agentId);
        if (!manifest
          || manifest.validFrom > eligibilityInput.now
          || (manifest.validUntil !== null && manifest.validUntil <= eligibilityInput.now)
          || manifest.availability.status !== 'available') continue;

        const restriction = await input.repositories.agentExposure.restrictions
          .getByTeamAgent(eligibilityInput.teamId, agentId);
        const disabled = new Set(
          restriction?.manifestId === manifest.id
            ? restriction.disabledCapabilities.map(normalizeCapability)
            : [],
        );
        const capabilities = new Set(manifest.capabilities
          .map((capability) => normalizeCapability(capability.name))
          .filter((name) => !disabled.has(name)));
        if (eligibilityInput.requiredCapabilities
          .some((required) => !capabilities.has(normalizeCapability(required)))) continue;

        if (eligibilityInput.requiredProjectDocumentInputSetVersion !== undefined) {
          const agent = await input.repositories.agents.getById(agentId);
          const device = agent?.deviceId
            ? await input.repositories.devices.getById(agent.deviceId)
            : null;
          if (!agent?.projectDocumentInputSetVersions
            ?.includes(eligibilityInput.requiredProjectDocumentInputSetVersion)
            || !device?.capabilities?.projectDocumentInputSetVersions
              ?.includes(eligibilityInput.requiredProjectDocumentInputSetVersion)) {
            continue;
          }
        }
        eligible.push(agentId);
      }
      return eligible.sort();
    },
  };
}

/**
 * 将 broker 硬门槛、Exposure tri-state 与 decomposition coverage 组合成一次只读决策。
 * 同一 parent Task 的候选事实只读取一次，再分别对各 subtask requirement 求值。
 */
export async function resolveDecompositionAllocatability(
  input: ResolveDecompositionAllocatabilityInput,
): Promise<ReturnType<typeof evaluateExecutableSubtaskCoverage>> {
  const now = input.clock.now();
  const candidates = (await input.broker.resolveCandidates(input.parentTaskId)).candidates;
  const eligibleCandidates = candidates.filter((item) => item.eligible);
  const manifests = new Map<string, AgentExposureActiveProjectionDto | null>();
  for (const candidate of eligibleCandidates) {
    manifests.set(
      candidate.agentId,
      await input.resolveManifest(input.teamId, candidate.agentId, now),
    );
  }
  const executableSubtasks: {
    subtaskKey: string;
    candidateEligibility: { readonly state: AgentEligibilityState }[];
  }[] = [];

  for (const requirement of input.subtaskSkillReqs) {
    const states: { state: AgentEligibilityState }[] = [];
    for (const candidate of eligibleCandidates) {
      const projection = manifests.get(candidate.agentId) ?? null;
      const manifest = projection
        ? {
            status: 'current' as const,
            capabilities: projection.capabilities.map((capability) => capability.name),
            skills: projection.skills.map((skill) => skill.name),
          }
        : { status: 'unknown' as const, cause: 'unreachable' as const };
      const result = evaluateAgentEligibility({
        manifest,
        available: projection?.availability?.status === 'available',
        requiredCapabilities: requirement.requiredCapabilities,
        requiredSkills: requirement.requiredSkills ?? [],
      });
      states.push({ state: result.state });
    }
    executableSubtasks.push({
      subtaskKey: requirement.clientKey,
      candidateEligibility: states,
    });
  }
  return evaluateExecutableSubtaskCoverage({ executableSubtasks });
}

function normalizeCapability(capability: string): string {
  return capability.toLowerCase();
}

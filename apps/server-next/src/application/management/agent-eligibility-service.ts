/**
 * #805 eligibility 服务：把 broker candidate → agent exposure manifest → domain eligibility
 * 串联为 createSubtasks gate 的 allocatability 输入,替换 #798 的 fully_allocatable stub。
 *
 * 关键映射:
 * - agent-exposure-service.resolveActive → AgentExposureActiveProjectionDto | null
 *   → (capabilities.map(c=>c.name), skills.map(s=>s.name), availability.status)
 *   → AgentEligibilityManifest{status:'current'|'unknown', capabilities[], skills[]}
 * - null → AgentEligibilityManifest{status:'unknown', cause:'unreachable'}
 * - evaluateAgentEligibility → {state:qualified|not_qualified|unknown}
 * - evaluateExecutableSubtaskCoverage → fully_allocatable | unallocatable_subtasks_present
 *
 * 调在 executor handler（事务外 IO）,结果传入 kernel gate。
 */

import type { AgentEligibilityState } from '../../../../../packages/domain/src/index.js';
import { evaluateAgentEligibility, evaluateExecutableSubtaskCoverage } from '../../../../../packages/domain/src/index.js';
import type { AgentExposureActiveProjectionDto } from '../../../../../packages/contracts/src/index.js';
import type { TaskClaimBroker } from './task-claim-broker.js';

export interface ResolveDecompositionAllocatabilityInput {
  readonly parentTaskId: string;
  readonly subtaskSkillReqs: readonly {
    readonly clientKey: string;
    readonly requiredCapabilities: readonly string[];
    readonly requiredSkills?: readonly string[];
  }[];
  readonly teamId: string;
  readonly broker: Pick<TaskClaimBroker, 'resolveCandidates'>;
  readonly resolveManifest: (teamId: string, agentId: string, now: number) =>
    Promise<AgentExposureActiveProjectionDto | null>;
  readonly clock: { now(): number };
}

export async function resolveDecompositionAllocatability(
  input: ResolveDecompositionAllocatabilityInput,
): Promise<ReturnType<typeof evaluateExecutableSubtaskCoverage>> {
  const now = input.clock.now();
  const candidateLists = await Promise.all(
    input.subtaskSkillReqs.map(() =>
      input.broker.resolveCandidates(input.parentTaskId).then((res) => res.candidates),
    ),
  );
  const executableSubtasks: {
    subtaskKey: string;
    candidateEligibility: { readonly state: AgentEligibilityState }[];
  }[] = [];
  for (let i = 0; i < input.subtaskSkillReqs.length; i++) {
    const skillReq = input.subtaskSkillReqs[i];
    if (!skillReq) continue;
    const candidates = candidateLists[i] ?? [];
    // parent Task 的硬门槛允许由多个子 Task 联合覆盖。broker 在 parent 上给出的
    // CAPABILITY_MISSING 不能预先淘汰候选；这里只保留没有连接/可见性/频道等基础阻塞的 Agent，
    // 再用每个子 Task 自己的 required Capability/Skill 重新判定。
    const eligible = candidates.filter((candidate) =>
      candidate.eligible ||
      (candidate.diagnosticCodes.length > 0 &&
        candidate.diagnosticCodes.every((code) => code === 'CAPABILITY_MISSING')));
    const states: { state: AgentEligibilityState }[] = [];
    for (const candidate of eligible) {
      const projection = await input.resolveManifest(input.teamId, candidate.agentId, now);
      const manifest = projection ? {
        status: 'current' as const,
        capabilities: projection.capabilities.map((c: { name: string }) => c.name),
        skills: projection.skills.map((s: { name: string }) => s.name),
      } : { status: 'unknown' as const, cause: 'unreachable' as const };
      const result = evaluateAgentEligibility({
        manifest,
        available: projection?.availability?.status === 'available',
        requiredCapabilities: skillReq.requiredCapabilities,
        requiredSkills: skillReq.requiredSkills ?? [],
      });
      states.push({ state: result.state });
    }
    executableSubtasks.push({
      subtaskKey: skillReq.clientKey,
      candidateEligibility: states,
    });
  }
  return evaluateExecutableSubtaskCoverage({ executableSubtasks });
}

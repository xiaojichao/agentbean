import { describe, expect, test } from 'vitest';

import type { AcceptanceCriterionDto, EvidenceRefDto } from '@agentbean/contracts';

import {
  decideOfferAllocationPolicy,
  evaluateAgentEligibility,
  evaluateExecutableSubtaskCoverage,
  evaluateOfferAcceptance,
  evaluateSkillCoverageUnion,
  evaluateSubtaskAcceptance,
  evaluateTaskDag,
  evaluateTaskDecomposability,
} from '../src/index.js';
import type { TaskClaimAcquireInput } from '../src/task-claim-policy.js';

// ---- 共享 fixture：根 Task [research, codegen] 拆成两个可执行子 Task，两个专业 Agent 分别覆盖 ----

const NOW = 1_000_000;
const TTL = 60_000;

const ROOT_SKILLS = ['research', 'codegen'];
const SUB_SKILLS: readonly (readonly string[])[] = [['research'], ['codegen']];

const AGENT_1_MANIFEST = { status: 'current', capabilities: [], skills: ['research'] } as const;
const AGENT_2_MANIFEST = { status: 'current', capabilities: [], skills: ['codegen'] } as const;

/** 构造一个合法的初始 acquire 输入（无 current lease）。 */
function initialAcquire(taskId: string, agentId: string): TaskClaimAcquireInput {
  return {
    taskId,
    taskRevision: 1,
    taskAttempt: 1,
    agentId,
    leaseTokenHash: `lease-${agentId}`,
    leaseFingerprint: `fp-${agentId}`,
    ancestorAgentIds: [],
    now: NOW,
    ttlMs: TTL,
  };
}

describe('AC#7 端到端：两个专业 Agent 联合覆盖根 Task [research, codegen]', () => {
  test('① AC#3 根 + 双子 Task DAG 有界无环 → valid', () => {
    const result = evaluateTaskDag({
      rootTaskId: 'root',
      nodes: [
        { taskId: 'root', dependencyTaskIds: [], isTerminal: false },
        { taskId: 'sub-research', parentTaskId: 'root', dependencyTaskIds: [], isTerminal: true },
        { taskId: 'sub-codegen', parentTaskId: 'root', dependencyTaskIds: [], isTerminal: true },
      ],
      limits: { maxDepth: 5, maxFanOut: 8, maxOpenTasks: 10 },
      invocationBudget: { consumed: 0, reserved: 0, limit: 100 },
    });
    expect(result).toEqual({ kind: 'valid' });
  });

  test('② AC#1 子 Task skills 联合覆盖根 coverage → uncovered 为空', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: ROOT_SKILLS,
      subtaskRequiredSkills: SUB_SKILLS,
    });
    expect(result.covered).toEqual(['research', 'codegen']);
    expect(result.uncovered).toEqual([]);
  });

  test('③ AC#2 每个可执行子 Task 由一个 Agent 完整满足 → fully_allocatable', () => {
    const agent1ForResearch = evaluateAgentEligibility({
      manifest: AGENT_1_MANIFEST,
      available: true,
      requiredCapabilities: [],
      requiredSkills: ['research'],
    });
    const agent2ForCodegen = evaluateAgentEligibility({
      manifest: AGENT_2_MANIFEST,
      available: true,
      requiredCapabilities: [],
      requiredSkills: ['codegen'],
    });
    expect(agent1ForResearch.state).toBe('qualified');
    expect(agent2ForCodegen.state).toBe('qualified');

    const alloc = evaluateExecutableSubtaskCoverage({
      executableSubtasks: [
        { subtaskKey: 'sub-research', candidateEligibility: [agent1ForResearch] },
        { subtaskKey: 'sub-codegen', candidateEligibility: [agent2ForCodegen] },
      ],
    });
    expect(alloc).toEqual({ kind: 'fully_allocatable' });
  });

  test('④ AC#4 覆盖 + 可分配均通过 → decomposable（允许拆分）', () => {
    const coverage = evaluateSkillCoverageUnion({
      rootRequiredSkills: ROOT_SKILLS,
      subtaskRequiredSkills: SUB_SKILLS,
    });
    const result = evaluateTaskDecomposability({
      atomicityHint: 'decomposable',
      coverage,
      allocatability: { kind: 'fully_allocatable' },
    });
    expect(result).toEqual({ kind: 'decomposable' });
  });

  test('⑤ AC#5 每个子 Task 单一明确候选 → 定向 Offer', () => {
    const research = decideOfferAllocationPolicy({
      rankedQualifiedAgentIds: ['agent-1'],
      topCandidatesTied: false,
      loadUncertain: false,
    });
    const codegen = decideOfferAllocationPolicy({
      rankedQualifiedAgentIds: ['agent-2'],
      topCandidatesTied: false,
      loadUncertain: false,
    });
    expect(research).toEqual({ kind: 'targeted', targetAgentId: 'agent-1' });
    expect(codegen).toEqual({ kind: 'targeted', targetAgentId: 'agent-2' });
  });

  test('⑥ AC#6 各子 Task Offer 被对应 Agent 接受 → 各自 claim_granted（独立 Offer）', () => {
    const validity = { acceptable: true } as const;
    const researchClaim = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity,
      acquire: initialAcquire('sub-research', 'agent-1'),
    });
    const codegenClaim = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity,
      acquire: initialAcquire('sub-codegen', 'agent-2'),
    });
    expect(researchClaim.kind).toBe('claim_granted');
    expect(codegenClaim.kind).toBe('claim_granted');
  });

  test('⑦ AC#6 并发接受同一开放 Offer → 单 claim_granted，败者 overtaken（无重复 Dispatch）', () => {
    const validity = { acceptable: true } as const;
    // 胜者先 accept（无 current lease）
    const winner = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity,
      acquire: initialAcquire('sub-research', 'agent-1'),
    });
    expect(winner.kind).toBe('claim_granted');
    if (winner.kind !== 'claim_granted') throw new Error('expected claim_granted');
    // 败者后 accept，current lease 指向 agent-1 → active-claim-held → overtaken（不产 Lease → 无 Dispatch）
    const loser = evaluateOfferAcceptance({
      eligibility: { state: 'qualified' },
      validity,
      acquire: { ...initialAcquire('sub-research', 'agent-2'), current: winner.lease },
    });
    expect(loser).toEqual({ kind: 'overtaken', reason: 'active_claim_held' });
  });

  test('⑧ AC#7 子 Task 交付归属（claim/invocation 证据）后验收 → accepted', () => {
    const criterion: AcceptanceCriterionDto = {
      id: 'criterion-1',
      description: 'Research deliverable attached',
      evidenceRequired: true,
      allowedEvidenceKinds: ['task'],
    };
    const evidenceRef: EvidenceRefDto = {
      kind: 'task',
      id: 'delivery-research',
      snapshotHash: 'sha256:abc',
      capturedAt: NOW,
    };
    const result = evaluateSubtaskAcceptance({
      criteria: [criterion],
      criteriaResults: [{ criterionId: 'criterion-1', passed: true, evidenceRefs: [evidenceRef] }],
      evidenceSnapshots: [
        { ref: evidenceRef, available: true, visible: true, currentSnapshotHash: 'sha256:abc' },
      ],
      highRisk: false,
      conflictingEvidence: false,
    });
    expect(result).toEqual({ kind: 'accepted' });
  });

  test('⑨ 负面：子 Task 候选全 unknown → unallocatable(all_unknown) + needs_user_adjustment', () => {
    // Agent-2 manifest 不可得 → unknown（fail-closed：未知不等于具备）
    const agent2Unknown = evaluateAgentEligibility({
      manifest: { status: 'unknown', cause: 'unreachable' },
      available: true,
      requiredCapabilities: [],
      requiredSkills: ['codegen'],
    });
    expect(agent2Unknown.state).toBe('unknown');

    const alloc = evaluateExecutableSubtaskCoverage({
      executableSubtasks: [
        { subtaskKey: 'sub-research', candidateEligibility: [{ state: 'qualified' }] },
        { subtaskKey: 'sub-codegen', candidateEligibility: [agent2Unknown] },
      ],
    });
    expect(alloc).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [{ subtaskKey: 'sub-codegen', cause: 'all_unknown' }],
    });

    const coverage = evaluateSkillCoverageUnion({
      rootRequiredSkills: ROOT_SKILLS,
      subtaskRequiredSkills: SUB_SKILLS,
    });
    const decomposability = evaluateTaskDecomposability({
      atomicityHint: 'decomposable',
      coverage,
      allocatability: alloc,
    });
    expect(decomposability.kind).toBe('needs_user_adjustment');
  });
});

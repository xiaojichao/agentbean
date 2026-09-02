import { describe, expect, test } from 'vitest';
import { resolveDecompositionAllocatability } from '../src/application/agent-eligibility-module.js';

describe('AgentEligibilityModule decomposition allocatability', () => {
  const clock = { now: () => 100 };

  function currentManifest(skills: string[] = ['research']) {
    return {
      revision: 1,
      agentId: 'agent-1',
      capabilities: [],
      skills: skills.map((s) => ({ name: s, description: s })),
      constraints: [],
      availability: { status: 'available' as const },
      validUntil: null,
    };
  }

  test('eligible candidate with matching manifest → qualified → fully_allocatable', async () => {
    const result = await resolveDecompositionAllocatability({
      parentTaskId: 'root',
      subtaskSkillReqs: [{ clientKey: 'a', requiredCapabilities: [], requiredSkills: ['research'] }],
      teamId: 'team-1',
      broker: {
        resolveCandidates: async () => ({
          taskId: 'root', taskRevision: 1, taskAttempt: 1,
          candidates: [{ agentId: 'agent-1', eligible: true, missingCapabilities: [], diagnosticCodes: [] }],
          ancestorAgentIds: [],
        }),
      },
      resolveManifest: async () => currentManifest(['research']),
      clock,
    });
    expect(result).toEqual({ kind: 'fully_allocatable' });
  });

  test('eligible candidate misses required skill → not_qualified → no_qualified_candidate', async () => {
    const result = await resolveDecompositionAllocatability({
      parentTaskId: 'root',
      subtaskSkillReqs: [{ clientKey: 'a', requiredCapabilities: [], requiredSkills: ['codegen'] }],
      teamId: 'team-1',
      broker: {
        resolveCandidates: async () => ({
          taskId: 'root', taskRevision: 1, taskAttempt: 1,
          candidates: [{ agentId: 'agent-1', eligible: true, missingCapabilities: [], diagnosticCodes: [] }],
          ancestorAgentIds: [],
        }),
      },
      resolveManifest: async () => currentManifest(['research']),
      clock,
    });
    expect(result).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [{ subtaskKey: 'a', cause: 'no_qualified_candidate' }],
    });
  });

  test('manifest not found → unknown → all_unknown(fail-closed)', async () => {
    const result = await resolveDecompositionAllocatability({
      parentTaskId: 'root',
      subtaskSkillReqs: [{ clientKey: 'a', requiredCapabilities: [], requiredSkills: ['research'] }],
      teamId: 'team-1',
      broker: {
        resolveCandidates: async () => ({
          taskId: 'root', taskRevision: 1, taskAttempt: 1,
          candidates: [{ agentId: 'agent-1', eligible: true, missingCapabilities: [], diagnosticCodes: [] }],
          ancestorAgentIds: [],
        }),
      },
      resolveManifest: async () => null,
      clock,
    });
    expect(result).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [{ subtaskKey: 'a', cause: 'all_unknown' }],
    });
  });

  test('no eligible candidates → no_candidate', async () => {
    const result = await resolveDecompositionAllocatability({
      parentTaskId: 'root',
      subtaskSkillReqs: [{ clientKey: 'a', requiredCapabilities: [], requiredSkills: ['research'] }],
      teamId: 'team-1',
      broker: {
        resolveCandidates: async () => ({
          taskId: 'root', taskRevision: 1, taskAttempt: 1,
          candidates: [{ agentId: 'agent-1', eligible: false, missingCapabilities: [], diagnosticCodes: [] }],
          ancestorAgentIds: [],
        }),
      },
      resolveManifest: async () => currentManifest(['research']),
      clock,
    });
    expect(result).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [{ subtaskKey: 'a', cause: 'no_candidate' }],
    });
  });

  test('multi subtask:two qualified agents covering two subtasks → fully_allocatable', async () => {
    let candidateReads = 0;
    let manifestReads = 0;
    const result = await resolveDecompositionAllocatability({
      parentTaskId: 'root',
      subtaskSkillReqs: [
        { clientKey: 'a', requiredCapabilities: [], requiredSkills: ['research'] },
        { clientKey: 'b', requiredCapabilities: [], requiredSkills: ['codegen'] },
      ],
      teamId: 'team-1',
      broker: {
        resolveCandidates: async () => {
          candidateReads += 1;
          return {
            taskId: 'root', taskRevision: 1, taskAttempt: 1,
            candidates: [
              { agentId: 'agent-1', eligible: true, missingCapabilities: [], diagnosticCodes: [] },
              { agentId: 'agent-2', eligible: true, missingCapabilities: [], diagnosticCodes: [] },
            ],
            ancestorAgentIds: [],
          };
        },
      },
      resolveManifest: async (_teamId: string, agentId: string) => {
        manifestReads += 1;
        if (agentId === 'agent-1') return currentManifest(['research']);
        return currentManifest(['codegen']);
      },
      clock,
    });
    expect(result).toEqual({ kind: 'fully_allocatable' });
    expect(candidateReads).toBe(1);
    expect(manifestReads).toBe(2);
  });
});

import { describe, expect, test } from 'vitest';

import { ELIGIBILITY_REASON_CODE } from '@agentbean/contracts';

import {
  evaluateAgentEligibility,
  evaluateCapabilityMatch,
  evaluateSkillCoverage,
  rankByPreferredSkills,
  rankQualifiedCandidates,
  resolveHardSpecifiedTarget,
  validateProposedSkillIds,
} from '../src/agent-eligibility.js';

describe('evaluateCapabilityMatch', () => {
  test('no missing when exposed covers all required', () => {
    expect(
      evaluateCapabilityMatch({
        exposedCapabilities: ['code-review', 'lint'],
        requiredCapabilities: ['lint'],
      }).missing,
    ).toEqual([]);
  });

  test('reports missing required capabilities (替换 skill-as-capability 硬过滤)', () => {
    expect(
      evaluateCapabilityMatch({
        exposedCapabilities: ['code-review'],
        requiredCapabilities: ['code-review', 'deploy'],
      }).missing,
    ).toEqual(['deploy']);
  });

  test('case-insensitive capability name matching', () => {
    expect(
      evaluateCapabilityMatch({
        exposedCapabilities: ['Code-Review'],
        requiredCapabilities: ['code-review'],
      }).missing,
    ).toEqual([]);
  });

  test('required deduplicated', () => {
    expect(
      evaluateCapabilityMatch({
        exposedCapabilities: [],
        requiredCapabilities: ['deploy', 'deploy'],
      }).missing,
    ).toEqual(['deploy']);
  });
});

describe('evaluateSkillCoverage', () => {
  test('covered = required ∩ exposed; missing = required − exposed', () => {
    const result = evaluateSkillCoverage({
      exposedSkills: ['typescript', 'python'],
      requiredSkills: ['typescript', 'rust'],
    });
    expect(result.covered).toEqual(['typescript']);
    expect(result.missing).toEqual(['rust']);
  });

  test('no required → no gaps', () => {
    const result = evaluateSkillCoverage({ exposedSkills: ['typescript'] });
    expect(result.covered).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

describe('rankByPreferredSkills', () => {
  const preferred = ['typescript', 'python'];

  test('ranks candidates with more preferred matches first', () => {
    const ranked = rankByPreferredSkills(
      [
        { agentId: 'a', exposedSkills: [] },
        { agentId: 'b', exposedSkills: ['typescript', 'python'] },
        { agentId: 'c', exposedSkills: ['typescript'] },
      ],
      preferred,
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['b', 'c', 'a']);
  });

  test('stable for equal match counts (keeps original order)', () => {
    const ranked = rankByPreferredSkills(
      [
        { agentId: 'a', exposedSkills: ['typescript'] },
        { agentId: 'b', exposedSkills: ['python'] },
      ],
      preferred,
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['a', 'b']);
  });

  test('empty preferred leaves order unchanged', () => {
    const ranked = rankByPreferredSkills(
      [
        { agentId: 'a', exposedSkills: ['x'] },
        { agentId: 'b', exposedSkills: ['y'] },
      ],
      [],
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['a', 'b']);
  });
});

// ── #711 候选判断：可解释资格、unknown 态、skill-id 校验、硬指定、合格排序 ──

describe('evaluateAgentEligibility', () => {
  test('qualified when current manifest covers all hard requirements', () => {
    const result = evaluateAgentEligibility({
      manifest: {
        status: 'current',
        capabilities: ['code-review', 'lint'],
        skills: ['typescript', 'python'],
      },
      available: true,
      requiredCapabilities: ['lint'],
      requiredSkills: ['typescript'],
      preferredSkills: ['python', 'rust'],
    });
    expect(result.state).toBe('qualified');
    expect(result.capabilities).toEqual([{ name: 'lint', status: 'covered' }]);
    expect(result.requiredSkills).toEqual([{ name: 'typescript', status: 'covered' }]);
    expect(result.preferredSkills).toEqual([
      { name: 'python', matched: true },
      { name: 'rust', matched: false },
    ]);
    expect(result.missingHardRequirements).toEqual([]);
  });

  test('not_qualified when a required capability is publicly absent (missing)', () => {
    const result = evaluateAgentEligibility({
      manifest: { status: 'current', capabilities: ['code-review'], skills: [] },
      available: true,
      requiredCapabilities: ['code-review', 'deploy'],
      requiredSkills: [],
    });
    expect(result.state).toBe('not_qualified');
    expect(result.capabilities).toContainEqual({ name: 'deploy', status: 'missing' });
    expect(result.missingHardRequirements).toEqual(['deploy']);
  });

  test('not_qualified when a required skill is publicly absent (missing)', () => {
    const result = evaluateAgentEligibility({
      manifest: { status: 'current', capabilities: ['coding'], skills: ['typescript'] },
      available: true,
      requiredCapabilities: [],
      requiredSkills: ['typescript', 'rust'],
    });
    expect(result.state).toBe('not_qualified');
    expect(result.requiredSkills).toContainEqual({ name: 'rust', status: 'missing' });
    expect(result.missingHardRequirements).toEqual(['rust']);
  });

  test('unknown (undeclared) marks every requirement undeclared, never missing (AC#4)', () => {
    const result = evaluateAgentEligibility({
      manifest: { status: 'unknown', cause: 'undeclared' },
      available: true,
      requiredCapabilities: ['deploy'],
      requiredSkills: ['rust', 'go'],
    });
    expect(result.state).toBe('unknown');
    // AC#4 核心：不能推断 Agent 内部缺失或存在 —— 全部 undeclared，绝不 missing
    expect(result.requiredSkills.every((s) => s.status === 'undeclared')).toBe(true);
    expect(result.capabilities.every((c) => c.status === 'undeclared')).toBe(true);
    expect(result.missingHardRequirements).toEqual([]);
    expect(result.reasonCode).toBe(ELIGIBILITY_REASON_CODE.UNDECLARED);
  });

  test('unknown (expired) surfaces expired cause and does not infer missing (AC#4)', () => {
    const result = evaluateAgentEligibility({
      manifest: { status: 'unknown', cause: 'expired' },
      available: true,
      requiredCapabilities: [],
      requiredSkills: ['rust'],
    });
    expect(result.state).toBe('unknown');
    expect(result.requiredSkills).toEqual([{ name: 'rust', status: 'undeclared' }]);
    expect(result.missingHardRequirements).toEqual([]);
    expect(result.reasonCode).toBe(ELIGIBILITY_REASON_CODE.MANIFEST_EXPIRED);
  });

  test('preferred skills never affect hard qualification', () => {
    const result = evaluateAgentEligibility({
      manifest: { status: 'current', capabilities: ['coding'], skills: ['typescript'] },
      available: true,
      requiredCapabilities: [],
      requiredSkills: [],
      preferredSkills: ['typescript', 'rust'],
    });
    expect(result.state).toBe('qualified');
    expect(result.preferredSkills).toEqual([
      { name: 'typescript', matched: true },
      { name: 'rust', matched: false },
    ]);
  });

  test('case-insensitive capability and skill matching', () => {
    const result = evaluateAgentEligibility({
      manifest: { status: 'current', capabilities: ['Code-Review'], skills: ['TypeScript'] },
      available: true,
      requiredCapabilities: ['code-review'],
      requiredSkills: ['typescript'],
    });
    expect(result.state).toBe('qualified');
  });

  test('duplicates in requirements collapse to a single reason', () => {
    const result = evaluateAgentEligibility({
      manifest: { status: 'current', capabilities: [], skills: [] },
      available: true,
      requiredCapabilities: ['deploy', 'deploy'],
      requiredSkills: ['rust', 'rust'],
    });
    expect(result.capabilities).toEqual([{ name: 'deploy', status: 'missing' }]);
    expect(result.requiredSkills).toEqual([{ name: 'rust', status: 'missing' }]);
  });
});

describe('validateProposedSkillIds (AC#5 fail-closed)', () => {
  test('ok when every proposed id exists in the active manifest set', () => {
    expect(
      validateProposedSkillIds({
        proposedSkillIds: ['typescript', 'python'],
        activeManifestSkillIds: ['typescript', 'python', 'rust'],
      }),
    ).toEqual({ ok: true, unknownSkillIds: [] });
  });

  test('rejects ids the PI invented (not in any active manifest)', () => {
    expect(
      validateProposedSkillIds({
        proposedSkillIds: ['typescript', 'invented-skill'],
        activeManifestSkillIds: ['typescript'],
      }),
    ).toEqual({ ok: false, unknownSkillIds: ['invented-skill'] });
  });

  test('case-insensitive and deduped', () => {
    expect(
      validateProposedSkillIds({
        proposedSkillIds: ['TypeScript', 'typescript', 'Rust'],
        activeManifestSkillIds: ['typescript'],
      }),
    ).toEqual({ ok: false, unknownSkillIds: ['rust'] });
  });

  test('empty manifest → every proposed id is unknown (cannot require undeclared skills)', () => {
    expect(
      validateProposedSkillIds({
        proposedSkillIds: ['typescript'],
        activeManifestSkillIds: [],
      }),
    ).toEqual({ ok: false, unknownSkillIds: ['typescript'] });
  });

  test('empty proposed → ok (nothing to validate)', () => {
    expect(
      validateProposedSkillIds({ proposedSkillIds: [], activeManifestSkillIds: [] }),
    ).toEqual({ ok: true, unknownSkillIds: [] });
  });
});

describe('resolveHardSpecifiedTarget (AC#6 不静默改派)', () => {
  const qualified = { state: 'qualified' as const, available: true };

  test('non-hard-specified + qualified + available → eligible', () => {
    expect(
      resolveHardSpecifiedTarget({ eligibility: qualified, isHardSpecified: false }),
    ).toBe('eligible');
  });

  test('non-hard-specified + not_qualified → ineligible (dropped from candidates)', () => {
    expect(
      resolveHardSpecifiedTarget({
        eligibility: { state: 'not_qualified', available: true },
        isHardSpecified: false,
      }),
    ).toBe('ineligible');
  });

  test('non-hard-specified + unknown → ineligible (cannot auto-dispatch to unverifiable agent)', () => {
    expect(
      resolveHardSpecifiedTarget({
        eligibility: { state: 'unknown', available: true },
        isHardSpecified: false,
      }),
    ).toBe('ineligible');
  });

  test('non-hard-specified + qualified but unavailable → ineligible', () => {
    expect(
      resolveHardSpecifiedTarget({
        eligibility: { state: 'qualified', available: false },
        isHardSpecified: false,
      }),
    ).toBe('ineligible');
  });

  test('hard-specified + qualified + available → eligible', () => {
    expect(
      resolveHardSpecifiedTarget({ eligibility: qualified, isHardSpecified: true }),
    ).toBe('eligible');
  });

  test('hard-specified + required skill undeclared (unknown) → needs_confirmation, keep target (AC#6)', () => {
    expect(
      resolveHardSpecifiedTarget({
        eligibility: { state: 'unknown', available: true },
        isHardSpecified: true,
      }),
    ).toBe('needs_confirmation');
  });

  test('hard-specified + declared-but-missing skill (not_qualified) → needs_confirmation, keep target', () => {
    expect(
      resolveHardSpecifiedTarget({
        eligibility: { state: 'not_qualified', available: true },
        isHardSpecified: true,
      }),
    ).toBe('needs_confirmation');
  });

  test('hard-specified + qualified but offline → needs_confirmation (confirm_offline_target)', () => {
    expect(
      resolveHardSpecifiedTarget({
        eligibility: { state: 'qualified', available: false },
        isHardSpecified: true,
      }),
    ).toBe('needs_confirmation');
  });
});

describe('rankQualifiedCandidates (AC#3 only sorts among qualified)', () => {
  test('preferred skill hits is the primary key (desc)', () => {
    const ranked = rankQualifiedCandidates(
      [
        { agentId: 'a', exposedSkills: [], available: true },
        { agentId: 'b', exposedSkills: ['typescript', 'python'], available: true },
        { agentId: 'c', exposedSkills: ['typescript'], available: true },
      ],
      ['typescript', 'python'],
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['b', 'c', 'a']);
  });

  test('tie on preferred → available agents rank before unavailable', () => {
    const ranked = rankQualifiedCandidates(
      [
        { agentId: 'a', exposedSkills: ['typescript'], available: false },
        { agentId: 'b', exposedSkills: ['typescript'], available: true },
      ],
      ['typescript'],
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['b', 'a']);
  });

  test('tie on preferred+available → higher experience wins', () => {
    const ranked = rankQualifiedCandidates(
      [
        { agentId: 'a', exposedSkills: ['typescript'], available: true, experienceScore: 2 },
        { agentId: 'b', exposedSkills: ['typescript'], available: true, experienceScore: 9 },
      ],
      ['typescript'],
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['b', 'a']);
  });

  test('tie on preferred+available+experience → lower load wins (higher loadScore)', () => {
    const ranked = rankQualifiedCandidates(
      [
        { agentId: 'a', exposedSkills: ['typescript'], available: true, loadScore: 1 },
        { agentId: 'b', exposedSkills: ['typescript'], available: true, loadScore: 8 },
      ],
      ['typescript'],
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['b', 'a']);
  });

  test('full tie → stable original order', () => {
    const ranked = rankQualifiedCandidates(
      [
        { agentId: 'a', exposedSkills: ['typescript'], available: true },
        { agentId: 'b', exposedSkills: ['typescript'], available: true },
      ],
      ['typescript'],
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['a', 'b']);
  });

  test('empty preferred → availability/experience/load still order', () => {
    const ranked = rankQualifiedCandidates(
      [
        { agentId: 'a', exposedSkills: ['x'], available: false },
        { agentId: 'b', exposedSkills: ['y'], available: true },
      ],
      [],
    );
    expect(ranked.map((c) => c.agentId)).toEqual(['b', 'a']);
  });
});

import { describe, expect, test } from 'vitest';

import {
  evaluateCapabilityMatch,
  evaluateSkillCoverage,
  rankByPreferredSkills,
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

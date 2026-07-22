import { describe, expect, test } from 'vitest';

import { ELIGIBILITY_REASON_CODE } from '@agentbean/contracts';

import { computeAgentEligibilityView, computeCoverageGap } from '../lib/agent-coverage';

describe('agent-coverage', () => {
  test('effective = exposed 减 disabled；missing = required 减 effective', () => {
    const result = computeCoverageGap({
      exposed: ['code-review', 'lint', 'deploy'],
      disabled: ['deploy'],
      required: ['code-review', 'deploy', 'test'],
    });
    expect(result.effective).toEqual(['code-review', 'lint']);
    expect(result.missing).toEqual(['deploy', 'test']);
  });

  test('大小写不敏感匹配', () => {
    const result = computeCoverageGap({
      exposed: ['Code-Review'],
      disabled: [],
      required: ['code-review'],
    });
    expect(result.missing).toEqual([]);
  });

  test('required 去重', () => {
    const result = computeCoverageGap({
      exposed: [],
      disabled: [],
      required: ['deploy', 'deploy'],
    });
    expect(result.missing).toEqual(['deploy']);
  });

  test('无 required 时无缺口', () => {
    const result = computeCoverageGap({ exposed: ['code-review'], disabled: [], required: [] });
    expect(result.missing).toEqual([]);
  });
});

// ── #711 AC#7：Task/PI coverage 视图展示合格/不合格理由（不泄漏内部） ──

describe('computeAgentEligibilityView', () => {
  test('qualified：生效能力/技能覆盖全部硬要求', () => {
    const view = computeAgentEligibilityView({
      hasCurrentManifest: true,
      available: true,
      effectiveCapabilities: ['code-review', 'lint'],
      effectiveSkills: ['typescript'],
      requiredCapabilities: ['lint'],
      requiredSkills: ['typescript'],
      preferredSkills: ['typescript', 'rust'],
    });
    expect(view.state).toBe('qualified');
    expect(view.capabilities).toEqual([{ name: 'lint', status: 'covered' }]);
    expect(view.requiredSkills).toEqual([{ name: 'typescript', status: 'covered' }]);
    expect(view.preferredSkills).toEqual([
      { name: 'typescript', matched: true },
      { name: 'rust', matched: false },
    ]);
    expect(view.missingHardRequirements).toEqual([]);
    expect(view.reasonCode).toBe(ELIGIBILITY_REASON_CODE.QUALIFIED);
  });

  test('not_qualified：公开声明明确缺失硬能力/技能', () => {
    const view = computeAgentEligibilityView({
      hasCurrentManifest: true,
      available: true,
      effectiveCapabilities: ['coding'],
      effectiveSkills: ['typescript'],
      requiredCapabilities: ['coding', 'deploy'],
      requiredSkills: ['typescript', 'rust'],
    });
    expect(view.state).toBe('not_qualified');
    expect(view.capabilities).toContainEqual({ name: 'deploy', status: 'missing' });
    expect(view.requiredSkills).toContainEqual({ name: 'rust', status: 'missing' });
    expect(view.missingHardRequirements).toEqual(['deploy', 'rust']);
    expect(view.reasonCode).toBe(ELIGIBILITY_REASON_CODE.MISSING_HARD_REQUIREMENT);
  });

  test('unknown：无当前声明时全部 undeclared，绝不推断 missing（AC#4）', () => {
    const view = computeAgentEligibilityView({
      hasCurrentManifest: false,
      available: true,
      effectiveCapabilities: [],
      effectiveSkills: [],
      requiredCapabilities: ['deploy'],
      requiredSkills: ['rust'],
    });
    expect(view.state).toBe('unknown');
    expect(view.requiredSkills.every((s) => s.status === 'undeclared')).toBe(true);
    expect(view.capabilities.every((c) => c.status === 'undeclared')).toBe(true);
    expect(view.missingHardRequirements).toEqual([]);
    expect(view.reasonCode).toBe(ELIGIBILITY_REASON_CODE.UNDECLARED);
  });

  test('unknown 透传成因：expired / unreachable 渲染对应码（AC#4，不与 domain 漂移）', () => {
    const base = {
      hasCurrentManifest: false,
      available: true,
      effectiveCapabilities: [],
      effectiveSkills: [],
      requiredCapabilities: [],
      requiredSkills: ['rust'],
    } as const;
    expect(computeAgentEligibilityView({ ...base, unknownCause: 'expired' }).reasonCode).toBe(
      ELIGIBILITY_REASON_CODE.MANIFEST_EXPIRED,
    );
    expect(computeAgentEligibilityView({ ...base, unknownCause: 'unreachable' }).reasonCode).toBe(
      ELIGIBILITY_REASON_CODE.MANIFEST_UNREACHABLE,
    );
  });

  test('大小写不敏感匹配', () => {
    const view = computeAgentEligibilityView({
      hasCurrentManifest: true,
      available: true,
      effectiveCapabilities: ['Code-Review'],
      effectiveSkills: ['TypeScript'],
      requiredCapabilities: ['code-review'],
      requiredSkills: ['typescript'],
    });
    expect(view.state).toBe('qualified');
  });

  test('硬要求去重', () => {
    const view = computeAgentEligibilityView({
      hasCurrentManifest: true,
      available: true,
      effectiveCapabilities: [],
      effectiveSkills: [],
      requiredCapabilities: ['deploy', 'deploy'],
      requiredSkills: ['rust', 'rust'],
    });
    expect(view.capabilities).toEqual([{ name: 'deploy', status: 'missing' }]);
    expect(view.requiredSkills).toEqual([{ name: 'rust', status: 'missing' }]);
  });
});

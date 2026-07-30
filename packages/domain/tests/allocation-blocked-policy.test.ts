import { describe, expect, test } from 'vitest';

import { desensitizeAllocationSuggestion } from '../src/index.js';
import type { AllocationCandidateDiagnosticView } from '../src/index.js';

function candidate(hasRequiredCapabilities: boolean, channelForbidden: boolean): AllocationCandidateDiagnosticView {
  return { hasRequiredCapabilities, channelForbidden };
}

describe('desensitizeAllocationSuggestion (ADR-0064 #948-F)', () => {
  test('no_candidate（频道内外都无候选）→ escalate_no_capability', () => {
    expect(desensitizeAllocationSuggestion({ cause: 'no_candidate', candidates: [] }))
      .toEqual({ kind: 'escalate_no_capability', cause: 'no_candidate' });
  });

  test('候选都缺能力（无外部可胜任）→ escalate_no_capability', () => {
    expect(desensitizeAllocationSuggestion({
      cause: 'no_qualified_candidate',
      candidates: [candidate(false, false), candidate(false, true)],
    })).toEqual({ kind: 'escalate_no_capability', cause: 'no_qualified_candidate' });
  });

  test('有频道外 agent 可胜任（脱敏：仅计数，不泄露身份）→ escalate_external_capability', () => {
    const suggestion = desensitizeAllocationSuggestion({
      cause: 'no_qualified_candidate',
      candidates: [candidate(false, false), candidate(true, true)],
    });
    expect(suggestion).toEqual({ kind: 'escalate_external_capability',
      cause: 'no_qualified_candidate', externalAgentCount: 1 });
    // 不变量：输出不含任何 agent 身份字段（脱敏）。
    expect(JSON.stringify(suggestion)).not.toMatch(/agentId|agent_id/i);
  });

  test('多个频道外可胜任 agent → 计数聚合（仍脱敏）', () => {
    expect(desensitizeAllocationSuggestion({
      cause: 'all_unknown',
      candidates: [candidate(true, true), candidate(true, true), candidate(false, true)],
    })).toEqual({ kind: 'escalate_external_capability', cause: 'all_unknown', externalAgentCount: 2 });
  });

  test('频道内可胜任 agent 不计入外部（它在频道内，不属脱敏建议）', () => {
    // hasRequiredCapabilities=true & channelForbidden=false = 频道内可胜任（理论上 eligible，
    // 不应出现在 unallocatable 场景；防御性地不计入 external）。
    expect(desensitizeAllocationSuggestion({
      cause: 'no_qualified_candidate',
      candidates: [candidate(true, false)],
    })).toEqual({ kind: 'escalate_no_capability', cause: 'no_qualified_candidate' });
  });
});

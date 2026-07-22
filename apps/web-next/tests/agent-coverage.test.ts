import { describe, expect, test } from 'vitest';

import { computeCoverageGap } from '../lib/agent-coverage';

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

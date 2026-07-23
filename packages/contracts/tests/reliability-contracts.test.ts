import { describe, expect, test } from 'vitest';

import {
  ATTRIBUTION_CORRECTION_REASON_CODE,
  NEGATIVE_RELIABILITY_OUTCOMES,
  POSITIVE_RELIABILITY_OUTCOMES,
  RELIABILITY_OUTCOME_KINDS,
  RELIABILITY_RISK_HINT,
} from '../src/index.js';

/**
 * #714 reliability / attribution-correction 码是 server 投影与 web 渲染共享的 canonical 常量。
 * 锁定字面量，防止任一端重命名导致另一端按字符串匹配时静默失配（同 #711 风格）。
 */
describe('RELIABILITY_RISK_HINT (canonical, shared server/web)', () => {
  test('三类风险提示码稳定', () => {
    expect(RELIABILITY_RISK_HINT.HIGH_TIMEOUT_RATE).toBe('RELIABILITY_RISK_HIGH_TIMEOUT_RATE');
    expect(RELIABILITY_RISK_HINT.HIGH_RELINQUISH_RATE).toBe('RELIABILITY_RISK_HIGH_RELINQUISH_RATE');
    expect(RELIABILITY_RISK_HINT.LOW_SAMPLE).toBe('RELIABILITY_RISK_LOW_SAMPLE');
  });

  test('三个码互异', () => {
    const codes = Object.values(RELIABILITY_RISK_HINT);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(3);
  });
});

describe('ATTRIBUTION_CORRECTION_REASON_CODE (canonical, shared server/web)', () => {
  test('七个纠错决定码稳定', () => {
    expect(ATTRIBUTION_CORRECTION_REASON_CODE.RECORDED_PENDING).toBe(
      'ATTRIBUTION_CORRECTION_RECORDED_PENDING',
    );
    expect(ATTRIBUTION_CORRECTION_REASON_CODE.FACT_DOWNWEIGHTED).toBe(
      'ATTRIBUTION_CORRECTION_FACT_DOWNWEIGHTED',
    );
    expect(ATTRIBUTION_CORRECTION_REASON_CODE.REJECTED).toBe(
      'ATTRIBUTION_CORRECTION_REJECTED',
    );
    expect(ATTRIBUTION_CORRECTION_REASON_CODE.INVALID_FACT_REF).toBe(
      'ATTRIBUTION_CORRECTION_INVALID_FACT_REF',
    );
    expect(ATTRIBUTION_CORRECTION_REASON_CODE.INVALID_REASON).toBe(
      'ATTRIBUTION_CORRECTION_INVALID_REASON',
    );
    expect(ATTRIBUTION_CORRECTION_REASON_CODE.NOT_AGENT_OWNER).toBe(
      'ATTRIBUTION_CORRECTION_NOT_AGENT_OWNER',
    );
    expect(ATTRIBUTION_CORRECTION_REASON_CODE.NOT_AUTHORIZED_TO_RESOLVE).toBe(
      'ATTRIBUTION_CORRECTION_NOT_AUTHORIZED_TO_RESOLVE',
    );
  });

  test('七个码互异', () => {
    const codes = Object.values(ATTRIBUTION_CORRECTION_REASON_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(7);
  });
});

/**
 * AC#1/AC#2：reliability 事实 outcome 是 closed union——只有「可观测且已确认归因」的 5 种结果。
 * 主观模型评价、未审核结果、self-reported、其他 Team 历史**没有合法 outcome 值**，结构性
 * 无法构造为 ReliabilityAttributionFactDto。锁定这 5 种 + 正/负向划分。
 */
describe('RELIABILITY_OUTCOME_KINDS (AC#1/AC#2 closed union)', () => {
  test('恰好 5 种已确认归因 outcome', () => {
    expect(RELIABILITY_OUTCOME_KINDS).toEqual([
      'accepted',
      'completed',
      'manual_verified',
      'timed_out',
      'relinquished',
    ]);
  });

  test('不含主观 / 未审核 / self-reported outcome（AC#2 结构性保证）', () => {
    const forbidden = ['model_evaluated', 'self_reported', 'unreviewed', 'subjective', 'estimated'];
    for (const value of forbidden) {
      expect(RELIABILITY_OUTCOME_KINDS).not.toContain(value);
    }
  });

  test('正/负向划分覆盖全部 5 种且不重叠', () => {
    expect(POSITIVE_RELIABILITY_OUTCOMES).toEqual(['accepted', 'completed', 'manual_verified']);
    expect(NEGATIVE_RELIABILITY_OUTCOMES).toEqual(['timed_out', 'relinquished']);
    const all = [...POSITIVE_RELIABILITY_OUTCOMES, ...NEGATIVE_RELIABILITY_OUTCOMES];
    expect(new Set(all).size).toBe(RELIABILITY_OUTCOME_KINDS.length);
    expect(all.sort()).toEqual([...RELIABILITY_OUTCOME_KINDS].sort());
  });
});

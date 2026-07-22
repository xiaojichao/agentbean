import { describe, expect, test } from 'vitest';

import {
  ELIGIBILITY_REASON_CODE,
  eligibilityUnknownCauseReasonCode,
} from '../src/index.js';

/**
 * #711 资格判定码是 server 投影与 web 渲染共享的 canonical 常量（AC#1/AC#7）。
 * 锁定字面量，防止任一端重命名导致另一端按字符串匹配时静默失配。
 */
describe('ELIGIBILITY_REASON_CODE (canonical, shared server/web)', () => {
  test('qualified 与缺失硬门槛码稳定', () => {
    expect(ELIGIBILITY_REASON_CODE.QUALIFIED).toBe('ELIGIBILITY_QUALIFIED');
    expect(ELIGIBILITY_REASON_CODE.MISSING_HARD_REQUIREMENT).toBe(
      'ELIGIBILITY_MISSING_HARD_REQUIREMENT',
    );
  });

  test('unknown 三类原因码稳定（AC#4：不推断内部缺失/存在）', () => {
    expect(ELIGIBILITY_REASON_CODE.UNDECLARED).toBe('ELIGIBILITY_UNDECLARED');
    expect(ELIGIBILITY_REASON_CODE.MANIFEST_EXPIRED).toBe('ELIGIBILITY_MANIFEST_EXPIRED');
    expect(ELIGIBILITY_REASON_CODE.MANIFEST_UNREACHABLE).toBe('ELIGIBILITY_MANIFEST_UNREACHABLE');
  });

  test('五个码互异（视图可据此区分场景）', () => {
    const codes = Object.values(ELIGIBILITY_REASON_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(5);
  });
});

/**
 * #711 unknown 成因 → 判定码的 canonical 映射（domain 与 web 共用，消除三包重复）。
 * 锁定三态映射 + 默认臂 fail-closed。
 */
describe('eligibilityUnknownCauseReasonCode (canonical mapping)', () => {
  test('三态各自映射到对应判定码', () => {
    expect(eligibilityUnknownCauseReasonCode('undeclared')).toBe(
      ELIGIBILITY_REASON_CODE.UNDECLARED,
    );
    expect(eligibilityUnknownCauseReasonCode('expired')).toBe(
      ELIGIBILITY_REASON_CODE.MANIFEST_EXPIRED,
    );
    expect(eligibilityUnknownCauseReasonCode('unreachable')).toBe(
      ELIGIBILITY_REASON_CODE.MANIFEST_UNREACHABLE,
    );
  });
});

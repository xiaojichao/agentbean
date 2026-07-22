/**
 * #710 PI Team coverage 缺口纯计算（web-next 约定：只测纯函数）。
 * 与 domain evaluateCapabilityMatch 同语义的 web 本地版（web 不直接依赖 domain 包）。
 */

export interface CoverageGapInput {
  readonly exposed: readonly string[];
  readonly disabled: readonly string[];
  readonly required: readonly string[];
}

export interface CoverageGapResult {
  /** 生效能力 = exposed 减 disabled（大小写不敏感）。 */
  readonly effective: readonly string[];
  /** required 中未被生效能力覆盖的（缺口，大小写不敏感，去重保序）。 */
  readonly missing: readonly string[];
}

export function computeCoverageGap(input: CoverageGapInput): CoverageGapResult {
  const disabledSet = new Set(input.disabled.map((entry) => entry.toLowerCase()));
  const effective = input.exposed.filter((entry) => !disabledSet.has(entry.toLowerCase()));
  const effectiveSet = new Set(effective.map((entry) => entry.toLowerCase()));
  const missing: string[] = [];
  for (const requirement of input.required) {
    const lower = requirement.toLowerCase();
    if (!effectiveSet.has(lower) && !missing.includes(lower)) missing.push(lower);
  }
  return { effective, missing };
}

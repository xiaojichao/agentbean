/**
 * #714 Team-local reliability 纯规则（切片核心）。
 *
 * 职责：从当前 Team 内**可观测且已确认归因**的履约事实（AC#1）形成 reliability signal，
 * 仅供合格候选排序 tie-breaker 与风险提示消费（AC#3）。无 server 依赖、无 IO，可单测。
 *
 * 关键不变量（与 contracts `reliability.ts` 注释一致）：
 * - AC#1：只统计 `teamId === 当前 Team && agentId === 当前 Agent` 的事实；跨 Team / 跨 Agent
 *   的事实一律丢弃，绝不形成当前 Team 的负面事实。
 * - AC#2：「无数据」永不形成负面事实。无任何已确认事实时 score 一律 neutral（1.0）——
 *   reliability 只能凭已确认负向 outcome（timed_out / relinquished）降分，不能凭缺失 / 主观 /
 *   未审核降分。主观与未审核结果在契约层就没有合法 outcome 值，结构性无法进入本函数。
 * - AC#3：本模块输出是标量 score + 风险提示，唯一消费者是 `rankQualifiedCandidates`
 *   tie-breaker；它永不补齐 capability/skill，也永不删除 Manifest Skill（结构性保证）。
 * - AC#5：`excludedFactRefs` 让 acknowledged 的纠错事实从计算中排除（不自动删除，保留审计，
 *   但不再形成负面事实）——纠错入口由此真正影响 reliability。
 * - AC#7：纯函数 + 输出按 operationKey 排序，相同输入任意顺序都产生相同输出。
 */
import {
  RELIABILITY_RISK_HINT,
  type ID,
  type MemberVisibleReliabilityDto,
  type MemberVisibleReliabilityEntryDto,
  type OperationReliabilityEntryDto,
  type ReliabilityAttributionFactDto,
  type ReliabilityFactSourceRefDto,
  type ReliabilityRiskHintCode,
  type ReliabilitySignalDto,
} from '@agentbean/contracts';

/**
 * 触发 HIGH_* 风险提示的已确认负向 outcome 次数阈值（AC#1「多次出现已确认失败」）。
 * 单次 timeout/relinquish 不构成稳定负面信号，避免一次偶发即形成当前 Team 负面事实。
 */
export const RELIABILITY_HIGH_NEGATIVE_THRESHOLD = 2;
/** 触发 LOW_SAMPLE 提示的总样本上界（< 此值视为样本不足，信息性而非负面事实）。 */
export const RELIABILITY_LOW_SAMPLE_THRESHOLD = 3;
/** 无任何已确认事实时的中性 score（AC#2：无数据 = 中性高，永不降权未证 agent）。 */
export const RELIABILITY_NEUTRAL_SCORE = 1;

export interface EvaluateTeamLocalReliabilityInput {
  readonly teamId: ID;
  readonly agentId: ID;
  /** 候选事实集合；可能含其他 Team / 跨 Agent 噪声——本函数只保留当前 team+agent 的事实。 */
  readonly facts: readonly ReliabilityAttributionFactDto[];
  /**
   * AC#5 纠错降权：已被 owner/admin acknowledged 为错误归因的事实来源引用。
   * 匹配（kind+id）的事实从计算中排除——不删除，但不再形成负面事实。
   */
  readonly excludedFactRefs?: readonly ReliabilityFactSourceRefDto[];
}

interface OperationBucket {
  readonly operationKey: string;
  accepted: number;
  completed: number;
  manualVerified: number;
  timedOut: number;
  relinquished: number;
}

/**
 * 共享 fact-ref 规范化键。reliability 计算与 restriction 依据校验 / 纠错解析共用**同一编码**，
 * 防止两处分头实现而漂移——一旦漂移，acknowledged 纠错（resolveAttributionCorrection.downweightedFactRef）
 * 将不再正确匹配 reliability 的 excludedFactRefs，纠错反馈链静默失效。operation-restriction-policy 复用此函数。
 */
export function reliabilityFactRefKey(ref: ReliabilityFactSourceRefDto): string {
  return `${ref.kind}::${ref.id}`;
}

function isExcluded(
  ref: ReliabilityFactSourceRefDto,
  excluded: ReadonlySet<string>,
): boolean {
  return excluded.has(reliabilityFactRefKey(ref));
}

function buildEntry(bucket: OperationBucket): OperationReliabilityEntryDto {
  const positive = bucket.accepted + bucket.completed + bucket.manualVerified;
  const negative = bucket.timedOut + bucket.relinquished;
  const total = positive + negative;
  // AC#2：无数据 neutral；此处 total≥1（entry 仅在有事实时创建），score = positive/total。
  const score = total === 0 ? RELIABILITY_NEUTRAL_SCORE : positive / total;
  const riskHints: ReliabilityRiskHintCode[] = [];
  if (bucket.timedOut >= RELIABILITY_HIGH_NEGATIVE_THRESHOLD) {
    riskHints.push(RELIABILITY_RISK_HINT.HIGH_TIMEOUT_RATE);
  }
  if (bucket.relinquished >= RELIABILITY_HIGH_NEGATIVE_THRESHOLD) {
    riskHints.push(RELIABILITY_RISK_HINT.HIGH_RELINQUISH_RATE);
  }
  if (total < RELIABILITY_LOW_SAMPLE_THRESHOLD) {
    riskHints.push(RELIABILITY_RISK_HINT.LOW_SAMPLE);
  }
  return {
    operationKey: bucket.operationKey,
    score,
    accepted: bucket.accepted,
    completed: bucket.completed,
    manualVerified: bucket.manualVerified,
    timedOut: bucket.timedOut,
    relinquished: bucket.relinquished,
    total,
    riskHints,
  };
}

/**
 * AC#1/AC#2/AC#7：从当前 Team 已确认归因事实计算 reliability signal。
 * - 过滤：当前 team+agent，排除纠错降权事实。
 * - 分组：按 operationKey（lowercase）聚合 outcome 计数。
 * - 打分：score = positive/(positive+negative)；风险提示按阈值；无 entry → overall neutral。
 * - 确定性：perOperation 按 operationKey 升序；相同输入任意顺序→相同输出（AC#7）。
 */
export function evaluateTeamLocalReliability(
  input: EvaluateTeamLocalReliabilityInput,
): ReliabilitySignalDto {
  const excluded = new Set((input.excludedFactRefs ?? []).map(reliabilityFactRefKey));

  const buckets = new Map<string, OperationBucket>();
  for (const f of input.facts) {
    // AC#1：只统计当前 Team + 当前 Agent 的事实。
    if (f.teamId !== input.teamId || f.agentId !== input.agentId) continue;
    // AC#5：排除 acknowledged 纠错事实。
    if (isExcluded(f.sourceRef, excluded)) continue;
    const key = String(f.operationKey).toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        operationKey: key,
        accepted: 0,
        completed: 0,
        manualVerified: 0,
        timedOut: 0,
        relinquished: 0,
      };
      buckets.set(key, bucket);
    }
    switch (f.outcome) {
      case 'accepted':
        bucket.accepted += 1;
        break;
      case 'completed':
        bucket.completed += 1;
        break;
      case 'manual_verified':
        bucket.manualVerified += 1;
        break;
      case 'timed_out':
        bucket.timedOut += 1;
        break;
      case 'relinquished':
        bucket.relinquished += 1;
        break;
      // 契约层 closed union 已保证无其他值；此处防御性忽略非法 outcome（fail-soft，不形成事实）。
      default:
        break;
    }
  }

  const perOperation = Array.from(buckets.values())
    .map(buildEntry)
    .sort((a, b) => (a.operationKey < b.operationKey ? -1 : a.operationKey > b.operationKey ? 1 : 0));

  // overallScore = 样本加权平均；无 entry → neutral（AC#2）。
  const totalSamples = perOperation.reduce((sum, e) => sum + e.total, 0);
  const overallScore =
    perOperation.length === 0 || totalSamples === 0
      ? RELIABILITY_NEUTRAL_SCORE
      : perOperation.reduce((sum, e) => sum + e.score * e.total, 0) / totalSamples;

  return {
    teamId: input.teamId,
    agentId: input.agentId,
    overallScore,
    perOperation,
  };
}

/**
 * AC#3/AC#7：把 reliability signal 折算为单个排序标量，供 `rankQualifiedCandidates` tie-breaker。
 * - 无 required operation → neutral 1.0（reliability 不适用）。
 * - 某 required operation 无 reliability 条目 → **贡献 neutral 1.0**（AC#2 不因无数据降权）：
 *   缺失的 operation 与「完美」等价，不被其他 operation 的已确认失败拖低（混合场景防过度降权）。
 * - 否则取所有 required operation（去重）的 score 均值，无条目者按 1.0 计。
 * 调用方负责先用 `evaluateAgentEligibility` 过出合格候选——reliability 只在合格候选间排序。
 */
export function reliabilityRankingScore(
  signal: ReliabilitySignalDto,
  operationKeys: readonly string[],
): number {
  if (operationKeys.length === 0) return RELIABILITY_NEUTRAL_SCORE;
  const byKey = new Map(signal.perOperation.map((e) => [e.operationKey, e]));
  const seen = new Set<string>();
  let sum = 0;
  let counted = 0;
  for (const raw of operationKeys) {
    const key = String(raw).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byKey.get(key);
    sum += entry ? entry.score : RELIABILITY_NEUTRAL_SCORE;
    counted += 1;
  }
  if (counted === 0) return RELIABILITY_NEUTRAL_SCORE;
  return sum / counted;
}

/**
 * AC#6：把 owner/admin 全量 reliability signal 裁剪为普通成员可见的视图。
 * 成员只看到「与当前 Task 匹配相关」的 operation，且只暴露「是否影响本次匹配排序」+ 单条
 * 风险提示；不含 overallScore、outcome 计数、纠错细节或其他 operation（防止全量 reliability
 * 与跨 operation 信息泄漏给普通成员）。
 *
 * 无 reliability 条目的 required operation 不出现（无可 conveyed 的风险理由）。
 */
export function redactReliabilityForTaskMatching(
  signal: ReliabilitySignalDto,
  options: { readonly requiredOperations: readonly string[] },
): MemberVisibleReliabilityDto {
  const byKey = new Map(signal.perOperation.map((e) => [e.operationKey, e]));
  const seen = new Set<string>();
  const entries: MemberVisibleReliabilityEntryDto[] = [];
  for (const raw of options.requiredOperations) {
    const key = String(raw).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byKey.get(key);
    if (!entry) continue; // 无条目：无风险理由可展示，跳过（AC#6 不展示无数据）。
    entries.push({
      operationKey: entry.operationKey,
      affectsRanking: entry.score < RELIABILITY_NEUTRAL_SCORE,
      riskHint: entry.riskHints[0] ?? null,
    });
  }
  return { agentId: signal.agentId, entries };
}

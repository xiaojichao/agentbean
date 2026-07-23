import type { ID, MemoryScopeType } from '@agentbean/contracts';

/**
 * Memory scope expansion 纯策略（issue #719 / ADR-0007）。
 *
 * ADR-0007 规定：任何「跨频道」「Channel 到 Team」「Device-local 到 Team」「向其他 Agent 扩散」
 * 的 Memory scope expansion 都必须显式确认。Device-local 不在 server `MemoryScopeType` 内
 * （属 local-* 作用域，经独立 capsule 机制），故本策略覆盖 server 候选路径的全部四例等价情形。
 *
 * 判定原则（受众窄→宽）：把来源证据写入比其原始作用域更宽的受众即「扩大」，需人工确认；
 * 收窄（team→channel）或同宽异型（agent→channel）不门禁（保守，MVP 不拦）。
 *
 * 本层只裁定「是否扩大 / 是哪种扩大」；是否要求确认由 service 层（memory-candidate-service）
 * 在 accept/merge 调用时按 `confirmScopeExpansion` 施加。
 */

/** 作用域受众宽度（窄→宽），用于比较是否扩大。agent/user 与 channel 同宽（不同维度）。 */
const SCOPE_WIDTH: Record<MemoryScopeType, number> = {
  task: 0,
  dm: 1,
  channel: 2,
  agent: 2,
  user: 2,
  team: 3,
};

export type ScopeExpansionKind =
  | 'cross-channel'
  | 'to-other-agent'
  | 'channel-to-team'
  | 'task-to-broader'
  | 'dm-to-broader'
  | 'agent-to-broader'
  | 'broadening';

const EXPANSION_REASON: Record<ScopeExpansionKind, string> = {
  'cross-channel': '跨频道复用经验需要显式确认',
  'to-other-agent': '向其他 Agent 扩散需要显式确认',
  'channel-to-team': '从频道提升到 Team 作用域需要显式确认',
  'task-to-broader': '从任务作用域提升到更宽作用域需要显式确认',
  'dm-to-broader': '从 DM 作用域提升到更宽作用域需要显式确认',
  'agent-to-broader': '从 Agent 作用域提升到更宽作用域需要显式确认',
  broadening: '扩大 Memory 作用域需要显式确认',
};

export interface ScopeExpansionAssessment {
  readonly isExpansion: boolean;
  readonly kind: ScopeExpansionKind | null;
  /** 面向确认提示的人类可读理由；`isExpansion=false` 时为空串。 */
  readonly reason: string;
}

export interface ScopeExpansionInput {
  readonly sourceScopeType: MemoryScopeType;
  readonly sourceScopeRef: ID;
  readonly targetScopeType: MemoryScopeType;
  readonly targetScopeRef: ID;
}

const NO_EXPANSION: ScopeExpansionAssessment = { isExpansion: false, kind: null, reason: '' };

function expansion(kind: ScopeExpansionKind): ScopeExpansionAssessment {
  return { isExpansion: true, kind, reason: EXPANSION_REASON[kind] };
}

/**
 * 评估单条来源→目标 是否构成 scope expansion。
 *
 * - 同 scope（类型+ref 都相同）：非扩大。
 * - channel→channel 不同 ref：cross-channel。
 * - agent→agent 不同 ref（ref 即 agent id）：to-other-agent。
 * - 目标宽度严格大于来源：broadening（按来源类型细分 channel-to-team / task-to-broader /
 *   dm-to-broader / agent-to-broader，否则泛 broadening）。
 * - 收窄或同宽异型：MVP 不门禁（非扩大）。
 */
export function assessScopeExpansion(input: ScopeExpansionInput): ScopeExpansionAssessment {
  const { sourceScopeType: src, sourceScopeRef: srcRef, targetScopeType: tgt, targetScopeRef: tgtRef } = input;
  if (src === tgt && srcRef === tgtRef) return NO_EXPANSION;

  if (src === 'channel' && tgt === 'channel' && srcRef !== tgtRef) {
    return expansion('cross-channel');
  }
  if (src === 'agent' && tgt === 'agent' && srcRef !== tgtRef) {
    return expansion('to-other-agent');
  }

  if (SCOPE_WIDTH[tgt] > SCOPE_WIDTH[src]) {
    if (src === 'channel' && tgt === 'team') return expansion('channel-to-team');
    if (src === 'task') return expansion('task-to-broader');
    if (src === 'dm') return expansion('dm-to-broader');
    if (src === 'agent') return expansion('agent-to-broader');
    return expansion('broadening');
  }

  // 收窄或同宽异型：MVP 不门禁。
  return NO_EXPANSION;
}

export interface CandidateScopeExpansionInput {
  /** 候选的全部来源（每条带其原始 scope）。 */
  readonly sources: ReadonlyArray<{
    readonly sourceScopeType: MemoryScopeType;
    readonly sourceScopeRef: ID;
  }>;
  readonly targetScopeType: MemoryScopeType;
  readonly targetScopeRef: ID;
}

/**
 * 评估整条 candidate 是否涉及 scope expansion：任一来源扩大即整体需确认（返回首个命中的评估）。
 * 无来源或不扩大时返回非扩大。
 */
export function assessCandidateScopeExpansion(input: CandidateScopeExpansionInput): ScopeExpansionAssessment {
  for (const source of input.sources) {
    const assessment = assessScopeExpansion({
      sourceScopeType: source.sourceScopeType,
      sourceScopeRef: source.sourceScopeRef,
      targetScopeType: input.targetScopeType,
      targetScopeRef: input.targetScopeRef,
    });
    if (assessment.isExpansion) return assessment;
  }
  return NO_EXPANSION;
}

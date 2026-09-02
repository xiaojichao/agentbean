export const DETERMINISTIC_MESSAGE_ROUTE_POLICY_VERSION = 1;

export interface MessageRouteIntakeInput {
  readonly senderKind: 'human' | 'agent' | 'system';
  readonly channelKind: string;
  readonly threadId: string | null;
  readonly hasAgentMention: boolean;
  readonly hasTaskLinkage: boolean;
}

/** 只有未指派的人类频道根消息进入 PI 分析；明确路径继续由原 handler 负责。 */
export function shouldCreateMessageRouteAnalysis(input: MessageRouteIntakeInput): boolean {
  return input.senderKind === 'human'
    && input.channelKind === 'channel'
    && input.threadId === null
    && !input.hasAgentMention
    && !input.hasTaskLinkage;
}

export type DeterministicMessageRouteDecision =
  | {
      readonly kind: 'low_risk_collective';
      readonly policyVersion: 1;
      readonly directive: 'introduce_channel_agents';
      readonly targetAgentIds: readonly string[];
    }
  | { readonly kind: 'requires_pi'; readonly policyVersion: 1 };

/**
 * PI 不可用时的有限 fallback。只识别版本化、低风险、目标集合可冻结的 collective directive；
 * 不做通用关键词任务分类，不选择“第一个在线 Agent”。
 */
export function classifyDeterministicMessageRoute(input: {
  readonly body: string;
  readonly channelAgentIds: readonly string[];
}): DeterministicMessageRouteDecision {
  const normalized = input.body.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const addressesCollective = /(各位|大家|所有(?:频道)?agent|全体(?:频道)?agent)/iu.test(normalized);
  const asksIndividually = /(分别|逐一|每(?:一)?位|每(?:一)?个)/u.test(normalized);
  const asksIntroduction = /(介绍一下自己|自我介绍|介绍自己)/u.test(normalized);
  const targets = [...new Set(input.channelAgentIds)].sort((left, right) => left.localeCompare(right));
  if (addressesCollective && asksIndividually && asksIntroduction && targets.length > 0) {
    return {
      kind: 'low_risk_collective',
      policyVersion: DETERMINISTIC_MESSAGE_ROUTE_POLICY_VERSION,
      directive: 'introduce_channel_agents',
      targetAgentIds: targets,
    };
  }
  return { kind: 'requires_pi', policyVersion: DETERMINISTIC_MESSAGE_ROUTE_POLICY_VERSION };
}

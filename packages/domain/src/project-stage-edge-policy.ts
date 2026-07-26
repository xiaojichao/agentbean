import type {
  ProjectStageEdgeSemantics,
  ProjectStageRequiredInputRuleDto,
  TaskStatus,
} from '@agentbean/contracts';

/** #822 Stage edge 创建被拒绝的原因。全部 fail closed，不做补偿性猜测。 */
export type ProjectStageEdgeRejectionReason =
  | 'unknown_stage'
  | 'self_dependency'
  | 'cross_team'
  | 'cross_channel'
  | 'invalid_required_input'
  | 'duplicate_edge'
  | 'cycle';

export type ProjectStageEdgeCreationDecision =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: ProjectStageEdgeRejectionReason };

/** 参与依赖判定的阶段作用域事实，由 Server 从权威记录解析后传入。 */
export interface ProjectStageEdgeEndpoint {
  readonly stageId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly taskId: string;
}

export interface ProjectStageEdgeLink {
  readonly upstreamStageId: string;
  readonly downstreamStageId: string;
}

function isBlankText(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function hasInvalidRequiredInputs(
  requiredInputs: readonly ProjectStageRequiredInputRuleDto[],
): boolean {
  const seen = new Set<string>();
  for (const rule of requiredInputs) {
    if (isBlankText(rule?.key) || isBlankText(rule?.label)) return true;
    if (rule.kind !== 'artifact' && rule.kind !== 'document') return true;
    const key = rule.key.trim();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * 判断在既有 Stage 依赖图上追加 `upstream -> downstream` 是否会形成环。
 * 从 downstream 出发沿既有边前进；若能到达 upstream，则新边会闭合成环。
 */
function downstreamReachesUpstream(
  edges: readonly ProjectStageEdgeLink[],
  upstreamStageId: string,
  downstreamStageId: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.upstreamStageId);
    if (next) next.push(edge.downstreamStageId);
    else adjacency.set(edge.upstreamStageId, [edge.downstreamStageId]);
  }
  const visited = new Set<string>();
  const stack: string[] = [downstreamStageId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === upstreamStageId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return false;
}

/**
 * #822 AC#1/AC#3：校验一条新的 Stage edge。
 * 拒绝自依赖、跨 Team/Channel、非法必需输入规则、重复边与成环。
 */
export function evaluateProjectStageEdgeCreation(input: {
  readonly teamId: string;
  readonly channelId: string;
  readonly upstream: ProjectStageEdgeEndpoint | null | undefined;
  readonly downstream: ProjectStageEdgeEndpoint | null | undefined;
  readonly existingEdges: readonly ProjectStageEdgeLink[];
  readonly requiredInputs: readonly ProjectStageRequiredInputRuleDto[];
}): ProjectStageEdgeCreationDecision {
  const { upstream, downstream } = input;
  if (!upstream || !downstream) return { kind: 'rejected', reason: 'unknown_stage' };
  if (upstream.stageId === downstream.stageId || upstream.taskId === downstream.taskId) {
    return { kind: 'rejected', reason: 'self_dependency' };
  }
  if (upstream.teamId !== input.teamId || downstream.teamId !== input.teamId) {
    return { kind: 'rejected', reason: 'cross_team' };
  }
  if (upstream.channelId !== input.channelId || downstream.channelId !== input.channelId) {
    return { kind: 'rejected', reason: 'cross_channel' };
  }
  if (hasInvalidRequiredInputs(input.requiredInputs)) {
    return { kind: 'rejected', reason: 'invalid_required_input' };
  }
  const duplicate = input.existingEdges.some((edge) =>
    edge.upstreamStageId === upstream.stageId && edge.downstreamStageId === downstream.stageId);
  if (duplicate) return { kind: 'rejected', reason: 'duplicate_edge' };
  if (downstreamReachesUpstream(input.existingEdges, upstream.stageId, downstream.stageId)) {
    return { kind: 'rejected', reason: 'cycle' };
  }
  return { kind: 'accepted' };
}

export type ProjectStageExecutionBlockCode =
  | 'stage_dependency_incomplete'
  | 'stage_dependency_unaccepted'
  | 'required_input_missing';

export interface ProjectStageExecutionBlock {
  readonly code: ProjectStageExecutionBlockCode;
  readonly edgeId: string;
  readonly upstreamStageId: string;
  readonly upstreamTaskId: string;
  readonly requiredInputKey?: string;
}

export type ProjectStageExecutionGateDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'blocked'; readonly blocks: readonly ProjectStageExecutionBlock[] };

/** 一条入边在门禁判定时需要的上游权威事实。 */
export interface ProjectStageUpstreamEdgeFacts {
  readonly edgeId: string;
  readonly upstreamStageId: string;
  readonly upstreamTaskId: string;
  readonly semantics: ProjectStageEdgeSemantics;
  readonly upstreamTaskStatus: TaskStatus;
  readonly upstreamReviewDecision?: 'accepted' | 'rejected' | 'needs_human' | null;
  readonly requiredInputs: readonly ProjectStageRequiredInputRuleDto[];
  /** 由 Server 从权威产物事实解析出的已满足输入 key。 */
  readonly satisfiedRequiredInputKeys: readonly string[];
}

function upstreamTaskIsComplete(status: TaskStatus): boolean {
  return status === 'done' || status === 'closed';
}

/**
 * #822 AC#5：执行门禁。依赖或必需输入未满足时阻止新的 claim/Invocation。
 *
 * 门禁是对权威事实的纯投影：每次调用重新计算，满足后自动放行，
 * 不保存需要人工修复的内部阻塞状态。
 */
export function evaluateProjectStageExecutionGate(input: {
  readonly upstreamEdges: readonly ProjectStageUpstreamEdgeFacts[];
}): ProjectStageExecutionGateDecision {
  const blocks: ProjectStageExecutionBlock[] = [];
  for (const edge of input.upstreamEdges) {
    const complete = upstreamTaskIsComplete(edge.upstreamTaskStatus);
    const rejectedReview = edge.upstreamReviewDecision === 'rejected'
      || edge.upstreamReviewDecision === 'needs_human';
    if (edge.semantics === 'blocks_start' && !complete) {
      blocks.push({
        code: 'stage_dependency_incomplete',
        edgeId: edge.edgeId,
        upstreamStageId: edge.upstreamStageId,
        upstreamTaskId: edge.upstreamTaskId,
      });
    }
    if (edge.requiredInputs.length === 0) continue;
    // 必需输入只能来自已交付且未被否决的上游阶段。
    if (!complete) {
      if (edge.semantics !== 'blocks_start') {
        blocks.push({
          code: 'stage_dependency_incomplete',
          edgeId: edge.edgeId,
          upstreamStageId: edge.upstreamStageId,
          upstreamTaskId: edge.upstreamTaskId,
        });
      }
    } else if (rejectedReview) {
      blocks.push({
        code: 'stage_dependency_unaccepted',
        edgeId: edge.edgeId,
        upstreamStageId: edge.upstreamStageId,
        upstreamTaskId: edge.upstreamTaskId,
      });
    }
    const satisfied = new Set(edge.satisfiedRequiredInputKeys);
    for (const rule of edge.requiredInputs) {
      if (satisfied.has(rule.key)) continue;
      blocks.push({
        code: 'required_input_missing',
        edgeId: edge.edgeId,
        upstreamStageId: edge.upstreamStageId,
        upstreamTaskId: edge.upstreamTaskId,
        requiredInputKey: rule.key,
      });
    }
  }
  return blocks.length === 0 ? { kind: 'allowed' } : { kind: 'blocked', blocks };
}

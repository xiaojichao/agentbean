import type { FrozenProjectInputItemDto, ID } from '@agentbean/contracts';

/**
 * #1064 AC3：Task-linked @Agent 请求的纯复验策略。
 *
 * 调用方（server application handler）先读取当前事实并解析候选 Agent（复用既有
 * `resolveCandidates`——其中已含 operation restriction / Team visibility / 渠道门禁），
 * 本模块做 fail-closed 裁决，不接触仓储：
 *
 * - Task authority：发送者必须是 task requester（creatorId）或预绑定的人类验收
 *   authority（root=human review authority，subtask=human acceptance authority，#1061）；
 * - revision/attempt fence：期望值与当前不符即 stale，绝不静默换版本；
 * - Agent eligibility：显式 `@Agent` 的每个目标都必须合格——不合格即拒绝整条请求，
 *   不静默改派（AC5）；
 * - Artifact visibility：冻结输入的 collection 必须属于本频道；
 * - review/final basis：被 rejected/changes_requested 的版本不得作为默认下游输入
 *   （显式「基于此修改」选择除外——explicitVersionIds 由调用方从 selections 算出）；
 * - input binding：协调声明的 input binding 必须已解析（#948-G 同语义）。
 */
export type TaskLinkedRequestFailureCode =
  | 'TASK_NOT_FOUND'
  | 'TASK_CHANNEL_MISMATCH'
  | 'TASK_AUTHORITY_DENIED'
  | 'TASK_REVISION_STALE'
  | 'TASK_ATTEMPT_STALE'
  | 'TASK_NOT_OPEN'
  | 'AGENT_NOT_ELIGIBLE'
  | 'ARTIFACT_VISIBILITY_DENIED'
  | 'INPUT_BINDING_UNRESOLVED'
  | 'REVIEW_BASIS_BLOCKED'
  | 'CHANNEL_ARCHIVED';

export interface TaskLinkedRequestFactInput {
  readonly channelId: ID;
  readonly senderUserId: ID;
  readonly channelArchived: boolean;
  readonly task: {
    readonly id: ID;
    readonly channelId: ID;
    readonly creatorId: ID;
    readonly revision: number;
    readonly status: string;
  };
  /** tracked task（有 coordination）才发布 Offer；缺省视为非 tracked。 */
  readonly coordination?: {
    readonly attempt: number;
    readonly humanAcceptanceAuthorityIds: readonly ID[];
    /** #948-G：声明的 input binding 是否已全部可解析（publish gate 同类语义）。 */
    readonly inputBindingsResolved: boolean;
  };
  readonly expectedTaskRevision?: number;
  readonly expectedTaskAttempt?: number;
  /** `resolveCandidates` 已通过的 Agent id（含 operation restriction / Team visibility / 渠道门禁）。 */
  readonly eligibleAgentIds: readonly ID[];
  /** 用户显式 `@Agent` 的目标（主执行者约束，不替代 acceptance）。 */
  readonly requestedAgentIds: readonly ID[];
  /** 发送时刻冻结的具体版本输入（来自消息 ProjectReferenceSet）。 */
  readonly frozenInputs: readonly FrozenProjectInputItemDto[];
  /** 显式选择（package_members / artifact_version）的版本——不过 review 闸。 */
  readonly explicitVersionIds?: readonly ID[];
  /** 冻结输入涉及的 collection 必须全部属于本频道（Artifact visibility）。 */
  readonly visibleCollectionIds: readonly ID[];
}

export type TaskLinkedRequestEvaluationResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly code: TaskLinkedRequestFailureCode;
    /** REVIEW_BASIS_BLOCKED 时列出被阻断的具体版本。 */
    readonly blockedVersionIds?: readonly ID[];
  };

const TERMINAL_TASK_STATUSES = ['done', 'cancelled', 'closed'] as const;

export function evaluateTaskLinkedRequest(
  input: TaskLinkedRequestFactInput,
): TaskLinkedRequestEvaluationResult {
  if (input.channelArchived) {
    return { ok: false, code: 'CHANNEL_ARCHIVED' };
  }
  if (input.task.channelId !== input.channelId) {
    return { ok: false, code: 'TASK_CHANNEL_MISMATCH' };
  }
  // Task authority：requester 或预绑定人类 authority；否则 fail closed。
  const authorityIds = input.coordination?.humanAcceptanceAuthorityIds ?? [];
  if (input.senderUserId !== input.task.creatorId && !authorityIds.includes(input.senderUserId)) {
    return { ok: false, code: 'TASK_AUTHORITY_DENIED' };
  }
  if (input.expectedTaskRevision !== undefined && input.expectedTaskRevision !== input.task.revision) {
    return { ok: false, code: 'TASK_REVISION_STALE' };
  }
  if (input.coordination) {
    if (input.expectedTaskAttempt !== undefined
      && input.expectedTaskAttempt !== input.coordination.attempt) {
      return { ok: false, code: 'TASK_ATTEMPT_STALE' };
    }
    if (!input.coordination.inputBindingsResolved) {
      return { ok: false, code: 'INPUT_BINDING_UNRESOLVED' };
    }
  }
  if (TERMINAL_TASK_STATUSES.includes(input.task.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
    return { ok: false, code: 'TASK_NOT_OPEN' };
  }
  // Agent eligibility：每个显式 @Agent 目标都必须合格——不静默改派（AC5）。
  for (const agentId of input.requestedAgentIds) {
    if (!input.eligibleAgentIds.includes(agentId)) {
      return { ok: false, code: 'AGENT_NOT_ELIGIBLE' };
    }
  }
  // Artifact visibility：冻结输入涉及的 collection 必须全部属于本频道。
  const visible = new Set(input.visibleCollectionIds);
  for (const item of input.frozenInputs) {
    if (!visible.has(item.collectionId)) {
      return { ok: false, code: 'ARTIFACT_VISIBILITY_DENIED' };
    }
  }
  // review/final basis：被拒/要求修改的版本不得作为默认下游输入（显式「基于此修改」除外）。
  const explicit = new Set(input.explicitVersionIds ?? []);
  const blocked = input.frozenInputs.filter(
    (item) => !explicit.has(item.artifactVersionId)
      && (item.reviewState === 'rejected' || item.reviewState === 'changes_requested'),
  );
  if (blocked.length > 0) {
    return {
      ok: false,
      code: 'REVIEW_BASIS_BLOCKED',
      blockedVersionIds: blocked.map((item) => item.artifactVersionId),
    };
  }
  return { ok: true };
}

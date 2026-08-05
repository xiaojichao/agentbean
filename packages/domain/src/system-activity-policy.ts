/**
 * #929 System activity / attention / change feed 纯策略。
 *
 * 职责：
 * - 从已提交 source fact 生成 audience-scoped 投影（task timeline / thread card / attention）
 * - attention revision / unread / reminder 规则
 * - consistency token 未追上 → projection_not_ready
 * - 禁止 PI 伪装 sender/member/avatar
 * - mark-seen 只清当前 revision unread，不结束 attention/action_required
 * - change-feed cursor ack 不推进 Message Read / attention / Task responsibility
 *
 * 无 server 依赖、无 IO。
 */
import type {
  ConsistencyTokenEntryV1,
  ConsistencyTokenV1,
  SystemActivityFactKind,
  SystemActivityLevel,
  SystemActivityProjectionItemV1,
  SystemActivitySourceFactV1,
  SystemActivitySurface,
  SystemAttentionItemV1,
  SystemAttentionState,
} from '@agentbean/contracts';

// ---------------------------------------------------------------------------
// Level + surface classification
// ---------------------------------------------------------------------------

const MILESTONE_FACTS = new Set<SystemActivityFactKind>([
  'task_created',
  'task_revised',
  'offer_issued',
  'claim_acquired',
  'delivery_submitted',
  'in_review',
  'delivery_accepted',
  'delivery_rejected',
  'reassigned',
  'task_cancelled',
  'task_closed',
]);

const ATTENTION_FACTS = new Set<SystemActivityFactKind>([
  'waiting',
  'sla_breach',
  'recovery_pending',
  'in_review',
  'action_required_opened',
]);

const ACTION_REQUIRED_FACTS = new Set<SystemActivityFactKind>([
  'action_required_opened',
]);

const RESOLVE_ATTENTION_FACTS = new Set<SystemActivityFactKind>([
  'action_required_resolved',
  'delivery_accepted',
  'task_cancelled',
  'task_closed',
]);

/** 内部过程不得进入用户活动流。 */
export const INTERNAL_NON_ACTIVITY_FACT_MARKERS = [
  'lease',
  'fencing',
  'checkpoint',
  'model_call',
  'chain_of_thought',
  'freshness_hold',
] as const;

export function classifyActivityLevel(factKind: SystemActivityFactKind): SystemActivityLevel {
  if (ACTION_REQUIRED_FACTS.has(factKind)) return 'action_required';
  if (ATTENTION_FACTS.has(factKind)) {
    return factKind === 'in_review' ? 'attention' : 'attention';
  }
  if (MILESTONE_FACTS.has(factKind)) return 'milestone';
  return 'info';
}

/**
 * 同一权威事实按界面用途分层：
 * - task_timeline：完整人类可读工作时间线（可见成员）
 * - thread_card：仅稀疏里程碑
 * - attention_inbox：仅责任相关 attention / action_required
 */
export function surfacesForFact(factKind: SystemActivityFactKind): readonly SystemActivitySurface[] {
  const level = classifyActivityLevel(factKind);
  const surfaces: SystemActivitySurface[] = ['task_timeline'];
  if (MILESTONE_FACTS.has(factKind) || level === 'action_required') {
    surfaces.push('thread_card');
  }
  if (level === 'attention' || level === 'action_required') {
    surfaces.push('attention_inbox');
  }
  // 解决类事实也需要更新 timeline；thread card 用 milestone 刷新当前进展
  if (RESOLVE_ATTENTION_FACTS.has(factKind) && !surfaces.includes('thread_card')) {
    surfaces.push('thread_card');
  }
  return surfaces;
}

// ---------------------------------------------------------------------------
// Audience scoping
// ---------------------------------------------------------------------------

export interface AudienceScopeDecision {
  readonly surface: SystemActivitySurface;
  readonly recipientIds: readonly string[];
}

/**
 * 投影前 audience-scope 裁剪：客户端不能先收完整 payload 再隐藏。
 * timeline/card → visible；attention → responsible only。
 */
export function resolveAudienceForSurface(
  fact: SystemActivitySourceFactV1,
  surface: SystemActivitySurface,
): AudienceScopeDecision {
  if (surface === 'attention_inbox') {
    return {
      surface,
      recipientIds: uniqueIds(fact.responsibleRecipientIds),
    };
  }
  return {
    surface,
    recipientIds: uniqueIds(fact.visibleRecipientIds),
  };
}

/**
 * 权限变化时重新裁剪：不在新受众中的投影行应被移除（不泄漏给失去权限者）。
 */
export function shouldRetainProjectionForAudience(input: {
  readonly recipientId: string;
  readonly surface: SystemActivitySurface;
  readonly visibleRecipientIds: readonly string[];
  readonly responsibleRecipientIds: readonly string[];
}): boolean {
  if (input.surface === 'attention_inbox') {
    return input.responsibleRecipientIds.includes(input.recipientId);
  }
  return input.visibleRecipientIds.includes(input.recipientId);
}

// ---------------------------------------------------------------------------
// Projection materialization (pure)
// ---------------------------------------------------------------------------

export interface ProjectSourceFactInput {
  readonly fact: SystemActivitySourceFactV1;
  readonly nextProjectionId: (index: number) => string;
  /** 已有 attention（按 attentionIdentity），用于 revision/reminder 判定。 */
  readonly existingAttentionByIdentity?: ReadonlyMap<string, SystemAttentionItemV1>;
  readonly now: number;
}

export interface ProjectSourceFactResult {
  readonly projections: readonly SystemActivityProjectionItemV1[];
  readonly attentionUpserts: readonly SystemAttentionItemV1[];
  /** 需要关闭的 attention identities（resolved）。 */
  readonly attentionResolutions: readonly {
    readonly attentionIdentity: string;
    readonly recipientId: string;
    readonly resolvedAt: number;
  }[];
}

/**
 * 从已提交 fact 生成分层投影。actorKind 永远是 system；不产生 Message/PI bubble。
 */
export function projectSourceFact(input: ProjectSourceFactInput): ProjectSourceFactResult {
  const { fact, now } = input;
  const level = classifyActivityLevel(fact.factKind);
  const surfaces = surfacesForFact(fact.factKind);
  const projections: SystemActivityProjectionItemV1[] = [];
  const attentionUpserts: SystemAttentionItemV1[] = [];
  const attentionResolutions: {
    readonly attentionIdentity: string;
    readonly recipientId: string;
    readonly resolvedAt: number;
  }[] = [];

  let projIndex = 0;
  for (const surface of surfaces) {
    const audience = resolveAudienceForSurface(fact, surface);
    for (const recipientId of audience.recipientIds) {
      const attentionIdentity = surface === 'attention_inbox'
        ? buildAttentionIdentity(fact, recipientId)
        : undefined;

      const existing = attentionIdentity
        ? input.existingAttentionByIdentity?.get(attentionIdentity)
        : undefined;

      let attentionRevision: number | undefined;
      if (surface === 'attention_inbox' && attentionIdentity) {
        if (RESOLVE_ATTENTION_FACTS.has(fact.factKind) && existing) {
          attentionResolutions.push({
            attentionIdentity,
            recipientId,
            resolvedAt: now,
          });
        } else if (level === 'attention' || level === 'action_required') {
          const upsert = upsertAttentionItem({
            fact,
            recipientId,
            attentionIdentity,
            level: level === 'action_required' ? 'action_required' : 'attention',
            existing,
            now,
          });
          if (upsert) {
            attentionUpserts.push(upsert);
            attentionRevision = upsert.revision;
          }
        }
      }

      // resolve 类事实不在 attention_inbox 新建投影行（由 resolution 关闭）
      if (surface === 'attention_inbox' && RESOLVE_ATTENTION_FACTS.has(fact.factKind)) {
        continue;
      }
      if (surface === 'attention_inbox' && level !== 'attention' && level !== 'action_required') {
        continue;
      }

      projections.push({
        schemaVersion: 1,
        projectionId: input.nextProjectionId(projIndex),
        eventId: fact.eventId,
        surface,
        level: surface === 'attention_inbox' ? level : (
          surface === 'thread_card' && MILESTONE_FACTS.has(fact.factKind)
            ? 'milestone'
            : level === 'action_required' || level === 'attention'
              ? level
              : classifyActivityLevel(fact.factKind)
        ),
        factKind: fact.factKind,
        teamId: fact.teamId,
        taskId: fact.taskId,
        ...(fact.rootTaskId ? { rootTaskId: fact.rootTaskId } : {}),
        ...(fact.channelId ? { channelId: fact.channelId } : {}),
        ...(fact.threadId ? { threadId: fact.threadId } : {}),
        recipientId,
        sequence: fact.sequence,
        revision: 1,
        summary: fact.summary,
        occurredAt: fact.occurredAt,
        actorKind: 'system',
        ...(attentionIdentity ? { attentionIdentity } : {}),
        ...(attentionRevision !== undefined ? { attentionRevision } : {}),
        ...(fact.taskRevision !== undefined ? { taskRevision: fact.taskRevision } : {}),
        ...(fact.deliveryRevision !== undefined ? { deliveryRevision: fact.deliveryRevision } : {}),
        ...(fact.allowedCommands ? { allowedCommands: fact.allowedCommands } : {}),
        ...(fact.confirmationToken ? { confirmationToken: fact.confirmationToken } : {}),
        ...(fact.escalationRevision !== undefined ? { escalationRevision: fact.escalationRevision } : {}),
      });
      projIndex += 1;
    }
  }

  return { projections, attentionUpserts, attentionResolutions };
}

export function buildAttentionIdentity(
  fact: Pick<SystemActivitySourceFactV1, 'taskId' | 'attentionKey' | 'factKind'>,
  recipientId: string,
): string {
  const key = fact.attentionKey ?? fact.factKind;
  return `attn:${fact.taskId}:${key}:${recipientId}`;
}

/**
 * attention revision 规则：
 * - 等级升级为 action_required，或责任人/期限/所需动作/风险实质变化 → 递增 revision + unread
 * - 相同事实重复 reminder → 只更新 lastReminderAt，不递增 revision、不重置 seen
 */
export function upsertAttentionItem(input: {
  readonly fact: SystemActivitySourceFactV1;
  readonly recipientId: string;
  readonly attentionIdentity: string;
  readonly level: 'attention' | 'action_required';
  readonly existing?: SystemAttentionItemV1;
  readonly now: number;
}): SystemAttentionItemV1 | null {
  const { fact, existing, now } = input;

  if (!existing) {
    return {
      schemaVersion: 1,
      attentionIdentity: input.attentionIdentity,
      teamId: fact.teamId,
      recipientId: input.recipientId,
      taskId: fact.taskId,
      ...(fact.rootTaskId ? { rootTaskId: fact.rootTaskId } : {}),
      ...(fact.channelId ? { channelId: fact.channelId } : {}),
      ...(fact.threadId ? { threadId: fact.threadId } : {}),
      level: input.level,
      state: 'open',
      revision: fact.escalationRevision ?? 1,
      sourceEventId: fact.eventId,
      summary: fact.summary,
      unread: true,
      createdAt: now,
      updatedAt: now,
      ...(fact.taskRevision !== undefined ? { taskRevision: fact.taskRevision } : {}),
      ...(fact.deliveryRevision !== undefined ? { deliveryRevision: fact.deliveryRevision } : {}),
      ...(fact.allowedCommands ? { allowedCommands: fact.allowedCommands } : {}),
      ...(fact.confirmationToken ? { confirmationToken: fact.confirmationToken } : {}),
      ...(fact.escalationRevision !== undefined ? { escalationRevision: fact.escalationRevision } : {}),
    };
  }

  if (existing.state !== 'open') {
    // 已关闭的责任不因 reminder 复活；实质新责任应使用新 attentionKey。
    if (isReminderOnly(existing, fact, input.level)) {
      return {
        ...existing,
        lastReminderAt: now,
        updatedAt: now,
      };
    }
    return null;
  }

  if (isReminderOnly(existing, fact, input.level)) {
    return {
      ...existing,
      lastReminderAt: now,
      updatedAt: now,
      sourceEventId: fact.eventId,
    };
  }

  // 实质变化：递增 revision 并重新 unread
  const nextRevision = Math.max(existing.revision + 1, fact.escalationRevision ?? existing.revision + 1);
  return {
    ...existing,
    level: input.level,
    revision: nextRevision,
    sourceEventId: fact.eventId,
    summary: fact.summary,
    unread: true,
    seenAt: undefined,
    updatedAt: now,
    ...(fact.taskRevision !== undefined ? { taskRevision: fact.taskRevision } : {}),
    ...(fact.deliveryRevision !== undefined ? { deliveryRevision: fact.deliveryRevision } : {}),
    ...(fact.allowedCommands ? { allowedCommands: fact.allowedCommands } : {}),
    ...(fact.confirmationToken ? { confirmationToken: fact.confirmationToken } : {}),
    ...(fact.escalationRevision !== undefined ? { escalationRevision: fact.escalationRevision } : {}),
  };
}

function isReminderOnly(
  existing: SystemAttentionItemV1,
  fact: SystemActivitySourceFactV1,
  level: 'attention' | 'action_required',
): boolean {
  if (level === 'action_required' && existing.level !== 'action_required') return false;
  if (fact.summary !== existing.summary) return false;
  if ((fact.allowedCommands ?? []).join('|') !== (existing.allowedCommands ?? []).join('|')) return false;
  if ((fact.confirmationToken ?? '') !== (existing.confirmationToken ?? '')) return false;
  if ((fact.escalationRevision ?? existing.revision) !== existing.revision
    && (fact.escalationRevision ?? 0) > existing.revision) {
    return false;
  }
  if ((fact.deliveryRevision ?? existing.deliveryRevision) !== existing.deliveryRevision
    && fact.deliveryRevision !== undefined
    && existing.deliveryRevision !== undefined
    && fact.deliveryRevision !== existing.deliveryRevision) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// mark-seen：只清当前 revision unread，不结束 attention / action_required
// ---------------------------------------------------------------------------

export type MarkAttentionSeenDecision =
  | {
      readonly kind: 'applied';
      readonly item: SystemAttentionItemV1;
      readonly stillOpen: true;
      readonly unread: false;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

export function evaluateMarkAttentionSeen(input: {
  readonly item: SystemAttentionItemV1;
  readonly recipientId: string;
  readonly expectedRevision: number;
  readonly now: number;
}): MarkAttentionSeenDecision {
  if (input.item.recipientId !== input.recipientId) {
    return { kind: 'rejected', reason: 'recipient_mismatch' };
  }
  if (input.item.revision !== input.expectedRevision) {
    return { kind: 'rejected', reason: 'stale_attention_revision' };
  }
  // 即使已 resolved，seen 也只影响 unread；不改变 state。
  return {
    kind: 'applied',
    stillOpen: true,
    unread: false,
    item: {
      ...input.item,
      unread: false,
      seenAt: input.now,
      updatedAt: input.now,
    },
  };
}

/**
 * 显式：以下信号不能结束 attention / action_required。
 * （与 #928 NON_RESOLVING 对齐；mark-seen / change-feed ack 同理。）
 */
export const NON_RESOLVING_ATTENTION_SIGNALS = [
  'read',
  'seen',
  'dismiss',
  'notice_failed',
  'notice_delayed',
  'notice_duplicate',
  'change_feed_cursor_ack',
  'chat_message',
] as const;

export type NonResolvingAttentionSignal = (typeof NON_RESOLVING_ATTENTION_SIGNALS)[number];

export function evaluateNonResolvingAttentionSignal(
  item: SystemAttentionItemV1,
  signal: NonResolvingAttentionSignal,
): { readonly stillOpen: true; readonly stateUnchanged: true; readonly signal: NonResolvingAttentionSignal } {
  void item;
  return { stillOpen: true, stateUnchanged: true, signal };
}

// ---------------------------------------------------------------------------
// Change-feed cursor ack：只确认 feed delivery
// ---------------------------------------------------------------------------

export interface AckChangeFeedCursorResult {
  readonly ackedPosition: number;
  readonly advancedMessageRead: false;
  readonly advancedAttention: false;
  readonly advancedTaskResponsibility: false;
}

export function evaluateAckChangeFeedCursor(input: {
  readonly cursorPosition: number;
  readonly currentAckedPosition: number;
}): AckChangeFeedCursorResult {
  const ackedPosition = Math.max(input.cursorPosition, input.currentAckedPosition);
  return {
    ackedPosition,
    advancedMessageRead: false,
    advancedAttention: false,
    advancedTaskResponsibility: false,
  };
}

// ---------------------------------------------------------------------------
// Consistency token / projection not-ready
// ---------------------------------------------------------------------------

export type ConsistencyCheckResult =
  | { readonly kind: 'ready' }
  | { readonly kind: 'projection_not_ready'; readonly notReadyStreams: readonly ConsistencyTokenEntryV1[] };

/**
 * 投影水位未满足 minimum token 时明确 not-ready，不能伪装 read-your-writes。
 * currentWatermarks: streamKey(streamKind|streamId) → revision
 */
export function checkMinimumConsistency(input: {
  readonly minimum?: ConsistencyTokenV1;
  readonly currentWatermarks: ReadonlyMap<string, number>;
}): ConsistencyCheckResult {
  if (!input.minimum || input.minimum.entries.length === 0) {
    return { kind: 'ready' };
  }
  const notReady: ConsistencyTokenEntryV1[] = [];
  for (const entry of input.minimum.entries) {
    const key = streamKey(entry.streamKind, entry.streamId);
    const current = input.currentWatermarks.get(key) ?? 0;
    if (current < entry.revision) {
      notReady.push(entry);
    }
  }
  if (notReady.length > 0) {
    return { kind: 'projection_not_ready', notReadyStreams: notReady };
  }
  return { kind: 'ready' };
}

export function streamKey(streamKind: string, streamId: string): string {
  return `${streamKind}|${streamId}`;
}

/**
 * review accept/cancel 必须走具名 command；投影 UI 只暴露绑定 revision 的 command 名。
 */
export function reviewActionsFromAttention(item: SystemAttentionItemV1): readonly string[] {
  if (item.state !== 'open') return [];
  return item.allowedCommands ?? [];
}

// ---------------------------------------------------------------------------
// Thread card assembly
// ---------------------------------------------------------------------------

export function assembleThreadTaskCard(input: {
  readonly taskId: string;
  readonly rootTaskId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly milestones: readonly SystemActivityProjectionItemV1[];
  readonly asOf: number;
  readonly audienceScope: string;
}): {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly rootTaskId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly currentLevel: SystemActivityLevel;
  readonly currentSummary: string;
  readonly milestones: readonly SystemActivityProjectionItemV1[];
  readonly asOf: number;
  readonly audienceScope: string;
} {
  const sorted = [...input.milestones]
    .filter((item) => item.surface === 'thread_card' && item.taskId === input.taskId)
    .sort((a, b) => a.sequence - b.sequence || a.occurredAt - b.occurredAt);
  const latest = sorted[sorted.length - 1];
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    ...(input.rootTaskId ? { rootTaskId: input.rootTaskId } : {}),
    channelId: input.channelId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    currentLevel: latest?.level ?? 'info',
    currentSummary: latest?.summary ?? '',
    milestones: sorted,
    asOf: input.asOf,
    audienceScope: input.audienceScope,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

export function resolveAttentionStateAfterBusinessAction(
  current: SystemAttentionState,
  action: 'resolve' | 'supersede' | 'dismiss_by_policy',
): SystemAttentionState {
  if (current !== 'open') return current;
  if (action === 'resolve') return 'resolved';
  if (action === 'supersede') return 'superseded';
  return 'dismissed_by_policy';
}

import { createHash } from 'node:crypto';
import type { ID, UnixMs } from '../../../../packages/contracts/src/common.js';
import type {
  ConsistencyTokenV1,
  SystemActivityCommandEnvelopeV1,
  SystemActivityCommandName,
  SystemActivityCommandOutputUnionV1,
  SystemActivityCommandResponseV1,
  SystemActivityProjectionItemV1,
  SystemActivityQueryName,
  SystemActivityQueryResponseV1,
  SystemAttentionItemV1,
} from '../../../../packages/contracts/src/system-activity.js';
import {
  SYSTEM_ACTIVITY_COMMAND_SCHEMA_VERSION,
  canonicalizeSystemActivityCommand,
  decodeSystemActivityCursor,
  encodeSystemActivityCursor,
  parseSystemActivityCommandEnvelopeV1,
  parseSystemActivityCommandInputV1,
  parseSystemActivityQueryInputV1,
} from '../../../../packages/contracts/src/system-activity.js';
import {
  assembleThreadTaskCard,
  checkMinimumConsistency,
  evaluateAckChangeFeedCursor,
  evaluateMarkAttentionSeen,
  projectSourceFact,
  shouldRetainProjectionForAudience,
  streamKey,
} from '../../../../packages/domain/src/system-activity-policy.js';
import type {
  SystemActivityCommandReceiptRecord,
  SystemActivityProjectionRecord,
  SystemActivityRepositories,
  SystemAttentionRecord,
} from './system-activity-repositories.js';
import type { SystemActivityUnitOfWork } from './system-activity-unit-of-work.js';

export interface SystemActivityHandlerDeps {
  readonly unitOfWork: SystemActivityUnitOfWork;
  readonly ids: { nextId(): ID };
  readonly clock: { now(): UnixMs };
  readonly teamId: ID;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function computeCommandHash(
  commandName: SystemActivityCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return sha256(canonicalizeSystemActivityCommand(commandName, commandSchemaVersion, input));
}

function parseEnvelope(
  raw: unknown,
  expected: SystemActivityCommandName,
): SystemActivityCommandEnvelopeV1 {
  const envelope = parseSystemActivityCommandEnvelopeV1(raw);
  if (envelope.commandName !== expected) {
    throw new Error('SYSTEM_ACTIVITY_COMMAND_MISMATCH');
  }
  return envelope;
}

function buildCommandResponse(
  commandName: SystemActivityCommandName,
  outcome: SystemActivityCommandResponseV1['outcome'],
  stableCode: string,
  retryDirective: SystemActivityCommandResponseV1['retryDirective'],
  extra: Partial<SystemActivityCommandResponseV1> = {},
): SystemActivityCommandResponseV1 {
  return {
    schemaVersion: 1,
    commandName,
    outcome,
    retryDirective,
    stableCode,
    ...extra,
  };
}

function toReceiptV1(record: SystemActivityCommandReceiptRecord) {
  return {
    schemaVersion: 1 as const,
    receiptId: record.receiptId,
    commandName: record.commandName,
    commandSchemaVersion: record.commandSchemaVersion,
    idempotencyKey: record.idempotencyKey,
    commandHash: record.commandHash,
    outcome: record.outcome,
    committedRevisions: record.committedRevisions,
    eventRefs: record.eventRefs,
    commitTime: record.commitTime,
    resultAvailable: record.resultAvailable,
  };
}

function attentionToV1(row: SystemAttentionRecord): SystemAttentionItemV1 {
  return {
    schemaVersion: 1,
    attentionIdentity: row.attentionIdentity,
    teamId: row.teamId,
    recipientId: row.recipientId,
    taskId: row.taskId,
    ...(row.rootTaskId ? { rootTaskId: row.rootTaskId } : {}),
    ...(row.channelId ? { channelId: row.channelId } : {}),
    ...(row.threadId ? { threadId: row.threadId } : {}),
    level: row.level,
    state: row.state,
    revision: row.revision,
    sourceEventId: row.sourceEventId,
    summary: row.summary,
    unread: row.unread,
    ...(row.seenAt !== null ? { seenAt: row.seenAt } : {}),
    ...(row.lastReminderAt !== null ? { lastReminderAt: row.lastReminderAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.resolvedAt !== null ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.taskRevision !== null ? { taskRevision: row.taskRevision } : {}),
    ...(row.deliveryRevision !== null ? { deliveryRevision: row.deliveryRevision } : {}),
    ...(row.allowedCommandsJson
      ? { allowedCommands: JSON.parse(row.allowedCommandsJson) as string[] }
      : {}),
    ...(row.confirmationToken ? { confirmationToken: row.confirmationToken } : {}),
    ...(row.escalationRevision !== null ? { escalationRevision: row.escalationRevision } : {}),
  };
}

function attentionFromV1(item: SystemAttentionItemV1): SystemAttentionRecord {
  return {
    attentionIdentity: item.attentionIdentity,
    teamId: item.teamId,
    recipientId: item.recipientId,
    taskId: item.taskId,
    rootTaskId: item.rootTaskId ?? null,
    channelId: item.channelId ?? null,
    threadId: item.threadId ?? null,
    level: item.level,
    state: item.state,
    revision: item.revision,
    sourceEventId: item.sourceEventId,
    summary: item.summary,
    unread: item.unread,
    seenAt: item.seenAt ?? null,
    lastReminderAt: item.lastReminderAt ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    resolvedAt: item.resolvedAt ?? null,
    taskRevision: item.taskRevision ?? null,
    deliveryRevision: item.deliveryRevision ?? null,
    allowedCommandsJson: item.allowedCommands ? JSON.stringify(item.allowedCommands) : null,
    confirmationToken: item.confirmationToken ?? null,
    escalationRevision: item.escalationRevision ?? null,
  };
}

function projectionToV1(row: SystemActivityProjectionRecord): SystemActivityProjectionItemV1 {
  return {
    schemaVersion: 1,
    projectionId: row.projectionId,
    eventId: row.eventId,
    surface: row.surface,
    level: row.level,
    factKind: row.factKind,
    teamId: row.teamId,
    taskId: row.taskId,
    ...(row.rootTaskId ? { rootTaskId: row.rootTaskId } : {}),
    ...(row.channelId ? { channelId: row.channelId } : {}),
    ...(row.threadId ? { threadId: row.threadId } : {}),
    recipientId: row.recipientId,
    sequence: row.sequence,
    revision: row.revision,
    summary: row.summary,
    occurredAt: row.occurredAt,
    actorKind: 'system',
    ...(row.attentionIdentity ? { attentionIdentity: row.attentionIdentity } : {}),
    ...(row.attentionRevision !== null ? { attentionRevision: row.attentionRevision } : {}),
    ...(row.taskRevision !== null ? { taskRevision: row.taskRevision } : {}),
    ...(row.deliveryRevision !== null ? { deliveryRevision: row.deliveryRevision } : {}),
    ...(row.allowedCommandsJson
      ? { allowedCommands: JSON.parse(row.allowedCommandsJson) as string[] }
      : {}),
    ...(row.confirmationToken ? { confirmationToken: row.confirmationToken } : {}),
    ...(row.escalationRevision !== null ? { escalationRevision: row.escalationRevision } : {}),
  };
}

function projectionFromItem(
  item: SystemActivityProjectionItemV1,
  feedPosition: number,
  createdAt: UnixMs,
): SystemActivityProjectionRecord {
  return {
    projectionId: item.projectionId,
    eventId: item.eventId,
    surface: item.surface,
    level: item.level,
    factKind: item.factKind,
    teamId: item.teamId,
    taskId: item.taskId,
    rootTaskId: item.rootTaskId ?? null,
    channelId: item.channelId ?? null,
    threadId: item.threadId ?? null,
    recipientId: item.recipientId,
    sequence: item.sequence,
    revision: item.revision,
    summary: item.summary,
    occurredAt: item.occurredAt,
    actorKind: 'system',
    attentionIdentity: item.attentionIdentity ?? null,
    attentionRevision: item.attentionRevision ?? null,
    taskRevision: item.taskRevision ?? null,
    deliveryRevision: item.deliveryRevision ?? null,
    allowedCommandsJson: item.allowedCommands ? JSON.stringify(item.allowedCommands) : null,
    confirmationToken: item.confirmationToken ?? null,
    escalationRevision: item.escalationRevision ?? null,
    feedPosition,
    createdAt,
  };
}

async function loadExistingAttentionMap(
  repos: SystemActivityRepositories,
  identities: readonly string[],
): Promise<Map<string, SystemAttentionItemV1>> {
  const map = new Map<string, SystemAttentionItemV1>();
  for (const id of identities) {
    const row = await repos.attentions.getByIdentity(id);
    if (row) map.set(id, attentionToV1(row));
  }
  return map;
}

async function commitReceipt(
  repos: SystemActivityRepositories,
  input: {
    commandName: SystemActivityCommandName;
    idempotencyKey: string;
    commandHash: string;
    now: UnixMs;
    ids: { nextId(): ID };
    result: SystemActivityCommandOutputUnionV1;
    streamId: ID;
    revision: number;
    sequence: number;
    teamId: ID;
  },
): Promise<SystemActivityCommandReceiptRecord> {
  const receipt: SystemActivityCommandReceiptRecord = {
    receiptId: input.ids.nextId(),
    teamId: input.teamId,
    commandName: input.commandName,
    commandSchemaVersion: SYSTEM_ACTIVITY_COMMAND_SCHEMA_VERSION,
    idempotencyKey: input.idempotencyKey,
    commandHash: input.commandHash,
    outcome: 'applied',
    committedRevisions: [{ streamKind: 'system-activity', streamId: input.streamId, revision: input.revision }],
    eventRefs: [{ streamKind: 'system-activity', streamId: input.streamId, sequence: input.sequence }],
    commitTime: input.now,
    resultAvailable: true,
    resultJson: JSON.stringify(input.result),
  };
  await repos.receipts.create(receipt);
  await repos.receipts.createTombstone({
    id: input.ids.nextId(),
    teamId: input.teamId,
    commandName: input.commandName,
    idempotencyKey: input.idempotencyKey,
    commandHash: input.commandHash,
    receiptId: receipt.receiptId,
    createdAt: input.now,
  });
  return receipt;
}

async function replayOrConflict(
  repos: SystemActivityRepositories,
  commandName: SystemActivityCommandName,
  idempotencyKey: string,
  commandHash: string,
): Promise<SystemActivityCommandResponseV1 | null> {
  const existing = await repos.receipts.getByIdempotencyKey(idempotencyKey);
  if (!existing) return null;
  if (existing.commandHash !== commandHash) {
    return buildCommandResponse(commandName, 'conflict', 'IDEMPOTENCY_CONFLICT', 'user_action', {
      conflictReason: 'idempotency_key_payload_mismatch',
    });
  }
  const result = existing.resultJson
    ? JSON.parse(existing.resultJson) as SystemActivityCommandOutputUnionV1
    : undefined;
  return buildCommandResponse(commandName, 'replayed', 'RECEIPT_REPLAYED', 'none', {
    receipt: toReceiptV1(existing),
    result,
  });
}

async function loadWatermarkMap(
  repos: SystemActivityRepositories,
): Promise<Map<string, number>> {
  const rows = await repos.watermarks.listAll();
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(streamKey(row.streamKind, row.streamId), row.revision);
  }
  return map;
}

async function ensureConsistency(
  repos: SystemActivityRepositories,
  queryName: SystemActivityQueryName,
  minimum: ConsistencyTokenV1 | undefined,
): Promise<SystemActivityQueryResponseV1 | null> {
  if (!minimum) return null;
  const check = checkMinimumConsistency({
    minimum,
    currentWatermarks: await loadWatermarkMap(repos),
  });
  if (check.kind === 'ready') return null;
  return {
    schemaVersion: 1,
    queryName,
    outcome: 'projection_not_ready',
    stableCode: 'PROJECTION_NOT_READY',
    notReadyStreams: check.notReadyStreams,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function handleProjectSourceFact(
  deps: SystemActivityHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<SystemActivityCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'project-source-fact');
  const input = parseSystemActivityCommandInputV1('project-source-fact', rawInput);
  const commandHash = computeCommandHash('project-source-fact', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(repos, 'project-source-fact', envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    // 预加载可能的 attention identities（责任人 × attentionKey）
    const candidateIdentities = input.fact.responsibleRecipientIds.map((recipientId) =>
      `attn:${input.fact.taskId}:${input.fact.attentionKey ?? input.fact.factKind}:${recipientId}`);
    const existingMap = await loadExistingAttentionMap(repos, candidateIdentities);

    const projected = projectSourceFact({
      fact: input.fact,
      nextProjectionId: (i) => deps.ids.nextId() + `:${i}`,
      existingAttentionByIdentity: existingMap,
      now,
    });

    let projectedItemCount = 0;
    const noticeByRecipient = new Map<string, { projectionIds: string[]; attentionIds: string[] }>();

    for (const item of projected.projections) {
      const existing = await repos.projections.getByEventAndRecipient({
        eventId: item.eventId,
        recipientId: item.recipientId,
        surface: item.surface,
      });
      if (existing) {
        // event identity 去重：重复投影不改写事实
        continue;
      }
      const feedPosition = await repos.projections.nextFeedPosition();
      await repos.projections.upsert(projectionFromItem(item, feedPosition, now));
      projectedItemCount += 1;
      const bucket = noticeByRecipient.get(item.recipientId) ?? { projectionIds: [], attentionIds: [] };
      bucket.projectionIds.push(item.projectionId);
      noticeByRecipient.set(item.recipientId, bucket);
    }

    let attentionUpserted = false;
    for (const item of projected.attentionUpserts) {
      await repos.attentions.upsert(attentionFromV1(item));
      attentionUpserted = true;
      const bucket = noticeByRecipient.get(item.recipientId) ?? { projectionIds: [], attentionIds: [] };
      bucket.attentionIds.push(item.attentionIdentity);
      noticeByRecipient.set(item.recipientId, bucket);
    }

    for (const resolution of projected.attentionResolutions) {
      const row = await repos.attentions.getByIdentity(resolution.attentionIdentity);
      if (!row || row.state !== 'open') continue;
      await repos.attentions.upsert({
        ...row,
        state: 'resolved',
        resolvedAt: resolution.resolvedAt,
        updatedAt: resolution.resolvedAt,
        unread: false,
      });
    }

    // 推进投影水位（asOf / consistency token）
    await repos.watermarks.upsert({
      streamKind: input.fact.streamKind,
      streamId: input.fact.streamId,
      revision: Math.max(input.projectionWatermark, input.fact.sequence),
      updatedAt: now,
    });

    // notice 只是可丢失唤醒；事实已在投影/attention 中
    for (const [recipientId, bucket] of noticeByRecipient) {
      const cursor = encodeSystemActivityCursor({
        schemaVersion: 1,
        audienceUserId: recipientId,
        teamId: deps.teamId,
        surface: 'change_feed',
        position: input.projectionWatermark,
        feedEpoch: 0,
      });
      await repos.notices.enqueue({
        noticeId: deps.ids.nextId(),
        teamId: deps.teamId,
        recipientId,
        projectionIdsJson: JSON.stringify(bucket.projectionIds),
        attentionIdentitiesJson: JSON.stringify(bucket.attentionIds),
        cursor,
        issuedAt: now,
        deliveredAt: null,
      });
    }

    const result: SystemActivityCommandOutputUnionV1 = {
      commandName: 'project-source-fact',
      eventId: input.fact.eventId,
      projectedItemCount,
      attentionUpserted,
      projectionWatermark: Math.max(input.projectionWatermark, input.fact.sequence),
    };
    const receipt = await commitReceipt(repos, {
      teamId: deps.teamId,
      commandName: 'project-source-fact',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      streamId: input.fact.taskId,
      revision: input.fact.taskRevision ?? input.fact.sequence,
      sequence: input.fact.sequence,
    });
    return buildCommandResponse('project-source-fact', 'applied', 'PROJECTED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleMarkAttentionSeen(
  deps: SystemActivityHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<SystemActivityCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'mark-attention-seen');
  const input = parseSystemActivityCommandInputV1('mark-attention-seen', rawInput);
  const commandHash = computeCommandHash('mark-attention-seen', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(repos, 'mark-attention-seen', envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const row = await repos.attentions.getByIdentity(input.attentionIdentity);
    if (!row) {
      return buildCommandResponse('mark-attention-seen', 'rejected', 'NOT_FOUND', 'user_action', {
        rejectReason: 'attention_not_found',
      });
    }

    const decision = evaluateMarkAttentionSeen({
      item: attentionToV1(row),
      recipientId: input.recipientId,
      expectedRevision: input.expectedRevision,
      now,
    });
    if (decision.kind === 'rejected') {
      return buildCommandResponse('mark-attention-seen', 'rejected', decision.reason.toUpperCase(), 'user_action', {
        rejectReason: decision.reason,
      });
    }

    await repos.attentions.upsert(attentionFromV1(decision.item));
    const result: SystemActivityCommandOutputUnionV1 = {
      commandName: 'mark-attention-seen',
      attentionIdentity: input.attentionIdentity,
      recipientId: input.recipientId,
      revision: decision.item.revision,
      unread: false,
      stillOpen: true,
    };
    const receipt = await commitReceipt(repos, {
      teamId: deps.teamId,
      commandName: 'mark-attention-seen',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      streamId: input.attentionIdentity,
      revision: decision.item.revision,
      sequence: now,
    });
    return buildCommandResponse('mark-attention-seen', 'applied', 'ATTENTION_SEEN', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleAckChangeFeedCursor(
  deps: SystemActivityHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<SystemActivityCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'ack-change-feed-cursor');
  const input = parseSystemActivityCommandInputV1('ack-change-feed-cursor', rawInput);
  const commandHash = computeCommandHash('ack-change-feed-cursor', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(repos, 'ack-change-feed-cursor', envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const payload = decodeSystemActivityCursor(input.cursor);
    if (payload.audienceUserId !== input.recipientId) {
      return buildCommandResponse('ack-change-feed-cursor', 'rejected', 'CURSOR_AUDIENCE_MISMATCH', 'user_action', {
        rejectReason: 'cursor_audience_mismatch',
      });
    }

    const current = await repos.feedCursors.get(input.recipientId);
    const decision = evaluateAckChangeFeedCursor({
      cursorPosition: payload.position,
      currentAckedPosition: current?.ackedPosition ?? 0,
    });
    await repos.feedCursors.upsert({
      recipientId: input.recipientId,
      teamId: deps.teamId,
      ackedPosition: decision.ackedPosition,
      feedEpoch: payload.feedEpoch,
      updatedAt: now,
    });

    const result: SystemActivityCommandOutputUnionV1 = {
      commandName: 'ack-change-feed-cursor',
      recipientId: input.recipientId,
      ackedPosition: decision.ackedPosition,
      advancedMessageRead: false,
      advancedAttention: false,
      advancedTaskResponsibility: false,
    };
    const receipt = await commitReceipt(repos, {
      teamId: deps.teamId,
      commandName: 'ack-change-feed-cursor',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      streamId: input.recipientId,
      revision: decision.ackedPosition,
      sequence: now,
    });
    return buildCommandResponse('ack-change-feed-cursor', 'applied', 'FEED_CURSOR_ACKED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleRetrimAudience(
  deps: SystemActivityHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<SystemActivityCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'retrim-audience');
  const input = parseSystemActivityCommandInputV1('retrim-audience', rawInput);
  const commandHash = computeCommandHash('retrim-audience', envelope.commandSchemaVersion, input);
  const now = deps.clock.now();

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayOrConflict(repos, 'retrim-audience', envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const rows = await repos.projections.listByTask(input.taskId);
    const toDelete: string[] = [];
    let retained = 0;
    for (const row of rows) {
      const keep = shouldRetainProjectionForAudience({
        recipientId: row.recipientId,
        surface: row.surface,
        visibleRecipientIds: input.visibleRecipientIds,
        responsibleRecipientIds: input.responsibleRecipientIds,
      });
      if (keep) retained += 1;
      else toDelete.push(row.projectionId);
    }
    const removed = await repos.projections.deleteByIds(toDelete);

    // attention 对失去责任的接收者标记 superseded（不删除历史）
    const openAttentions = await repos.attentions.listOpenByTask(input.taskId);
    for (const attn of openAttentions) {
      if (!input.responsibleRecipientIds.includes(attn.recipientId)) {
        await repos.attentions.upsert({
          ...attn,
          state: 'superseded',
          updatedAt: now,
          unread: false,
        });
      }
    }

    const result: SystemActivityCommandOutputUnionV1 = {
      commandName: 'retrim-audience',
      taskId: input.taskId,
      removedProjectionCount: removed,
      retainedProjectionCount: retained,
    };
    const receipt = await commitReceipt(repos, {
      teamId: deps.teamId,
      commandName: 'retrim-audience',
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      now,
      ids: deps.ids,
      result,
      streamId: input.taskId,
      revision: now,
      sequence: now,
    });
    return buildCommandResponse('retrim-audience', 'applied', 'AUDIENCE_RETRIMMED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function handleSystemActivityQuery(
  deps: SystemActivityHandlerDeps,
  queryName: SystemActivityQueryName,
  rawInput: unknown,
): Promise<SystemActivityQueryResponseV1> {
  return deps.unitOfWork.runInTransaction(async (repos) => {
    if (queryName === 'query-task-activity') {
      const input = parseSystemActivityQueryInputV1('query-task-activity', rawInput);
      const notReady = await ensureConsistency(repos, 'query-task-activity', input.minimumConsistency);
      if (notReady) return notReady;
      const afterPosition = input.cursor
        ? decodeSystemActivityCursor(input.cursor).position
        : 0;
      const rows = await repos.projections.listTaskTimeline({
        taskId: input.taskId,
        recipientId: input.recipientId,
        afterPosition,
        limit: input.limit,
      });
      const items = rows.map(projectionToV1);
      const last = rows[rows.length - 1];
      const asOf = last?.occurredAt ?? deps.clock.now();
      const nextCursor = last
        ? encodeSystemActivityCursor({
            schemaVersion: 1,
            audienceUserId: input.recipientId,
            teamId: deps.teamId,
            surface: 'task_timeline',
            position: last.feedPosition,
            feedEpoch: 0,
          })
        : undefined;
      return {
        schemaVersion: 1,
        queryName: 'query-task-activity',
        outcome: 'ready',
        stableCode: 'OK',
        result: {
          queryName: 'query-task-activity',
          taskId: input.taskId,
          recipientId: input.recipientId,
          items,
          audienceScope: `${deps.teamId}:${input.recipientId}`,
          asOf,
          ...(nextCursor ? { nextCursor } : {}),
          schemaVersion: 1,
        },
      };
    }

    if (queryName === 'query-thread-task-card') {
      const input = parseSystemActivityQueryInputV1('query-thread-task-card', rawInput);
      const notReady = await ensureConsistency(repos, 'query-thread-task-card', input.minimumConsistency);
      if (notReady) return notReady;
      const rows = await repos.projections.listThreadCard({
        taskId: input.taskId,
        channelId: input.channelId,
        threadId: input.threadId ?? null,
        recipientId: input.recipientId,
      });
      const milestones = rows.map(projectionToV1);
      const card = assembleThreadTaskCard({
        taskId: input.taskId,
        channelId: input.channelId,
        threadId: input.threadId,
        milestones,
        asOf: milestones[milestones.length - 1]?.occurredAt ?? deps.clock.now(),
        audienceScope: `${deps.teamId}:${input.recipientId}`,
      });
      return {
        schemaVersion: 1,
        queryName: 'query-thread-task-card',
        outcome: 'ready',
        stableCode: 'OK',
        result: {
          queryName: 'query-thread-task-card',
          card: {
            ...card,
            schemaVersion: 1,
          },
          schemaVersion: 1,
        },
      };
    }

    if (queryName === 'query-attention-inbox') {
      const input = parseSystemActivityQueryInputV1('query-attention-inbox', rawInput);
      const notReady = await ensureConsistency(repos, 'query-attention-inbox', input.minimumConsistency);
      if (notReady) return notReady;
      const afterUpdatedAt = input.cursor
        ? decodeSystemActivityCursor(input.cursor).position
        : 0;
      const rows = await repos.attentions.listByRecipient({
        recipientId: input.recipientId,
        onlyUnread: input.onlyUnread,
        afterUpdatedAt,
        limit: input.limit,
      });
      const items = rows.map(attentionToV1);
      const last = rows[rows.length - 1];
      const nextCursor = last
        ? encodeSystemActivityCursor({
            schemaVersion: 1,
            audienceUserId: input.recipientId,
            teamId: deps.teamId,
            surface: 'attention_inbox',
            position: last.updatedAt,
            feedEpoch: 0,
          })
        : undefined;
      return {
        schemaVersion: 1,
        queryName: 'query-attention-inbox',
        outcome: 'ready',
        stableCode: 'OK',
        result: {
          queryName: 'query-attention-inbox',
          recipientId: input.recipientId,
          items,
          audienceScope: `${deps.teamId}:${input.recipientId}`,
          asOf: last?.updatedAt ?? deps.clock.now(),
          ...(nextCursor ? { nextCursor } : {}),
          schemaVersion: 1,
        },
      };
    }

    // pull-change-feed
    const input = parseSystemActivityQueryInputV1('pull-change-feed', rawInput);
    const notReady = await ensureConsistency(repos, 'pull-change-feed', input.minimumConsistency);
    if (notReady) return notReady;
    const afterPosition = input.cursor
      ? decodeSystemActivityCursor(input.cursor).position
      : (await repos.feedCursors.get(input.recipientId))?.ackedPosition ?? 0;
    const rows = await repos.projections.listChangeFeed({
      recipientId: input.recipientId,
      afterPosition,
      limit: input.limit,
    });
    const attentionRows = await repos.attentions.listByRecipient({
      recipientId: input.recipientId,
      afterUpdatedAt: 0,
      limit: input.limit,
    });
    const last = rows[rows.length - 1];
    const nextCursor = last
      ? encodeSystemActivityCursor({
          schemaVersion: 1,
          audienceUserId: input.recipientId,
          teamId: deps.teamId,
          surface: 'change_feed',
          position: last.feedPosition,
          feedEpoch: 0,
        })
      : undefined;
    return {
      schemaVersion: 1,
      queryName: 'pull-change-feed',
      outcome: 'ready',
      stableCode: 'OK',
      result: {
        queryName: 'pull-change-feed',
        recipientId: input.recipientId,
        items: rows.map(projectionToV1),
        attentionItems: attentionRows.map(attentionToV1),
        audienceScope: `${deps.teamId}:${input.recipientId}`,
        asOf: last?.occurredAt ?? deps.clock.now(),
        ...(nextCursor ? { nextCursor } : {}),
        schemaVersion: 1,
      },
    };
  });
}

/** 从 pending notice 构建可投递的 wake 载荷（至少一次；重复/延迟不改变事实）。 */
export async function drainSystemActivityNotices(
  deps: SystemActivityHandlerDeps,
  limit = 50,
): Promise<readonly {
  noticeId: ID;
  recipientId: ID;
  teamId: ID;
  projectionIds: readonly ID[];
  attentionIdentities: readonly ID[];
  cursor: string;
  issuedAt: UnixMs;
}[]> {
  return deps.unitOfWork.runInTransaction(async (repos) => {
    const pending = await repos.notices.listPending(limit);
    const now = deps.clock.now();
    const out = [];
    for (const row of pending) {
      out.push({
        noticeId: row.noticeId,
        recipientId: row.recipientId,
        teamId: row.teamId,
        projectionIds: JSON.parse(row.projectionIdsJson) as ID[],
        attentionIdentities: JSON.parse(row.attentionIdentitiesJson) as ID[],
        cursor: row.cursor,
        issuedAt: row.issuedAt,
      });
      await repos.notices.markDelivered(row.noticeId, now);
    }
    return out;
  });
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CommandReceiptV1,
  ID,
  MessageTargetKind,
  MessageTargetRefV1,
  MessageTracerCommandEnvelopeV1,
  MessageTracerCommandName,
  MessageTracerCommandResponseV1,
  ReadCandidateTokenV1,
  TaskContinuationSourceMarkerV1,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import {
  MESSAGE_TRACER_COMMAND_HASH_VERSION,
  MESSAGE_TRACER_COMMAND_SCHEMA_VERSION,
  MESSAGE_TRACER_ENVELOPE_SCHEMA_VERSION,
  canonicalizeMessageTracerCommand,
  parseMessageTracerCommandEnvelopeV1,
  parseMessageTracerInputV1,
} from '../../../../packages/contracts/src/index.js';
import type {
  ChannelCoordinationTransactionRepositories,
  ChannelCoordinationUnitOfWork,
} from './channel-coordination-unit-of-work.js';
import type { CommandReceiptRecord } from './message-tracer-repositories.js';
import type { MessageRecord } from './repositories.js';
import { shouldCreateMessageRouteAnalysis } from '../../../../packages/domain/src/index.js';

// #921 切片 C：Message tracer command handler（send-message）。
// 这是与 usecases.ts sendMessage 平行的 command 路径：以具名 command + envelope 经 coordination UoW
// 单事务原子提交 Message + InboxItem + receipt + tombstone + outbox；普通聊天不建 coordination Job
// （ADR-0062/0067/0069）。幂等三层（replay/conflict/timeout 查询）、freshness_hold、自身消息不入自身 inbox。

// ---------------------------------------------------------------------------
// ReadCandidate proof（HMAC，仿 usecases.ts session token：signSessionPayload 1284-1291）
// ---------------------------------------------------------------------------

/** 对 ReadCandidate 的身份字段做确定性序列化（键序固定），用于 HMAC proof。 */
function readCandidateProofPayload(token: {
  readonly recipientId: ID;
  readonly target: MessageTargetRefV1;
  readonly targetSeq: number;
  readonly issuedAt: UnixMs;
}): string {
  return JSON.stringify({
    v: MESSAGE_TRACER_COMMAND_HASH_VERSION,
    recipientId: token.recipientId,
    kind: token.target.kind,
    channelId: token.target.channelId,
    threadId: token.target.threadId ?? '',
    targetSeq: token.targetSeq,
    issuedAt: token.issuedAt,
  });
}

function signReadCandidateProof(
  token: { recipientId: ID; target: MessageTargetRefV1; targetSeq: number; issuedAt: UnixMs },
  secret: string,
): string {
  return createHmac('sha256', secret).update(readCandidateProofPayload(token)).digest('base64url');
}

function verifyReadCandidateProof(token: ReadCandidateTokenV1, secret: string): boolean {
  const expected = signReadCandidateProof(token, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(token.proof);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 签发新 ReadCandidate（freshness_hold 时携带，供客户端重新 check-inbox 前 ack 用）。
 * 导出供 check-inbox handler（C-read）与测试复用同一签名实现。
 */
export function issueReadCandidate(input: {
  readonly recipientId: ID;
  readonly target: MessageTargetRefV1;
  readonly targetSeq: number;
  readonly issuedAt: UnixMs;
  readonly secret: string;
}): ReadCandidateTokenV1 {
  const token: Omit<ReadCandidateTokenV1, 'proof'> & { proof?: string } = {
    schemaVersion: 1,
    recipientId: input.recipientId,
    target: input.target,
    targetSeq: input.targetSeq,
    issuedAt: input.issuedAt,
  };
  const proof = signReadCandidateProof(token, input.secret);
  return { ...token, proof } as ReadCandidateTokenV1;
}

/** ReadCandidate 默认最大有效期（1h）；过期 token 必须拒绝（合同要求）。 */
const DEFAULT_READ_CANDIDATE_MAX_AGE_MS = 60 * 60 * 1000;

/** ReadCandidate 是否过期（issuedAt + maxAge < now）。 */
function isReadCandidateExpired(issuedAt: UnixMs, now: UnixMs, maxAgeMs: number): boolean {
  return now - issuedAt > maxAgeMs;
}

/** 计算 command 的 canonical hash（canonicalize 排除 idempotencyKey/clientMessageId/provenance；sha256 在 server）。 */
function computeCommandHash(commandName: MessageTracerCommandName, commandSchemaVersion: number, payload: unknown): string {
  const canonical = canonicalizeMessageTracerCommand(commandName, commandSchemaVersion, payload);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// send-message handler
// ---------------------------------------------------------------------------

export interface SendMessageCommandHandlerDeps {
  readonly unitOfWork: ChannelCoordinationUnitOfWork;
  readonly ids: { nextId(): string };
  /** 时钟（UnixMs）；对齐 channel-coordination-coordinator 的 clock 约定，测试可注入。 */
  readonly clock: { now(): UnixMs };
  /** HMAC 密钥（仿 sessionSecret）。 */
  readonly sessionSecret: string;
  /** ReadCandidate 最大有效期（默认 1h）；过期 token 拒绝。 */
  readonly readCandidateMaxAgeMs?: number;
  /** UoW 提交后的投递钩子（C-send 默认 no-op；C-wire 接真实 socket emit）。 */
  readonly deliverOutbox?: () => void | Promise<void>;
  /** continuation source 必须在写 Message 的同一 UoW 内按提交点事实复验。 */
  readonly validateTaskContinuationSource?: (input: {
    readonly repositories: ChannelCoordinationTransactionRepositories;
    readonly teamId: ID;
    readonly channelId: ID;
    readonly threadId?: ID;
    readonly marker: TaskContinuationSourceMarkerV1;
  }) => Promise<boolean>;
}

export interface SendMessageCommandInput {
  /** 客户端提交的 envelope（exact-key 校验）。 */
  readonly envelope: unknown;
  /** send-message payload（exact-key 校验）。 */
  readonly payload: unknown;
  /** Server 推导的发送者身份（envelope 严禁自报告 authority）。 */
  readonly senderId: ID;
  readonly teamId: ID;
}

export type SendMessageCommandHandler = (input: SendMessageCommandInput) => Promise<MessageTracerCommandResponseV1>;

export function createSendMessageCommandHandler(deps: SendMessageCommandHandlerDeps): SendMessageCommandHandler {
  return async ({ envelope: rawEnvelope, payload: rawPayload, senderId, teamId }) => {
    // 1. exact-key 解析 envelope + payload（拒绝 authority 自报告字段）。
    const envelope = parseMessageTracerCommandEnvelopeV1(rawEnvelope) as MessageTracerCommandEnvelopeV1;
    if (envelope.commandName !== 'send-message') {
      throw new Error(`MESSAGE_TRACER_COMMAND_MISMATCH: expected send-message, got ${envelope.commandName}`);
    }
    const input = parseMessageTracerInputV1('send-message', rawPayload);

    // 2. canonical command hash（canonicalize 排除 idempotencyKey/clientMessageId/provenance；sha256 在 server 算）。
    const commandHash = computeCommandHash('send-message', envelope.commandSchemaVersion, rawPayload);

    const response = await deps.unitOfWork.run(async (tx) => {
      // 3. 幂等查重（事务内 getReceiptByIdempotencyKey + 后续 createReceipt 同事务，防并发双写）。
      const existing = await tx.commandReceipts.getReceiptByIdempotencyKey(envelope.idempotencyKey);
      if (existing) {
        if (existing.commandHash === commandHash) {
          // replay：返回首次 receipt，不重新执行、不写任何事实。
          return replayResponse(existing);
        }
        // conflict：同 key 异 hash，无副作用。
        return conflictResponse('send-message', 'idempotency_conflict');
      }

      if (input.taskContinuationSource) {
        const valid = await deps.validateTaskContinuationSource?.({
          repositories: tx,
          teamId,
          channelId: input.channelId,
          threadId: input.threadId,
          marker: input.taskContinuationSource,
        }) ?? false;
        if (!valid) {
          return rejectedResponse('send-message', 'TASK_CONTINUATION_SOURCE_INVALID', 'reread_then_new_command');
        }
      }

      // 4. freshness 校验（send 携带 Freshness basis）。
      const rejected = await checkFreshnessRequest(
        tx, input, senderId, deps.sessionSecret, deps.clock, deps.readCandidateMaxAgeMs ?? DEFAULT_READ_CANDIDATE_MAX_AGE_MS,
      );
      if (rejected) return rejected;

      // 5. recipient 解析 + 原子提交（不建 coordination Job）。
      const channel = await tx.channels.getById(input.channelId);
      if (!channel) {
        // precondition 失败 → rejected（非 conflict；conflict 专指同 key 异 hash，ADR-0067）。
        return rejectedResponse('send-message', 'CHANNEL_NOT_FOUND', 'reread_then_new_command');
      }
      const targetKind = resolveTargetKind(channel.kind, input.threadId);
      const threadId = input.threadId ?? null;
      // inbox 受众 = 频道全成员 − 发送者（非仅 @mentions；@mentions 只影响 dispatch 路由）。
      const recipients = resolveRecipients(channel.humanMemberIds, channel.agentMemberIds, senderId);

      const now = deps.clock.now();
      const messageId = deps.ids.nextId();
      // targetSeq = 消息在 target 流的位置（跨 recipient 共享：取各 recipient 当前 max + 1）。
      let targetSeq = 0;
      if (recipients.length > 0) {
        const currentMax = await Promise.all(
          recipients.map((recipientId) => tx.inbox.getMaxTargetSeq({ recipientId, channelId: input.channelId, threadId })),
        );
        targetSeq = Math.max(-1, ...currentMax) + 1;
      }

      // 5a. 写 Message（与 legacy MessageRecord 形状一致）。
      const message: MessageRecord = {
        id: messageId,
        teamId,
        channelId: input.channelId,
        threadId: threadId ?? undefined,
        senderKind: input.senderKind,
        senderId,
        body: input.body,
        createdAt: now,
        meta: {
          mentions: input.mentions ? [...input.mentions] : undefined,
          attachments: input.attachmentIds ? [...input.attachmentIds] : undefined,
          clientMessageId: input.clientMessageId,
          taskContinuationSource: input.taskContinuationSource
            ? { ...input.taskContinuationSource }
            : undefined,
        },
      };
      await tx.messages.append(message);

      // 5b. 写每个 recipient 的 InboxItem（自身消息不入自身 inbox：recipients 已排除 senderId）。
      await Promise.all(recipients.map((recipientId) => tx.inbox.insertItem({
        id: deps.ids.nextId(),
        teamId,
        messageId,
        recipientId,
        channelId: input.channelId,
        threadId,
        targetKind,
        targetSeq,
        senderKind: input.senderKind,
        senderId,
        // 该消息是否 @提及该 recipient（频道主线 freshness relevance，#893 §4）。
        mentionsRecipient: input.mentions?.some((m) => m.id === recipientId) ?? false,
        committedAt: now,
        createdAt: now,
      })));

      // 5c. 写 receipt + tombstone（同事务；event/audit 由 receipt+tombstone+message+inbox 兼任，最小原子）。
      const receiptId = deps.ids.nextId();
      const receipt: CommandReceiptV1 = {
        schemaVersion: 1,
        receiptId,
        commandName: 'send-message',
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome: 'applied',
        // delivered 流：本消息的投递修订（per-message delivered stream，首修订）。
        committedRevisions: [{ streamKind: 'delivered', streamId: messageId, revision: 1 }],
        // 最小原子范围不另建 event 表；message+inbox 即已投递事实。
        eventRefs: [],
        commitTime: now,
        resultAvailable: true,
      };
      await tx.commandReceipts.createReceipt({
        receiptId,
        teamId,
        commandName: 'send-message',
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome: 'applied',
        committedRevisions: receipt.committedRevisions,
        eventRefs: receipt.eventRefs,
        resultAvailable: true,
        resultJson: JSON.stringify({
          commandName: 'send-message',
          messageId,
          targetSeq,
          inboxItemRecipientIds: recipients,
        }),
        commitTime: now,
        createdAt: now,
      });
      await tx.commandReceipts.createTombstone({
        id: deps.ids.nextId(),
        teamId,
        commandName: 'send-message',
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        receiptId,
        outcome: 'applied',
        resultAvailable: true,
        createdAt: now,
      });

      // 5d. 原子入队 outbox（与 receipt 同事务；投递是 post-commit）。
      await tx.outbox.enqueue({
        id: deps.ids.nextId(),
        teamId,
        receiptId,
        commandName: 'send-message',
        eventKind: 'message-delivered',
        targetKind,
        channelId: input.channelId,
        threadId,
        audienceRecipientIds: recipients,
        payloadJson: JSON.stringify({
          messageId,
          targetSeq,
          senderKind: input.senderKind,
          senderId,
          channelId: input.channelId,
          threadId,
          targetKind,
        }),
        deliveredAt: null,
        attempts: 0,
        createdAt: now,
      });

      if (shouldCreateMessageRouteAnalysis({
        senderKind: input.senderKind,
        channelKind: channel.kind,
        threadId,
        hasAgentMention: input.mentions?.some((mention) => mention.kind === 'agent') ?? false,
        hasTaskLinkage: input.taskContinuationSource !== undefined,
      })) {
        await tx.routes.create({
          id: deps.ids.nextId(),
          teamId,
          channelId: input.channelId,
          messageId,
          messageRevision: 1,
          status: 'pending',
          attempt: 0,
          nextRetryAt: null,
          routeKind: null,
          intentSource: null,
          riskLevel: null,
          targetAgentIds: [],
          requiredCapabilityIds: [],
          linkedTaskId: null,
          diagnosticCode: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      // 不调用 tx.jobs.create；#1270 用 routes 的可恢复状态替代 legacy coordination job dual-write。

      return buildResponse('send-message', 'applied', 'MESSAGE_APPLIED', 'none', {
        receipt,
        result: {
          commandName: 'send-message',
          messageId,
          targetSeq,
          inboxItemRecipientIds: recipients,
        },
      });
    });

    // 6. UoW 提交后唤醒投递（C-send 默认 no-op；C-wire 接真实 socket emit）。
    if (response.outcome === 'applied') {
      await deps.deliverOutbox?.();
    }
    return response;
  };
}

// ---------------------------------------------------------------------------
// check-inbox handler（candidate-producing read：无副作用，不写 receipt/outbox，不推进 read boundary）
// ---------------------------------------------------------------------------

/** 共享 handler 依赖（check-inbox / ack 复用；与 SendMessageCommandHandlerDeps 同形状）。 */
export interface MessageTracerHandlerDeps {
  readonly unitOfWork: ChannelCoordinationUnitOfWork;
  readonly ids: { nextId(): string };
  readonly clock: { now(): UnixMs };
  readonly sessionSecret: string;
  /** ReadCandidate 最大有效期（默认 1h）；过期 token 拒绝。 */
  readonly readCandidateMaxAgeMs?: number;
}

export interface CheckInboxCommandInput {
  readonly envelope: unknown;
  readonly payload: unknown;
  /** Server 推导的请求者身份（须即 recipient，收件人只查自己的 inbox）。 */
  readonly requesterId: ID;
  readonly teamId: ID;
}

export type CheckInboxCommandHandler = (input: CheckInboxCommandInput) => Promise<MessageTracerCommandResponseV1>;

export function createCheckInboxCommandHandler(deps: MessageTracerHandlerDeps): CheckInboxCommandHandler {
  return async ({ envelope: rawEnvelope, payload: rawPayload, requesterId }) => {
    const envelope = parseMessageTracerCommandEnvelopeV1(rawEnvelope) as MessageTracerCommandEnvelopeV1;
    if (envelope.commandName !== 'check-inbox') {
      throw new Error(`MESSAGE_TRACER_COMMAND_MISMATCH: expected check-inbox, got ${envelope.commandName}`);
    }
    const input = parseMessageTracerInputV1('check-inbox', rawPayload);

    // authority：收件人只能查自己的 inbox。
    if (input.recipientId !== requesterId) {
      return rejectedResponse('check-inbox', 'RECIPIENT_MISMATCH', 'reread_then_new_command');
    }
    const threadId = input.target.threadId ?? null;
    const now = deps.clock.now();
    // check-inbox 是查询：不写 receipt/outbox，不推进 read boundary（ADR-0067 §13）。
    const checked = await deps.unitOfWork.run(async (tx) => {
      const items = await tx.inbox.listItems({
        recipientId: input.recipientId,
        channelId: input.target.channelId,
        threadId,
        afterSeq: input.afterSeq ?? -1,
        limit: input.limit,
      });
      const maxSeq = await tx.inbox.getMaxTargetSeq({
        recipientId: input.recipientId,
        channelId: input.target.channelId,
        threadId,
      });
      return { items, candidateSeq: maxSeq + 1 };
    });

    // targetSeq 为 exclusive「下一未读位置」：maxSeq+1（空 inbox 为 0 = 未读任何）。
    // 这样空 inbox 的 candidate(0) ack 后 readSeq=0，首条消息(seq 0) 仍是未读（0 < 0 为假），不会静默跳过。
    const readCandidate = issueReadCandidate({
      recipientId: input.recipientId,
      target: input.target,
      targetSeq: checked.candidateSeq,
      issuedAt: now,
      secret: deps.sessionSecret,
    });

    return buildResponse('check-inbox', 'applied', 'INBOX_CHECKED', 'none', {
      result: {
        commandName: 'check-inbox',
        recipientId: input.recipientId,
        target: input.target,
        items: checked.items.map((item) => ({
          messageId: item.messageId,
          targetSeq: item.targetSeq,
          senderKind: item.senderKind,
          senderId: item.senderId,
        })),
        readCandidate,
        // audienceScope：该投影的受众边界（inbox 是 recipient 的私有投影）。
        audienceScope: `recipient:${input.recipientId}`,
        asOf: now,
      },
    });
  };
}

// ---------------------------------------------------------------------------
// ack-read-candidate handler（推进权威 Read boundary：幂等、单调；有 receipt）
// ---------------------------------------------------------------------------

export interface AckReadCandidateCommandInput {
  readonly envelope: unknown;
  readonly payload: unknown;
  /** Server 推导的请求者身份（须即 readCandidate.recipientId）。 */
  readonly requesterId: ID;
  readonly teamId: ID;
}

export type AckReadCandidateCommandHandler = (input: AckReadCandidateCommandInput) => Promise<MessageTracerCommandResponseV1>;

export function createAckReadCandidateCommandHandler(deps: MessageTracerHandlerDeps): AckReadCandidateCommandHandler {
  return async ({ envelope: rawEnvelope, payload: rawPayload, requesterId, teamId }) => {
    const envelope = parseMessageTracerCommandEnvelopeV1(rawEnvelope) as MessageTracerCommandEnvelopeV1;
    if (envelope.commandName !== 'ack-read-candidate') {
      throw new Error(`MESSAGE_TRACER_COMMAND_MISMATCH: expected ack-read-candidate, got ${envelope.commandName}`);
    }
    const input = parseMessageTracerInputV1('ack-read-candidate', rawPayload);
    const rc = input.readCandidate;
    const commandHash = computeCommandHash('ack-read-candidate', envelope.commandSchemaVersion, rawPayload);

    return deps.unitOfWork.run(async (tx) => {
      // 幂等查重（同事务；ADR-0067 §18 顺序：幂等查重先于 precondition）。
      const existing = await tx.commandReceipts.getReceiptByIdempotencyKey(envelope.idempotencyKey);
      if (existing) {
        return existing.commandHash === commandHash
          ? replayResponse(existing)
          : conflictResponse('ack-read-candidate', 'idempotency_conflict');
      }

      const now = deps.clock.now();
      // proof 校验 + recipient 绑定 + 过期校验（token 不得伪造/挪用/陈旧）。
      if (!verifyReadCandidateProof(rc, deps.sessionSecret)
        || rc.recipientId !== requesterId
        || isReadCandidateExpired(rc.issuedAt, now, deps.readCandidateMaxAgeMs ?? DEFAULT_READ_CANDIDATE_MAX_AGE_MS)) {
        return rejectedResponse('ack-read-candidate', 'READ_CANDIDATE_REJECTED', 'reread_then_new_command');
      }

      const threadId = rc.target.threadId ?? null;
      const prior = await tx.inbox.getReadBoundary({
        recipientId: rc.recipientId,
        channelId: rc.target.channelId,
        threadId,
      });
      const priorSeq = prior?.readSeq ?? 0;
      // 单调推进（advanceReadBoundary 内部仅 newSeq > 当前才更新；ack 幂等不可回退）。
      const boundary = await tx.inbox.advanceReadBoundary({
        id: deps.ids.nextId(),
        teamId,
        recipientId: rc.recipientId,
        channelId: rc.target.channelId,
        threadId,
        targetKind: rc.target.kind,
        newSeq: rc.targetSeq,
        now,
      });
      // applied = 首次建立 boundary（prior 为 null）或 readSeq 实际推进；否则 no_op。
      const advanced = prior === null || boundary.readSeq > priorSeq;
      const outcome: CommandReceiptV1['outcome'] = advanced ? 'applied' : 'no_op';

      const receiptId = deps.ids.nextId();
      // committedRevisions 仅在 applied 时记录该 read 流的新 revision；no_op 不重复认领既有 revision（§24）。
      const committedRevisions = advanced
        ? [{ streamKind: 'read', streamId: `${rc.recipientId}|${rc.target.channelId}|${threadId ?? ''}`, revision: boundary.readSeq }]
        : [];
      const receipt: CommandReceiptV1 = {
        schemaVersion: 1,
        receiptId,
        commandName: 'ack-read-candidate',
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome,
        committedRevisions,
        eventRefs: [],
        commitTime: now,
        resultAvailable: true,
      };
      await tx.commandReceipts.createReceipt({
        receiptId,
        teamId,
        commandName: 'ack-read-candidate',
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome,
        committedRevisions,
        eventRefs: [],
        resultAvailable: true,
        resultJson: JSON.stringify({
          commandName: 'ack-read-candidate',
          recipientId: rc.recipientId,
          target: rc.target,
          advancedToSeq: boundary.readSeq,
        }),
        commitTime: now,
        createdAt: now,
      });
      await tx.commandReceipts.createTombstone({
        id: deps.ids.nextId(),
        teamId,
        commandName: 'ack-read-candidate',
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        receiptId,
        outcome,
        resultAvailable: true,
        createdAt: now,
      });

      return buildResponse(
        'ack-read-candidate',
        outcome,
        advanced ? 'READ_BOUNDARY_ADVANCED' : 'READ_BOUNDARY_NOOP',
        'none',
        {
          receipt,
          result: {
            commandName: 'ack-read-candidate',
            recipientId: rc.recipientId,
            target: rc.target,
            advancedToSeq: boundary.readSeq,
          },
        },
      );
    });
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function resolveTargetKind(channelKind: string, threadId: ID | undefined): MessageTargetKind {
  if (channelKind === 'direct') return threadId ? 'dm-thread' : 'dm';
  return threadId ? 'thread' : 'channel-mainline';
}

function resolveRecipients(humanMemberIds: readonly ID[], agentMemberIds: readonly ID[], senderId: ID): ID[] {
  const set = new Set<ID>([...humanMemberIds, ...agentMemberIds]);
  set.delete(senderId); // 自身消息不入自身 inbox。
  return Array.from(set);
}

/** #893 §4：basis 消息是否自发送者上次 check（readCandidate.issuedAt）后被编辑或删除。 */
async function isBasisMessageChanged(
  tx: Parameters<Parameters<ChannelCoordinationUnitOfWork['run']>[0]>[0],
  basisMessageId: ID | undefined,
  sinceIssuedAt: UnixMs,
): Promise<boolean> {
  if (!basisMessageId) return false;
  const basis = await tx.messages.getById(basisMessageId);
  // 删除（getById 返回 null，如 deleteMessage 软删）或编辑（updatedAt > 上次 check）→ basis 已变。
  return basis == null || (basis.updatedAt != null && basis.updatedAt > sinceIssuedAt);
}

/** #893 §4：basis Task 是否自发送者上次 check（readCandidate.issuedAt）后被编辑或删除。 */
async function isBasisTaskChanged(
  tx: Parameters<Parameters<ChannelCoordinationUnitOfWork['run']>[0]>[0],
  basisTaskId: ID | undefined,
  sinceIssuedAt: UnixMs,
): Promise<boolean> {
  if (!basisTaskId) return false;
  const basis = await tx.tasks.getById(basisTaskId);
  // 删除（getById 返回 null）或编辑（updatedAt > 上次 check）→ basis 已变。
  // TaskDto.updatedAt 虽必填，仍保留 != null 守卫以与 isBasisMessageChanged 对称、防御未来可选化。
  return basis == null || (basis.updatedAt != null && basis.updatedAt > sinceIssuedAt);
}

/** freshness 校验：仅 readCandidate gate（#893 §4 relevance）。返回非 null = hold/reject。 */
async function checkFreshnessRequest(
  tx: Parameters<Parameters<ChannelCoordinationUnitOfWork['run']>[0]>[0],
  input: { readonly channelId: ID; readonly threadId?: ID; readonly freshnessBasis: { readonly readCandidate?: ReadCandidateTokenV1; readonly target: MessageTargetRefV1; readonly basisMessageId?: ID; readonly basisTaskId?: ID } },
  senderId: ID,
  secret: string,
  clock: { now(): UnixMs },
  maxAgeMs: number,
): Promise<MessageTracerCommandResponseV1 | null> {
  const rc = input.freshnessBasis.readCandidate;
  if (!rc) return null; // 无 readCandidate → 无 freshness 约束，继续提交。

  const now = clock.now();
  // proof 校验 + recipient/target 绑定 + 过期（禁止伪造/挪用/陈旧 token）。
  if (!verifyReadCandidateProof(rc, secret)
    || rc.recipientId !== senderId
    || rc.target.channelId !== input.channelId
    || (rc.target.threadId ?? null) !== (input.threadId ?? null)
    || isReadCandidateExpired(rc.issuedAt, now, maxAgeMs)) {
    return rejectedResponse('send-message', 'READ_CANDIDATE_REJECTED', 'reread_then_new_command');
  }

  // 发送者作为该 target 接收方的当前水位（发送者对来自他人的消息有 inbox 行）。
  const currentMax = await tx.inbox.getMaxTargetSeq({
    recipientId: senderId,
    channelId: input.channelId,
    threadId: input.threadId ?? null,
  });
  // #893 §4：依据消息被编辑或删除始终 relevant——即使无未读，basis 变了也 hold。
  if (await isBasisMessageChanged(tx, input.freshnessBasis.basisMessageId, rc.issuedAt)) {
    const newReadCandidate = issueReadCandidate({
      recipientId: senderId, target: rc.target, targetSeq: currentMax + 1, issuedAt: now, secret,
    });
    return buildResponse('send-message', 'freshness_hold', 'FRESHNESS_HOLD', 'same_key', {
      heldTarget: input.freshnessBasis.target, heldReason: 'basis_message_changed', newReadCandidate,
    });
  }
  // #893 §4：basis Task 被编辑或删除同样始终 relevant——即使无未读，basis 变了也 hold。
  if (await isBasisTaskChanged(tx, input.freshnessBasis.basisTaskId, rc.issuedAt)) {
    const newReadCandidate = issueReadCandidate({
      recipientId: senderId, target: rc.target, targetSeq: currentMax + 1, issuedAt: now, secret,
    });
    return buildResponse('send-message', 'freshness_hold', 'FRESHNESS_HOLD', 'same_key', {
      heldTarget: input.freshnessBasis.target, heldReason: 'basis_task_changed', newReadCandidate,
    });
  }
  // exclusive 语义：currentMax >= targetSeq 表示有新消息到达（target_seq >= 下一未读位）。
  if (currentMax < rc.targetSeq) return null; // 无未读 → fresh，继续提交。

  // #893 §4 relevance：DM/DM-thread/Thread 中同 target 所有新非本人消息 relevant；
  // 频道主线仅 @提及（及后续的 basis Message/Task）relevant，普通无关聊天不阻塞。
  const relevant = rc.target.kind === 'channel-mainline'
    ? await tx.inbox.hasUnreadMention({
        recipientId: senderId, channelId: input.channelId, threadId: input.threadId ?? null, sinceSeq: rc.targetSeq,
      })
    : true;
  if (!relevant) return null; // 主线无关未读 → 不阻塞

  // 存在未读相关消息 → freshness_hold（不写 Message/inbox/outbox，不推进 read boundary）。
  const newReadCandidate = issueReadCandidate({
    recipientId: senderId,
    target: rc.target,
    targetSeq: currentMax + 1, // 推到当前水位的「下一未读」
    issuedAt: now,
    secret,
  });
  return buildResponse('send-message', 'freshness_hold', 'FRESHNESS_HOLD', 'same_key', {
    heldTarget: input.freshnessBasis.target,
    heldReason: 'unread_relevant_message',
    newReadCandidate,
  });
}

/** 统一构造 response 骨架（commandName 显式传入，防字段漂移）。 */
function buildResponse(
  commandName: MessageTracerCommandName,
  outcome: MessageTracerCommandResponseV1['outcome'],
  stableCode: string,
  retryDirective: MessageTracerCommandResponseV1['retryDirective'],
  extra: Partial<MessageTracerCommandResponseV1> = {},
): MessageTracerCommandResponseV1 {
  return {
    schemaVersion: MESSAGE_TRACER_ENVELOPE_SCHEMA_VERSION,
    commandName,
    outcome,
    retryDirective,
    stableCode,
    ...extra,
  };
}

/** 把存储记录投影为 wire 契约 CommandReceiptV1（exact-key 白名单不含 teamId/resultJson/createdAt，
 *  泄漏这些会让客户端/中继重新解析时 MESSAGE_TRACER_PAYLOAD_INVALID，ADR-0067 要 tombstone 投影）。 */
function toReceiptV1(record: CommandReceiptRecord): CommandReceiptV1 {
  return {
    schemaVersion: 1,
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

function replayResponse(receipt: CommandReceiptRecord): MessageTracerCommandResponseV1 {
  return buildResponse(receipt.commandName, 'replayed', 'MESSAGE_REPLAYED', 'none', { receipt: toReceiptV1(receipt) });
}

function conflictResponse(commandName: MessageTracerCommandName, reason: string): MessageTracerCommandResponseV1 {
  return buildResponse(commandName, 'conflict', 'IDEMPOTENCY_CONFLICT', 'reread_then_new_command', { conflictReason: reason });
}

function rejectedResponse(
  commandName: MessageTracerCommandName,
  stableCode: string,
  retryDirective: MessageTracerCommandResponseV1['retryDirective'],
): MessageTracerCommandResponseV1 {
  return buildResponse(commandName, 'rejected', stableCode, retryDirective);
}

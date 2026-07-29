import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CommandReceiptV1,
  ID,
  MessageTargetKind,
  MessageTargetRefV1,
  MessageTracerCommandEnvelopeV1,
  MessageTracerCommandResponseV1,
  ReadCandidateTokenV1,
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
import type { ChannelCoordinationUnitOfWork } from './channel-coordination-unit-of-work.js';
import type { CommandReceiptRecord } from './message-tracer-repositories.js';
import type { MessageRecord } from './repositories.js';

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
  /** UoW 提交后的投递钩子（C-send 默认 no-op；C-wire 接真实 socket emit）。 */
  readonly deliverOutbox?: () => void | Promise<void>;
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
    const canonical = canonicalizeMessageTracerCommand('send-message', envelope.commandSchemaVersion, rawPayload);
    const commandHash = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;

    const response = await deps.unitOfWork.run(async (tx) => {
      // 3. 幂等查重（事务内 getReceiptByIdempotencyKey + 后续 createReceipt 同事务，防并发双写）。
      const existing = await tx.commandReceipts.getReceiptByIdempotencyKey(envelope.idempotencyKey);
      if (existing) {
        if (existing.commandHash === commandHash) {
          // replay：返回首次 receipt，不重新执行、不写任何事实。
          return replayResponse(existing);
        }
        // conflict：同 key 异 hash，无副作用。
        return conflictResponse('idempotency_conflict');
      }

      // 4. freshness 校验（send 携带 Freshness basis）。
      const rejected = await checkFreshnessRequest(tx, input, senderId, deps.sessionSecret, deps.clock);
      if (rejected) return rejected;

      // 5. recipient 解析 + 原子提交（不建 coordination Job）。
      const channel = await tx.channels.getById(input.channelId);
      if (!channel) {
        // precondition 失败 → rejected（非 conflict；conflict 专指同 key 异 hash，ADR-0067）。
        return rejectedResponse('CHANNEL_NOT_FOUND', 'reread_then_new_command');
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

      // 不调用 tx.jobs.create —— 与 usecases.ts modern 路径的核心区别（ADR-0069 场景 1）。

      return buildResponse('applied', 'MESSAGE_APPLIED', 'none', {
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

/** freshness 校验：仅 readCandidate gate（basisMessageId/basisTaskId 暂作信息性，最小 C-send）。返回非 null = hold/reject。 */
async function checkFreshnessRequest(
  tx: Parameters<Parameters<ChannelCoordinationUnitOfWork['run']>[0]>[0],
  input: { readonly channelId: ID; readonly threadId?: ID; readonly freshnessBasis: { readonly readCandidate?: ReadCandidateTokenV1; readonly target: MessageTargetRefV1 } },
  senderId: ID,
  secret: string,
  clock: { now(): UnixMs },
): Promise<MessageTracerCommandResponseV1 | null> {
  const rc = input.freshnessBasis.readCandidate;
  if (!rc) return null; // 无 readCandidate → 无 freshness 约束，继续提交。

  // proof 校验 + recipient/target 绑定（禁止跨 recipient/target 伪造或挪用 token）。
  if (!verifyReadCandidateProof(rc, secret)
    || rc.recipientId !== senderId
    || rc.target.channelId !== input.channelId
    || (rc.target.threadId ?? null) !== (input.threadId ?? null)) {
    return rejectedResponse('READ_CANDIDATE_REJECTED', 'reread_then_new_command');
  }

  // 发送者作为该 target 接收方的当前水位（发送者对来自他人的消息有 inbox 行）。
  const currentMax = await tx.inbox.getMaxTargetSeq({
    recipientId: senderId,
    channelId: input.channelId,
    threadId: input.threadId ?? null,
  });
  if (rc.targetSeq < currentMax) {
    // 存在未读相关消息 → freshness_hold（不写 Message/inbox/outbox，不推进 read boundary）。
    const newReadCandidate = issueReadCandidate({
      recipientId: senderId,
      target: rc.target,
      targetSeq: currentMax,
      issuedAt: clock.now(),
      secret,
    });
    return buildResponse('freshness_hold', 'FRESHNESS_HOLD', 'same_key', {
      heldTarget: input.freshnessBasis.target,
      heldReason: 'unread_messages_on_target',
      newReadCandidate,
    });
  }
  return null;
}

/** 统一构造 response 骨架（防 schemaVersion/commandName 字段漂移）。 */
function buildResponse(
  outcome: MessageTracerCommandResponseV1['outcome'],
  stableCode: string,
  retryDirective: MessageTracerCommandResponseV1['retryDirective'],
  extra: Partial<MessageTracerCommandResponseV1> = {},
): MessageTracerCommandResponseV1 {
  return {
    schemaVersion: MESSAGE_TRACER_ENVELOPE_SCHEMA_VERSION,
    commandName: 'send-message',
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
  return buildResponse('replayed', 'MESSAGE_REPLAYED', 'none', { receipt: toReceiptV1(receipt) });
}

function conflictResponse(reason: string): MessageTracerCommandResponseV1 {
  return buildResponse('conflict', 'IDEMPOTENCY_CONFLICT', 'reread_then_new_command', { conflictReason: reason });
}

function rejectedResponse(stableCode: string, retryDirective: MessageTracerCommandResponseV1['retryDirective']): MessageTracerCommandResponseV1 {
  return buildResponse('rejected', stableCode, retryDirective);
}

import type {
  ChannelCoordinationDecisionRecord,
  ChannelCoordinationJobRecord,
  ChannelCoordinationJobStatus,
  ID,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import type { ArtifactRepository, ChannelRepository, MessageRepository, TaskRepository } from './repositories.js';
import type { ProjectReferenceSetRepository } from './project-repositories.js';
import type { MessageInboxRepository, CommandReceiptRepository, MessageTracerOutboxRepository } from './message-tracer-repositories.js';

export interface ChannelCoordinationJobRepository {
  create(input: ChannelCoordinationJobRecord): Promise<ChannelCoordinationJobRecord>;
  getById(jobId: string): Promise<ChannelCoordinationJobRecord | null>;
  getByMessageId(messageId: string): Promise<ChannelCoordinationJobRecord | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<ChannelCoordinationJobRecord | null>;
  listByChannel(channelId: string, limit: number): Promise<ChannelCoordinationJobRecord[]>;
  /**
   * #931 cutover：列出 Team 内仍 open 的 legacy jobs（pending/retry_wait/running）。
   * 不按 nextRetryAt / lease 过滤——cutover 必须处置全部存量。
   */
  listOpenByTeam(teamId: string): Promise<ChannelCoordinationJobRecord[]>;
  /** 取可消费的 Job：pending、到期 retry_wait 或超过 processing lease 的 running，按 createdAt 升序。 */
  listRunnable(input: { now: number; runningBefore: number; limit: number }): Promise<ChannelCoordinationJobRecord[]>;
  /** 原子抢占一个可消费 Job；并发 worker 只有一个能成功。成功时 attempt 自增并进入 running。 */
  claimForProcessing(input: {
    jobId: string;
    now: number;
    runningBefore: number;
  }): Promise<ChannelCoordinationJobRecord | null>;
  updateState(input: {
    jobId: string;
    status: ChannelCoordinationJobStatus;
    attempt: number;
    nextRetryAt: number | null;
    updatedAt: number;
  }): Promise<ChannelCoordinationJobRecord | null>;
}

export interface ChannelCoordinationDecisionRepository {
  create(input: ChannelCoordinationDecisionRecord): Promise<ChannelCoordinationDecisionRecord>;
  getByJobId(jobId: string): Promise<ChannelCoordinationDecisionRecord | null>;
  getByMessageId(messageId: string): Promise<ChannelCoordinationDecisionRecord | null>;
  /**
   * 标记该 Task 关联的上一个「仍有效」的 resolved Decision 为被 byDecisionId 取代（AC#8 superseded）。
   * 返回被取代的 Decision，或 null（无前置 Decision / 已被取代）。
   */
  markSupersededByLinkedTask(input: {
    taskId: ID;
    byDecisionId: ID;
    now: UnixMs;
  }): Promise<ChannelCoordinationDecisionRecord | null>;
  /** #699 US 29：聚合 token usage。since 为可选时间戳（ms），不传则全量。 */
  aggregateUsage(since?: number): Promise<{ totalInputTokens: number; totalOutputTokens: number; totalDecisions: number }>;
}

export interface ChannelCoordinationRepositories {
  readonly jobs: ChannelCoordinationJobRepository;
  readonly decisions: ChannelCoordinationDecisionRepository;
}

export interface ChannelCoordinationTransactionRepositories extends ChannelCoordinationRepositories {
  readonly messages: MessageRepository;
  readonly artifacts: ArtifactRepository;
  readonly tasks: TaskRepository;
  readonly channels: ChannelRepository;
  readonly projectReferenceSets: ProjectReferenceSetRepository;
  /**
   * #921 Message tracer 持久化：inbox 投影、Read boundary、receipt 与 tombstone。
   * 与 messages 共享同一 channel coordination UoW 单 teamDb 事务，使 send-message 能原子提交
   * Message + InboxItem + receipt + tombstone（新路径默认不触碰 legacy 入口，见 #921 切片 D）。
   */
  readonly inbox: MessageInboxRepository;
  readonly commandReceipts: CommandReceiptRepository;
  /** #921 持久 outbox：send-message 单事务原子入队的投递事件（见 MessageTracerOutboxRepository）。 */
  readonly outbox: MessageTracerOutboxRepository;
}

export interface ChannelCoordinationUnitOfWork {
  run<T>(operation: (repositories: ChannelCoordinationTransactionRepositories) => Promise<T>): Promise<T>;
}

export function createChannelCoordinationUnitOfWork(
  transact: <T>(operation: (repositories: ChannelCoordinationTransactionRepositories) => Promise<T>) => Promise<T>,
): ChannelCoordinationUnitOfWork {
  return { run: transact };
}

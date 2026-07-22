import type {
  ChannelCoordinationDecisionRecord,
  ChannelCoordinationJobRecord,
  ChannelCoordinationJobStatus,
  ID,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import type { ArtifactRepository, MessageRepository, TaskRepository } from './repositories.js';

export interface ChannelCoordinationJobRepository {
  create(input: ChannelCoordinationJobRecord): Promise<ChannelCoordinationJobRecord>;
  getById(jobId: string): Promise<ChannelCoordinationJobRecord | null>;
  getByMessageId(messageId: string): Promise<ChannelCoordinationJobRecord | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<ChannelCoordinationJobRecord | null>;
  listByChannel(channelId: string, limit: number): Promise<ChannelCoordinationJobRecord[]>;
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
}

export interface ChannelCoordinationRepositories {
  readonly jobs: ChannelCoordinationJobRepository;
  readonly decisions: ChannelCoordinationDecisionRepository;
}

export interface ChannelCoordinationTransactionRepositories extends ChannelCoordinationRepositories {
  readonly messages: MessageRepository;
  readonly artifacts: ArtifactRepository;
  readonly tasks: TaskRepository;
}

export interface ChannelCoordinationUnitOfWork {
  run<T>(operation: (repositories: ChannelCoordinationTransactionRepositories) => Promise<T>): Promise<T>;
}

export function createChannelCoordinationUnitOfWork(
  transact: <T>(operation: (repositories: ChannelCoordinationTransactionRepositories) => Promise<T>) => Promise<T>,
): ChannelCoordinationUnitOfWork {
  return { run: transact };
}

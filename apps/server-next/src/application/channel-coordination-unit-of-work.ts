import type {
  ChannelCoordinationDecisionRecord,
  ChannelCoordinationJobRecord,
  ChannelCoordinationJobStatus,
} from '../../../../packages/contracts/src/index.js';
import type { ArtifactRepository, MessageRepository } from './repositories.js';

export interface ChannelCoordinationJobRepository {
  create(input: ChannelCoordinationJobRecord): Promise<ChannelCoordinationJobRecord>;
  getById(jobId: string): Promise<ChannelCoordinationJobRecord | null>;
  getByMessageId(messageId: string): Promise<ChannelCoordinationJobRecord | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<ChannelCoordinationJobRecord | null>;
  listByChannel(channelId: string, limit: number): Promise<ChannelCoordinationJobRecord[]>;
  /** 取可消费的 Job：status IN('pending','retry_wait') 且到期（nextRetryAt 为空或 <= now），按 createdAt 升序。 */
  listRunnable(input: { now: number; limit: number }): Promise<ChannelCoordinationJobRecord[]>;
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
}

export interface ChannelCoordinationRepositories {
  readonly jobs: ChannelCoordinationJobRepository;
  readonly decisions: ChannelCoordinationDecisionRepository;
}

export interface ChannelCoordinationTransactionRepositories extends ChannelCoordinationRepositories {
  readonly messages: MessageRepository;
  readonly artifacts: ArtifactRepository;
}

export interface ChannelCoordinationUnitOfWork {
  run<T>(operation: (repositories: ChannelCoordinationTransactionRepositories) => Promise<T>): Promise<T>;
}

export function createChannelCoordinationUnitOfWork(
  transact: <T>(operation: (repositories: ChannelCoordinationTransactionRepositories) => Promise<T>) => Promise<T>,
): ChannelCoordinationUnitOfWork {
  return { run: transact };
}

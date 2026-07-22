import type {
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
  updateState(input: {
    jobId: string;
    status: ChannelCoordinationJobStatus;
    attempt: number;
    nextRetryAt: number | null;
    updatedAt: number;
  }): Promise<ChannelCoordinationJobRecord | null>;
}

export interface ChannelCoordinationRepositories {
  readonly jobs: ChannelCoordinationJobRepository;
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

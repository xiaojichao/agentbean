import type { ManagementRepositories } from './management-repositories.js';
import type {
  ArtifactRepository,
  ChannelRepository,
  DispatchRepository,
  MessageRepository,
  TaskRepository,
  WorkspaceRunRepository,
} from './repositories.js';
import type { TaskCoordinationRepositories } from './task-coordination-repositories.js';
import type { PromotionGateRepositories } from './promotion-gate-repositories.js';

export interface TaskCoordinationTransactionRepositories {
  readonly tasks: TaskRepository;
  readonly messages: MessageRepository;
  readonly artifacts: ArtifactRepository;
  readonly workspaceRuns: WorkspaceRunRepository;
  readonly dispatches: DispatchRepository;
  readonly coordination: TaskCoordinationRepositories;
  readonly management: ManagementRepositories;
  readonly channels: ChannelRepository;
  /**
   * #922 Promotion gate：source relation / scheduling intent / outbox / receipt。
   * 挂在本 UoW 上，使 `promote-to-task` 能在单 teamDb 事务里原子提交
   * root Task + source relation + run + event + audit + scheduling + outbox + receipt/tombstone（#894 §10）。
   */
  readonly promotion: PromotionGateRepositories;
}

export interface TaskCoordinationUnitOfWork {
  run<T>(
    operation: (repositories: TaskCoordinationTransactionRepositories) => Promise<T>,
  ): Promise<T>;
}

export function createTaskCoordinationUnitOfWork(
  transact: <T>(
    operation: (repositories: TaskCoordinationTransactionRepositories) => Promise<T>,
  ) => Promise<T>,
): TaskCoordinationUnitOfWork {
  return { run: transact };
}

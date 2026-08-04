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
import type { TaskLifecycleRepositories } from './task-lifecycle-repositories.js';
import type { PackageReviewRepository } from './package-review-repositories.js';
import type { ChannelProjectRepository } from './project-repositories.js';
import type { OutputPackageRepository } from './output-package-repositories.js';
import type { WorkspacePublishStagingRepository } from './repositories.js';

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
  /**
   * #926 Task lifecycle：具名 transition command receipt / tombstone。
   * 挂在本 UoW 上，使每个 lifecycle command 能在单 teamDb 事务里原子提交
   * status change + event + receipt + tombstone。
   */
  readonly lifecycle: TaskLifecycleRepositories;
  /**
   * #1061 Package review：文件审核/验收/最终化命令的 review 落库与幂等 receipt。
   * 挂在本 UoW 上，使 review-and-reject-delivery 组合命令能在单事务里原子提交
   * review 记录 + Task transition(AC6)。
   */
  readonly packageReviews: PackageReviewRepository;
  /**
   * #1066 archive gate：package 级待审核 delivery / 未收敛 projection / publish
   * staging 收口在归档事务内复验与迁移，随事务原子提交。
   */
  readonly outputPackages: OutputPackageRepository;
  readonly workspacePublishStagings: WorkspacePublishStagingRepository;
  readonly channelProjects: ChannelProjectRepository;
  /** #1066 AC12：归档审计记录随事务原子写入。 */
  readonly channelArchives: import('./repositories.js').ChannelArchiveRepository;
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

import type { ManagementRepositories } from './management-repositories.js';
import type { TaskRepository } from './repositories.js';
import type { TaskCoordinationRepositories } from './task-coordination-repositories.js';

export interface TaskCoordinationTransactionRepositories {
  readonly tasks: TaskRepository;
  readonly coordination: TaskCoordinationRepositories;
  readonly management: ManagementRepositories;
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

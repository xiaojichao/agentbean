import type { ManagementRepositories } from './management-repositories.js';
import type { MemoryRepositories } from './memory-repositories.js';

export interface ManagementMemoryTransactionRepositories {
  readonly management: ManagementRepositories;
  readonly memory: MemoryRepositories;
}

export interface ManagementMemoryUnitOfWork {
  run<T>(
    operation: (repositories: ManagementMemoryTransactionRepositories) => Promise<T>,
  ): Promise<T>;
}

export function createManagementMemoryUnitOfWork(
  transact: <T>(
    operation: (repositories: ManagementMemoryTransactionRepositories) => Promise<T>,
  ) => Promise<T>,
): ManagementMemoryUnitOfWork {
  return { run: transact };
}

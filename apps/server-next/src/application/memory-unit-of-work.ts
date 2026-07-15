import type { MemoryRepositories } from './memory-repositories.js';

export interface MemoryUnitOfWork {
  run<T>(operation: (repositories: MemoryRepositories) => Promise<T>): Promise<T>;
}

export function createMemoryUnitOfWork(
  transact: <T>(operation: (repositories: MemoryRepositories) => Promise<T>) => Promise<T>,
): MemoryUnitOfWork {
  return { run: transact };
}

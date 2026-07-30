import type { SystemActivityRepositories } from './system-activity-repositories.js';

/**
 * #929 事务边界：snapshot → work → commit/rollback。
 * memory 实现用于测试；生产可换 SQLite 事务。
 */
export interface SystemActivityUnitOfWork {
  runInTransaction<T>(work: (repos: SystemActivityRepositories) => Promise<T>): Promise<T>;
}

export function createMemorySystemActivityUnitOfWork(input: {
  readonly repos: SystemActivityRepositories;
  readonly snapshot: () => unknown;
  readonly restore: (snap: unknown) => void;
}): SystemActivityUnitOfWork {
  return {
    async runInTransaction(work) {
      const snap = input.snapshot();
      try {
        return await work(input.repos);
      } catch (error) {
        input.restore(snap);
        throw error;
      }
    },
  };
}

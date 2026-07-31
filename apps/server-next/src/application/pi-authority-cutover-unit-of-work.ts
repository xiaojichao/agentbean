import type { PiAuthorityCutoverRepositories } from './pi-authority-cutover-repositories.js';

/**
 * #930 事务边界：snapshot → work → commit/rollback。
 * memory 实现用于测试；生产可换 SQLite 事务。
 */
export interface PiAuthorityCutoverUnitOfWork {
  runInTransaction<T>(work: (repos: PiAuthorityCutoverRepositories) => Promise<T>): Promise<T>;
}

export function createMemoryPiAuthorityCutoverUnitOfWork(input: {
  readonly repos: PiAuthorityCutoverRepositories;
  readonly snapshot: () => unknown;
  readonly restore: (snap: unknown) => void;
}): PiAuthorityCutoverUnitOfWork {
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

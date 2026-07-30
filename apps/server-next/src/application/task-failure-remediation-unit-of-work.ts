import type { TaskFailureRemediationRepositories } from './task-failure-remediation-repositories.js';

/**
 * #928 事务边界：snapshot → work → commit/rollback。
 * memory 实现用于测试；生产接线可换 SQLite 事务。
 */
export interface TaskFailureRemediationUnitOfWork {
  runInTransaction<T>(work: (repos: TaskFailureRemediationRepositories) => Promise<T>): Promise<T>;
}

export function createMemoryTaskFailureRemediationUnitOfWork(input: {
  readonly repos: TaskFailureRemediationRepositories;
  readonly snapshot: () => unknown;
  readonly restore: (snap: unknown) => void;
}): TaskFailureRemediationUnitOfWork {
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

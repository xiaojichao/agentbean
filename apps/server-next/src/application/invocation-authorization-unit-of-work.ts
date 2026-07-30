import type { ManagementRepositories } from './management-repositories.js';
import type { InvocationAuthorizationRepositories } from './invocation-authorization-repositories.js';

/**
 * #927 Invocation Authorization 事务边界。
 *
 * 组合 ManagementRepositories（管理运行、lease）与 InvocationAuthorizationRepositories
 * （authorization facts、action approvals、effect outcomes、receipt/tombstone），
 * 使 handler 能在一个事务中原子提交 authorization 决策 + receipt。
 *
 * 模式：与 TaskCoordinationUnitOfWork（compose management + promotion repos）相同。
 */
export interface InvocationAuthorizationTransactionRepositories {
  readonly management: ManagementRepositories;
  readonly authorization: InvocationAuthorizationRepositories;
}

export interface InvocationAuthorizationUnitOfWork {
  run<T>(operation: (repositories: InvocationAuthorizationTransactionRepositories) => Promise<T>): Promise<T>;
}

export function createInvocationAuthorizationUnitOfWork(
  transact: <T>(operation: (repositories: InvocationAuthorizationTransactionRepositories) => Promise<T>) => Promise<T>,
): InvocationAuthorizationUnitOfWork {
  return { run: transact };
}

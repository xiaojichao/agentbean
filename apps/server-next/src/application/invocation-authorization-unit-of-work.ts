import type { ManagementRepositories } from './management-repositories.js';
import type { InvocationAuthorizationRepositories } from './invocation-authorization-repositories.js';
export interface InvocationAuthorizationTransactionRepositories { readonly management: ManagementRepositories; readonly authorization: InvocationAuthorizationRepositories; }
export interface InvocationAuthorizationUnitOfWork { run<T>(operation: (repositories: InvocationAuthorizationTransactionRepositories) => Promise<T>): Promise<T>; }
export function createInvocationAuthorizationUnitOfWork(transact: <T>(operation: (repositories: InvocationAuthorizationTransactionRepositories) => Promise<T>) => Promise<T>): InvocationAuthorizationUnitOfWork { return { run: transact }; }

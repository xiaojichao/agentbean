/**
 * Serialize asynchronous transactions that share one mutable persistence boundary.
 * A rejected transaction must not break the queue for later operations.
 */
export function serializeTransactions<TRepositories>(
  transact: <T>(operation: (repositories: TRepositories) => Promise<T>) => Promise<T>,
): <T>(operation: (repositories: TRepositories) => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: (repositories: TRepositories) => Promise<T>) => {
    const result = tail.then(
      () => transact(operation),
      () => transact(operation),
    );
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

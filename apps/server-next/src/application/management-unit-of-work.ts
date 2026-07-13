import type { ManagementEventV1, ManagementRunDto } from '../../../../packages/contracts/src/index.js';
import type {
  ManagedRequestReservationRecord,
  ManagementEventRecord,
  ManagementRepositories,
} from './management-repositories.js';

export interface CreateManagementRunInput {
  readonly reservation: ManagedRequestReservationRecord;
  readonly run: ManagementRunDto;
  readonly firstEvent: ManagementEventV1;
  readonly firstEventPayloadHash: string;
}

export interface ManagementUnitOfWork {
  run<T>(operation: (repositories: ManagementRepositories) => Promise<T>): Promise<T>;
  createRun(input: CreateManagementRunInput): Promise<{
    reservation: ManagedRequestReservationRecord;
    run: ManagementRunDto;
    firstEvent: ManagementEventRecord;
  }>;
}

export function createManagementUnitOfWork(
  transact: <T>(operation: (repositories: ManagementRepositories) => Promise<T>) => Promise<T>,
): ManagementUnitOfWork {
  return {
    run: transact,
    createRun(input) {
      return transact(async (repositories) => {
        const reservation = await repositories.reservations.create(input.reservation);
        const run = await repositories.runs.create(input.run);
        const firstEvent = await repositories.events.append({
          event: input.firstEvent,
          payloadHash: input.firstEventPayloadHash,
        });
        return { reservation, run, firstEvent };
      });
    },
  };
}

export function serializeManagementTransactions(
  transact: <T>(operation: (repositories: ManagementRepositories) => Promise<T>) => Promise<T>,
): <T>(operation: (repositories: ManagementRepositories) => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: (repositories: ManagementRepositories) => Promise<T>) => {
    const result = tail.then(
      () => transact(operation),
      () => transact(operation),
    );
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

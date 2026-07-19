import type { ManagementEventV1 } from '../../../../packages/contracts/src/index.js';
import type {
  ManagedRequestReservationRecord,
  ManagementEventRecord,
  ManagementRepositories,
  ManagementRunRecord,
} from './management-repositories.js';
import { serializeTransactions } from './transaction-serialization.js';

export interface CreateManagementRunInput {
  readonly reservation: ManagedRequestReservationRecord;
  readonly run: ManagementRunRecord;
  readonly firstEvent: ManagementEventV1;
  readonly firstEventPayloadHash: string;
}

export interface ManagementUnitOfWork {
  run<T>(operation: (repositories: ManagementRepositories) => Promise<T>): Promise<T>;
  createRun(input: CreateManagementRunInput): Promise<{
    reservation: ManagedRequestReservationRecord;
    run: ManagementRunRecord;
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
  return serializeTransactions(transact);
}

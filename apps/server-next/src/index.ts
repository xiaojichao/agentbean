import { createServerNextUseCases, type ServerNextUseCases } from './application/usecases.js';
import { createInMemoryRepositories } from './infra/memory/repositories.js';

export * from './application/repositories.js';
export * from './application/memory-repositories.js';
export * from './application/memory-unit-of-work.js';
export * from './application/management-memory-unit-of-work.js';
export * from './application/channel-coordination-unit-of-work.js';
export * from './application/collaborative-memory-search-service.js';
export * from './application/usecases.js';
export * from './infra/memory/repositories.js';
export * from './dev-server.js';

export interface CreateInMemoryServerNextInput {
  now?: () => number;
  ids?: () => string;
  joinCodes?: () => string;
  deviceInviteCodes?: () => string;
}

export function createInMemoryServerNext(input: CreateInMemoryServerNextInput = {}): ServerNextUseCases {
  let fallbackId = 0;
  const repositories = createInMemoryRepositories();
  return createServerNextUseCases({
    repositories,
    clock: { now: input.now ?? (() => Date.now()) },
    ids: {
      nextId:
        input.ids ??
        (() => {
          fallbackId += 1;
          return `id-${fallbackId}`;
        }),
    },
    messageIngestionMode: 'legacy',
    ...(input.joinCodes ? { joinCodes: { nextCode: input.joinCodes } } : {}),
    ...(input.deviceInviteCodes ? { deviceInviteCodes: { nextCode: input.deviceInviteCodes } } : {}),
  });
}

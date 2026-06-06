import { createServerNextUseCases, type ServerNextUseCases } from './application/usecases';
import { createInMemoryRepositories } from './infra/memory/repositories';

export * from './application/repositories';
export * from './application/usecases';
export * from './infra/memory/repositories';
export * from './dev-server';

export interface CreateInMemoryServerNextInput {
  now?: () => number;
  ids?: () => string;
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
  });
}

import type {
  PiProviderCardRecord,
  PiProviderCardRevisionRecord,
  PiProviderCredentialRecord,
  PiProviderRepositories,
  PiProviderRevisionTestRecord,
  PiProviderUnitOfWork,
} from '../../application/pi-provider-repositories.js';
import { serializeTransactions } from '../../application/transaction-serialization.js';

export interface InMemoryPiProviderPersistence {
  readonly repositories: PiProviderRepositories;
  readonly unitOfWork: PiProviderUnitOfWork;
  failNextWriteWith?: Error | null;
}

export function createInMemoryPiProviderPersistence(): InMemoryPiProviderPersistence {
  const credentials = new Map<string, PiProviderCredentialRecord>();
  const revisions = new Map<string, PiProviderCardRevisionRecord>();
  const cards = new Map<string, PiProviderCardRecord>();
  const tests = new Map<string, PiProviderRevisionTestRecord>();
  let failNextWriteWith: Error | null = null;

  function maybeFail(): void {
    if (failNextWriteWith) {
      const error = failNextWriteWith;
      failNextWriteWith = null;
      throw error;
    }
  }

  const repositories: PiProviderRepositories = {
    credentials: {
      async create(input) {
        maybeFail();
        credentials.set(input.id, input);
        return input;
      },
      async getById(id) {
        return credentials.get(id) ?? null;
      },
      async update(input) {
        maybeFail();
        credentials.set(input.id, input);
        return input;
      },
    },
    revisions: {
      async create(input) {
        maybeFail();
        revisions.set(input.id, input);
        return input;
      },
      async getById(id) {
        return revisions.get(id) ?? null;
      },
      async listByCard(cardId) {
        return Array.from(revisions.values())
          .filter((revision) => revision.cardId === cardId)
          .sort((left, right) => right.createdAt - left.createdAt);
      },
    },
    cards: {
      async create(input) {
        maybeFail();
        cards.set(input.id, {
          ...input,
          modelCandidates: [...(input.modelCandidates ?? [])],
        });
        return input;
      },
      async getById(id) {
        return cards.get(id) ?? null;
      },
      async list() {
        return Array.from(cards.values()).sort((left, right) => right.updatedAt - left.updatedAt);
      },
      async update(input) {
        maybeFail();
        cards.set(input.id, {
          ...input,
          modelCandidates: [...(input.modelCandidates ?? [])],
        });
        return input;
      },
    },
    tests: {
      async create(input) {
        maybeFail();
        tests.set(input.id, input);
        return input;
      },
      async getLatestByCard(cardId) {
        return Array.from(tests.values())
          .filter((item) => item.cardId === cardId)
          .sort((left, right) => right.testedAt - left.testedAt)[0] ?? null;
      },
      async getLatestPassingForSummary(cardId, configSummary) {
        return Array.from(tests.values())
          .filter((item) =>
            item.cardId === cardId
            && item.configSummary === configSummary
            && item.status === 'passed')
          .sort((left, right) => right.testedAt - left.testedAt)[0] ?? null;
      },
    },
  };

  const runTransaction = serializeTransactions<PiProviderRepositories>(
    async (operation) => {
      const credSnap = new Map(credentials);
      const revSnap = new Map(revisions);
      const cardSnap = new Map(cards);
      const testSnap = new Map(tests);
      try {
        return await operation(repositories);
      } catch (error) {
        credentials.clear();
        for (const [id, value] of credSnap) credentials.set(id, value);
        revisions.clear();
        for (const [id, value] of revSnap) revisions.set(id, value);
        cards.clear();
        for (const [id, value] of cardSnap) cards.set(id, value);
        tests.clear();
        for (const [id, value] of testSnap) tests.set(id, value);
        throw error;
      }
    },
  );
  const unitOfWork: PiProviderUnitOfWork = { run: runTransaction };

  return {
    repositories,
    unitOfWork,
    get failNextWriteWith() {
      return failNextWriteWith;
    },
    set failNextWriteWith(value) {
      failNextWriteWith = value ?? null;
    },
  };
}

export function createInMemoryPiProviderRepositories(): PiProviderRepositories {
  return createInMemoryPiProviderPersistence().repositories;
}

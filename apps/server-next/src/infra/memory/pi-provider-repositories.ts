import type {
  PiProviderCardRecord,
  PiProviderCardRevisionRecord,
  PiProviderCredentialRecord,
  PiProviderRepositories,
  PiProviderUnitOfWork,
} from '../../application/pi-provider-repositories.js';
import { serializeTransactions } from '../../application/transaction-serialization.js';

export interface InMemoryPiProviderPersistence {
  readonly repositories: PiProviderRepositories;
  readonly unitOfWork: PiProviderUnitOfWork;
  /** 测试用：在 unitOfWork 事务中注入失败。 */
  failNextWriteWith?: Error | null;
}

export function createInMemoryPiProviderPersistence(): InMemoryPiProviderPersistence {
  const credentials = new Map<string, PiProviderCredentialRecord>();
  const revisions = new Map<string, PiProviderCardRevisionRecord>();
  const cards = new Map<string, PiProviderCardRecord>();
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
        cards.set(input.id, input);
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
        cards.set(input.id, input);
        return input;
      },
    },
  };

  const runTransaction = serializeTransactions<PiProviderRepositories>(
    async (operation) => {
      const credSnap = new Map(credentials);
      const revSnap = new Map(revisions);
      const cardSnap = new Map(cards);
      try {
        return await operation(repositories);
      } catch (error) {
        credentials.clear();
        for (const [id, value] of credSnap) credentials.set(id, value);
        revisions.clear();
        for (const [id, value] of revSnap) revisions.set(id, value);
        cards.clear();
        for (const [id, value] of cardSnap) cards.set(id, value);
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

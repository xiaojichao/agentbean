import type {
  PiProviderCardRecord,
  PiProviderCardRevisionRecord,
  PiProviderCredentialRecord,
  PiProviderRepositories,
} from '../../application/pi-provider-repositories.js';

export function createInMemoryPiProviderRepositories(): PiProviderRepositories {
  const credentials = new Map<string, PiProviderCredentialRecord>();
  const revisions = new Map<string, PiProviderCardRevisionRecord>();
  const cards = new Map<string, PiProviderCardRecord>();

  return {
    credentials: {
      async create(input) {
        credentials.set(input.id, input);
        return input;
      },
      async getById(id) {
        return credentials.get(id) ?? null;
      },
      async update(input) {
        credentials.set(input.id, input);
        return input;
      },
    },
    revisions: {
      async create(input) {
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
        cards.set(input.id, input);
        return input;
      },
    },
  };
}

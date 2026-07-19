import type {
  PiProviderConfigDto,
  PiProviderPreset,
  PiProviderRevisionStatus,
} from '../../../../packages/contracts/src/index.js';

export interface PiProviderCredentialRecord {
  readonly id: string;
  readonly keyVersion: number;
  readonly encryptedPayload: string;
  readonly fingerprint: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PiProviderCardRevisionRecord {
  readonly id: string;
  readonly cardId: string;
  readonly status: PiProviderRevisionStatus;
  readonly displayName: string;
  readonly notes: string | null;
  readonly consoleUrl: string | null;
  readonly config: PiProviderConfigDto;
  readonly createdBy: string;
  readonly createdAt: number;
}

/** Card 身份与 revision 指针；元数据只存在于 revision。 */
export interface PiProviderCardRecord {
  readonly id: string;
  readonly preset: PiProviderPreset;
  readonly credentialRef: string;
  readonly draftRevisionId: string | null;
  readonly publishedRevisionId: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PiProviderRepositories {
  readonly credentials: {
    create(input: PiProviderCredentialRecord): Promise<PiProviderCredentialRecord>;
    getById(id: string): Promise<PiProviderCredentialRecord | null>;
    update(input: PiProviderCredentialRecord): Promise<PiProviderCredentialRecord>;
  };
  readonly revisions: {
    create(input: PiProviderCardRevisionRecord): Promise<PiProviderCardRevisionRecord>;
    getById(id: string): Promise<PiProviderCardRevisionRecord | null>;
    listByCard(cardId: string): Promise<PiProviderCardRevisionRecord[]>;
  };
  readonly cards: {
    create(input: PiProviderCardRecord): Promise<PiProviderCardRecord>;
    getById(id: string): Promise<PiProviderCardRecord | null>;
    list(): Promise<PiProviderCardRecord[]>;
    update(input: PiProviderCardRecord): Promise<PiProviderCardRecord>;
  };
}

export interface PiProviderUnitOfWork {
  run<T>(operation: (repositories: PiProviderRepositories) => Promise<T>): Promise<T>;
}

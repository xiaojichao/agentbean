import {
  makeFailure,
  makeSuccess,
  type Ack,
  type CopyPiProviderCardInput,
  type CreatePiProviderCardInput,
  type ListPiProviderCardsResult,
  type ListPiProviderPresetsResult,
  type PiProviderCardDto,
  type PiProviderCardRevisionDto,
  type PiProviderConfigDto,
  type UpdatePiProviderCardInput,
} from '../../../../packages/contracts/src/index.js';
import {
  getPiProviderPreset,
  isPiProviderPreset,
  listPiProviderPresets,
  normalizePiProviderConfig,
  shouldCreateDraftRevisionForEdit,
  validatePiProviderApiKey,
  validatePiProviderConsoleUrl,
  validatePiProviderDisplayName,
  validatePiProviderNotes,
} from '../../../../packages/domain/src/index.js';
import type { PiProviderRepositories } from './pi-provider-repositories.js';
import type { UserRecord } from './repositories.js';
import {
  encryptPiProviderApiKey,
  resolvePiSecretKey,
  serializeEncryptedSecret,
  type PiSecretKeyResolution,
} from './pi-provider-secret.js';

export interface PiProviderServiceDependencies {
  readonly repositories: PiProviderRepositories;
  readonly users: {
    getById(id: string): Promise<UserRecord | null>;
  };
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly resolveSecretKey?: () => PiSecretKeyResolution;
}

export function createPiProviderService(deps: PiProviderServiceDependencies) {
  const resolveKey = deps.resolveSecretKey ?? (() => resolvePiSecretKey());

  async function requireSystemAdmin(userId: string): Promise<{ ok: true; user: UserRecord } | Ack<{}>> {
    const user = await deps.users.getById(userId);
    if (!user) return makeFailure('UNAUTHENTICATED', 'User not found');
    if (user.role !== 'admin') {
      return makeFailure('FORBIDDEN', 'Only system administrators can manage PI Provider Supply');
    }
    return { ok: true, user };
  }

  function requireEncryptionKey():
    | { ok: true; key: Buffer }
    | { ok: false; failure: Ack<{}> } {
    const resolved = resolveKey();
    if (!resolved.ok) {
      return {
        ok: false,
        failure: makeFailure(
          'INTERNAL_ERROR',
          'PI secret key is not configured (AGENTBEAN_PI_SECRET_KEY)',
        ),
      };
    }
    return { ok: true, key: resolved.key };
  }

  async function toCardDto(cardId: string): Promise<PiProviderCardDto | null> {
    const card = await deps.repositories.cards.getById(cardId);
    if (!card) return null;
    const credential = await deps.repositories.credentials.getById(card.credentialRef);
    const draft = card.draftRevisionId
      ? await deps.repositories.revisions.getById(card.draftRevisionId)
      : null;
    const published = card.publishedRevisionId
      ? await deps.repositories.revisions.getById(card.publishedRevisionId)
      : null;
    return {
      id: card.id,
      displayName: card.displayName,
      preset: card.preset,
      notes: card.notes,
      consoleUrl: card.consoleUrl,
      credential: {
        credentialRef: card.credentialRef,
        configured: Boolean(credential),
        ...(credential?.fingerprint ? { fingerprint: credential.fingerprint } : {}),
      },
      draftRevision: draft ? toRevisionDto(draft) : null,
      publishedRevision: published ? toRevisionDto(published) : null,
      createdBy: card.createdBy,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    };
  }

  function toRevisionDto(revision: {
    id: string;
    cardId: string;
    status: 'draft' | 'published';
    config: PiProviderConfigDto;
    createdBy: string;
    createdAt: number;
  }): PiProviderCardRevisionDto {
    return {
      id: revision.id,
      cardId: revision.cardId,
      status: revision.status,
      config: revision.config,
      createdBy: revision.createdBy,
      createdAt: revision.createdAt,
    };
  }

  function assertSafeAckPayload(payload: unknown): void {
    const text = JSON.stringify(payload);
    // Fail closed if any response accidentally includes ciphertext or raw key material markers.
    if (/encrypted_payload|ciphertext|apiKeyCiphertext|"apiKey"\s*:/i.test(text)) {
      throw new Error('PI provider response leaked secret material');
    }
  }

  return {
    async listPresets(input: { userId: string }): Promise<Ack<ListPiProviderPresetsResult>> {
      const admin = await requireSystemAdmin(input.userId);
      if (!admin.ok) return admin;
      const presets = listPiProviderPresets().map((preset) => ({
        preset: preset.preset,
        displayName: preset.displayName,
        defaultBaseUrl: preset.defaultBaseUrl,
        defaultEndpointMode: preset.defaultEndpointMode,
        defaultConsoleUrl: preset.defaultConsoleUrl,
        protocol: preset.protocol,
      }));
      const result = makeSuccess({ presets });
      assertSafeAckPayload(result);
      return result;
    },

    async listCards(input: { userId: string }): Promise<Ack<ListPiProviderCardsResult>> {
      const admin = await requireSystemAdmin(input.userId);
      if (!admin.ok) return admin;
      const cards = await deps.repositories.cards.list();
      const dtos: PiProviderCardDto[] = [];
      for (const card of cards) {
        const dto = await toCardDto(card.id);
        if (dto) dtos.push(dto);
      }
      const result = makeSuccess({ cards: dtos });
      assertSafeAckPayload(result);
      return result;
    },

    async getCard(input: { userId: string; cardId: string }): Promise<Ack<{ card: PiProviderCardDto }>> {
      const admin = await requireSystemAdmin(input.userId);
      if (!admin.ok) return admin;
      const card = await toCardDto(input.cardId);
      if (!card) return makeFailure('NOT_FOUND', 'Provider card not found');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    async createCard(
      input: CreatePiProviderCardInput & { userId: string },
    ): Promise<Ack<{ card: PiProviderCardDto }>> {
      const admin = await requireSystemAdmin(input.userId);
      if (!admin.ok) return admin;
      if (!isPiProviderPreset(input.preset)) {
        return makeFailure('VALIDATION_ERROR', 'Invalid provider preset');
      }
      const displayName = validatePiProviderDisplayName(input.displayName);
      if (!displayName.ok) return makeFailure('VALIDATION_ERROR', displayName.message);
      const notes = validatePiProviderNotes(input.notes);
      if (!notes.ok) return makeFailure('VALIDATION_ERROR', notes.message);
      const consoleUrl = validatePiProviderConsoleUrl(input.consoleUrl);
      if (!consoleUrl.ok) return makeFailure('VALIDATION_ERROR', consoleUrl.message);
      const apiKey = validatePiProviderApiKey(input.apiKey, { required: true });
      if (!apiKey.ok) return makeFailure('VALIDATION_ERROR', apiKey.message);

      const configResult = normalizePiProviderConfig({
        baseUrl: input.baseUrl,
        endpointMode: input.endpointMode,
        modelId: input.modelId,
        timeoutMs: input.timeoutMs,
        maxOutputTokens: input.maxOutputTokens,
        compatibilityParams: input.compatibilityParams ?? {},
        advancedConfig: input.advancedConfig,
      });
      if (!configResult.ok) return makeFailure('VALIDATION_ERROR', configResult.message);

      const key = requireEncryptionKey();
      if (!key.ok) return key.failure as Ack<{ card: PiProviderCardDto }>;

      const now = deps.clock.now();
      const cardId = deps.ids.nextId();
      const credentialId = deps.ids.nextId();
      const revisionId = deps.ids.nextId();
      const encrypted = encryptPiProviderApiKey(apiKey.value!, key.key);

      await deps.repositories.credentials.create({
        id: credentialId,
        keyVersion: encrypted.keyVersion,
        encryptedPayload: serializeEncryptedSecret(encrypted),
        fingerprint: encrypted.fingerprint,
        createdAt: now,
        updatedAt: now,
      });

      await deps.repositories.cards.create({
        id: cardId,
        displayName: displayName.value,
        preset: input.preset,
        notes: notes.value,
        consoleUrl: consoleUrl.value,
        credentialRef: credentialId,
        draftRevisionId: revisionId,
        publishedRevisionId: null,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      });

      await deps.repositories.revisions.create({
        id: revisionId,
        cardId,
        status: 'draft',
        config: toConfigDto(configResult.config),
        createdBy: input.userId,
        createdAt: now,
      });

      const card = await toCardDto(cardId);
      if (!card) return makeFailure('INTERNAL_ERROR', 'Failed to load created card');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    async updateCard(
      input: UpdatePiProviderCardInput & { userId: string },
    ): Promise<Ack<{ card: PiProviderCardDto }>> {
      const admin = await requireSystemAdmin(input.userId);
      if (!admin.ok) return admin;

      const existing = await deps.repositories.cards.getById(input.cardId);
      if (!existing) return makeFailure('NOT_FOUND', 'Provider card not found');

      const displayName = validatePiProviderDisplayName(input.displayName);
      if (!displayName.ok) return makeFailure('VALIDATION_ERROR', displayName.message);
      const notes = validatePiProviderNotes(input.notes);
      if (!notes.ok) return makeFailure('VALIDATION_ERROR', notes.message);
      const consoleUrl = validatePiProviderConsoleUrl(input.consoleUrl);
      if (!consoleUrl.ok) return makeFailure('VALIDATION_ERROR', consoleUrl.message);
      const apiKey = validatePiProviderApiKey(input.apiKey, { required: false });
      if (!apiKey.ok) return makeFailure('VALIDATION_ERROR', apiKey.message);

      const configResult = normalizePiProviderConfig({
        baseUrl: input.baseUrl,
        endpointMode: input.endpointMode,
        modelId: input.modelId,
        timeoutMs: input.timeoutMs,
        maxOutputTokens: input.maxOutputTokens,
        compatibilityParams: input.compatibilityParams ?? {},
        advancedConfig: input.advancedConfig,
      });
      if (!configResult.ok) return makeFailure('VALIDATION_ERROR', configResult.message);

      if (apiKey.value) {
        const key = requireEncryptionKey();
        if (!key.ok) return key.failure as Ack<{ card: PiProviderCardDto }>;
        const credential = await deps.repositories.credentials.getById(existing.credentialRef);
        if (!credential) return makeFailure('INTERNAL_ERROR', 'Credential reference missing');
        const encrypted = encryptPiProviderApiKey(apiKey.value, key.key);
        const nowForCred = deps.clock.now();
        await deps.repositories.credentials.update({
          id: credential.id,
          keyVersion: encrypted.keyVersion,
          encryptedPayload: serializeEncryptedSecret(encrypted),
          fingerprint: encrypted.fingerprint,
          createdAt: credential.createdAt,
          updatedAt: nowForCred,
        });
      }

      // Published revisions are immutable: every edit creates a new draft revision.
      void shouldCreateDraftRevisionForEdit({
        hasPublishedRevision: Boolean(existing.publishedRevisionId),
        hasDraftRevision: Boolean(existing.draftRevisionId),
      });

      const now = deps.clock.now();
      const revisionId = deps.ids.nextId();
      await deps.repositories.revisions.create({
        id: revisionId,
        cardId: existing.id,
        status: 'draft',
        config: toConfigDto(configResult.config),
        createdBy: input.userId,
        createdAt: now,
      });

      await deps.repositories.cards.update({
        ...existing,
        displayName: displayName.value,
        notes: notes.value,
        consoleUrl: consoleUrl.value,
        draftRevisionId: revisionId,
        // publishedRevisionId unchanged
        updatedAt: now,
      });

      const card = await toCardDto(existing.id);
      if (!card) return makeFailure('INTERNAL_ERROR', 'Failed to load updated card');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    async copyCard(
      input: CopyPiProviderCardInput & { userId: string },
    ): Promise<Ack<{ card: PiProviderCardDto }>> {
      const admin = await requireSystemAdmin(input.userId);
      if (!admin.ok) return admin;

      const source = await deps.repositories.cards.getById(input.sourceCardId);
      if (!source) return makeFailure('NOT_FOUND', 'Source provider card not found');

      const sourceRevisionId = source.draftRevisionId ?? source.publishedRevisionId;
      if (!sourceRevisionId) {
        return makeFailure('VALIDATION_ERROR', 'Source card has no configuration revision');
      }
      const sourceRevision = await deps.repositories.revisions.getById(sourceRevisionId);
      if (!sourceRevision) {
        return makeFailure('INTERNAL_ERROR', 'Source revision missing');
      }
      const sourceCredential = await deps.repositories.credentials.getById(source.credentialRef);
      if (!sourceCredential) {
        return makeFailure('INTERNAL_ERROR', 'Source credential missing');
      }

      const displayName = validatePiProviderDisplayName(
        input.displayName ?? `${source.displayName} (copy)`,
      );
      if (!displayName.ok) return makeFailure('VALIDATION_ERROR', displayName.message);

      const now = deps.clock.now();
      const cardId = deps.ids.nextId();
      const credentialId = deps.ids.nextId();
      const revisionId = deps.ids.nextId();

      // Copy ciphertext under a new credentialRef; never re-expose plaintext.
      await deps.repositories.credentials.create({
        id: credentialId,
        keyVersion: sourceCredential.keyVersion,
        encryptedPayload: sourceCredential.encryptedPayload,
        fingerprint: sourceCredential.fingerprint,
        createdAt: now,
        updatedAt: now,
      });

      await deps.repositories.cards.create({
        id: cardId,
        displayName: displayName.value,
        preset: source.preset,
        notes: source.notes,
        consoleUrl: source.consoleUrl,
        credentialRef: credentialId,
        draftRevisionId: revisionId,
        publishedRevisionId: null,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      });

      await deps.repositories.revisions.create({
        id: revisionId,
        cardId,
        status: 'draft',
        config: sourceRevision.config,
        createdBy: input.userId,
        createdAt: now,
      });

      const card = await toCardDto(cardId);
      if (!card) return makeFailure('INTERNAL_ERROR', 'Failed to load copied card');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    /** Test helper: mark current draft as published without model tests (#703 owns real publish). */
    async __testMarkDraftPublished(input: { cardId: string }): Promise<void> {
      const card = await deps.repositories.cards.getById(input.cardId);
      if (!card?.draftRevisionId) return;
      const draft = await deps.repositories.revisions.getById(card.draftRevisionId);
      if (!draft) return;
      // Revisions are immutable rows; create a published revision snapshot with same config.
      const publishedId = deps.ids.nextId();
      const now = deps.clock.now();
      await deps.repositories.revisions.create({
        id: publishedId,
        cardId: card.id,
        status: 'published',
        config: draft.config,
        createdBy: draft.createdBy,
        createdAt: now,
      });
      await deps.repositories.cards.update({
        ...card,
        publishedRevisionId: publishedId,
        draftRevisionId: null,
        updatedAt: now,
      });
    },
  };
}

export type PiProviderService = ReturnType<typeof createPiProviderService>;

function toConfigDto(config: {
  protocol: PiProviderConfigDto['protocol'];
  baseUrl: string;
  endpointMode: PiProviderConfigDto['endpointMode'];
  modelId: string;
  timeoutMs: number;
  maxOutputTokens: number;
  compatibilityParams: object;
}): PiProviderConfigDto {
  return {
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    endpointMode: config.endpointMode,
    modelId: config.modelId,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    compatibilityParams: {},
  };
}

/** Convenience for UI defaults when creating from preset. */
export function presetDefaultsForCreate(preset: string) {
  return getPiProviderPreset(preset);
}

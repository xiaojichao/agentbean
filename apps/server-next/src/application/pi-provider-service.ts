import {
  makeFailure,
  makeSuccess,
  type Ack,
  type ListPiProviderCardsResult,
  type ListPiProviderPresetsResult,
  type PiProviderCardDto,
  type PiProviderCardRevisionDto,
  type PiProviderConfigDto,
} from '../../../../packages/contracts/src/index.js';
import {
  getPiProviderPreset,
  listPiProviderPresets,
  parseCopyPiProviderCardRequest,
  parseCreatePiProviderCardRequest,
  parseGetPiProviderCardRequest,
  parseListPiProviderCardsRequest,
  parseListPiProviderPresetsRequest,
  parseUpdatePiProviderCardRequest,
} from '../../../../packages/domain/src/index.js';
import type {
  PiProviderCardRevisionRecord,
  PiProviderRepositories,
  PiProviderUnitOfWork,
} from './pi-provider-repositories.js';
import type { UserRecord } from './repositories.js';
import {
  encryptPiProviderApiKey,
  resolvePiSecretKey,
  serializeEncryptedSecret,
  type PiSecretKeyResolution,
} from './pi-provider-secret.js';

export interface PiProviderServiceDependencies {
  readonly repositories: PiProviderRepositories;
  readonly unitOfWork: PiProviderUnitOfWork;
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

  async function toCardDto(
    cardId: string,
    repositories: PiProviderRepositories = deps.repositories,
  ): Promise<PiProviderCardDto | null> {
    const card = await repositories.cards.getById(cardId);
    if (!card) return null;
    const credential = await repositories.credentials.getById(card.credentialRef);
    const draft = card.draftRevisionId
      ? await repositories.revisions.getById(card.draftRevisionId)
      : null;
    const published = card.publishedRevisionId
      ? await repositories.revisions.getById(card.publishedRevisionId)
      : null;
    const preferred = draft ?? published;
    return {
      id: card.id,
      displayName: preferred?.displayName ?? '',
      preset: card.preset,
      notes: preferred?.notes ?? null,
      consoleUrl: preferred?.consoleUrl ?? null,
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

  function toRevisionDto(revision: PiProviderCardRevisionRecord): PiProviderCardRevisionDto {
    return {
      id: revision.id,
      cardId: revision.cardId,
      status: revision.status,
      displayName: revision.displayName,
      notes: revision.notes,
      consoleUrl: revision.consoleUrl,
      config: revision.config,
      createdBy: revision.createdBy,
      createdAt: revision.createdAt,
    };
  }

  function assertSafeAckPayload(payload: unknown): void {
    const text = JSON.stringify(payload);
    if (/encrypted_payload|ciphertext|apiKeyCiphertext|"apiKey"\s*:/i.test(text)) {
      throw new Error('PI provider response leaked secret material');
    }
  }

  function toConfigDto(config: {
    protocol: PiProviderConfigDto['protocol'];
    baseUrl: string;
    endpointMode: PiProviderConfigDto['endpointMode'];
    modelId: string;
    timeoutMs: number;
    maxOutputTokens: number;
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

  return {
    async listPresets(raw: unknown): Promise<Ack<ListPiProviderPresetsResult>> {
      const parsed = parseListPiProviderPresetsRequest(raw ?? {});
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
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

    async listCards(raw: unknown): Promise<Ack<ListPiProviderCardsResult>> {
      const parsed = parseListPiProviderCardsRequest(raw ?? {});
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
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

    async getCard(raw: unknown): Promise<Ack<{ card: PiProviderCardDto }>> {
      const parsed = parseGetPiProviderCardRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;
      const card = await toCardDto(parsed.value.cardId);
      if (!card) return makeFailure('NOT_FOUND', 'Provider card not found');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    async createCard(raw: unknown): Promise<Ack<{ card: PiProviderCardDto }>> {
      const parsed = parseCreatePiProviderCardRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;

      const key = requireEncryptionKey();
      if (!key.ok) return key.failure as Ack<{ card: PiProviderCardDto }>;

      const now = deps.clock.now();
      const cardId = deps.ids.nextId();
      const credentialId = deps.ids.nextId();
      const revisionId = deps.ids.nextId();
      const encrypted = encryptPiProviderApiKey(parsed.value.apiKey, key.key);

      try {
        await deps.unitOfWork.run(async (repositories) => {
          await repositories.credentials.create({
            id: credentialId,
            keyVersion: encrypted.keyVersion,
            encryptedPayload: serializeEncryptedSecret(encrypted),
            fingerprint: encrypted.fingerprint,
            createdAt: now,
            updatedAt: now,
          });
          await repositories.cards.create({
            id: cardId,
            preset: parsed.value.preset,
            credentialRef: credentialId,
            draftRevisionId: revisionId,
            publishedRevisionId: null,
            createdBy: parsed.value.userId,
            createdAt: now,
            updatedAt: now,
          });
          await repositories.revisions.create({
            id: revisionId,
            cardId,
            status: 'draft',
            displayName: parsed.value.displayName,
            notes: parsed.value.notes,
            consoleUrl: parsed.value.consoleUrl,
            config: toConfigDto(parsed.value.config),
            createdBy: parsed.value.userId,
            createdAt: now,
          });
        });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to create provider card');
      }

      const card = await toCardDto(cardId);
      if (!card) return makeFailure('INTERNAL_ERROR', 'Failed to load created card');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    async updateCard(raw: unknown): Promise<Ack<{ card: PiProviderCardDto }>> {
      const parsed = parseUpdatePiProviderCardRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;

      const existing = await deps.repositories.cards.getById(parsed.value.cardId);
      if (!existing) return makeFailure('NOT_FOUND', 'Provider card not found');

      let encrypted: ReturnType<typeof encryptPiProviderApiKey> | null = null;
      if (parsed.value.apiKey) {
        const key = requireEncryptionKey();
        if (!key.ok) return key.failure as Ack<{ card: PiProviderCardDto }>;
        encrypted = encryptPiProviderApiKey(parsed.value.apiKey, key.key);
      }

      const now = deps.clock.now();
      const revisionId = deps.ids.nextId();

      try {
        await deps.unitOfWork.run(async (repositories) => {
          if (encrypted) {
            const credential = await repositories.credentials.getById(existing.credentialRef);
            if (!credential) throw new Error('Credential reference missing');
            await repositories.credentials.update({
              id: credential.id,
              keyVersion: encrypted.keyVersion,
              encryptedPayload: serializeEncryptedSecret(encrypted),
              fingerprint: encrypted.fingerprint,
              createdAt: credential.createdAt,
              updatedAt: now,
            });
          }

          // 全部可编辑内容（含 displayName/notes/consoleUrl）写入新 Draft revision；
          // published revision 与其元数据保持不变。
          await repositories.revisions.create({
            id: revisionId,
            cardId: existing.id,
            status: 'draft',
            displayName: parsed.value.displayName,
            notes: parsed.value.notes,
            consoleUrl: parsed.value.consoleUrl,
            config: toConfigDto(parsed.value.config),
            createdBy: parsed.value.userId,
            createdAt: now,
          });

          await repositories.cards.update({
            ...existing,
            draftRevisionId: revisionId,
            updatedAt: now,
          });
        });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to update provider card');
      }

      const card = await toCardDto(existing.id);
      if (!card) return makeFailure('INTERNAL_ERROR', 'Failed to load updated card');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    async copyCard(raw: unknown): Promise<Ack<{ card: PiProviderCardDto }>> {
      const parsed = parseCopyPiProviderCardRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;

      const source = await deps.repositories.cards.getById(parsed.value.sourceCardId);
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

      const displayName = parsed.value.displayName ?? `${sourceRevision.displayName} (copy)`;

      const now = deps.clock.now();
      const cardId = deps.ids.nextId();
      const credentialId = deps.ids.nextId();
      const revisionId = deps.ids.nextId();

      try {
        await deps.unitOfWork.run(async (repositories) => {
          await repositories.credentials.create({
            id: credentialId,
            keyVersion: sourceCredential.keyVersion,
            encryptedPayload: sourceCredential.encryptedPayload,
            fingerprint: sourceCredential.fingerprint,
            createdAt: now,
            updatedAt: now,
          });
          await repositories.cards.create({
            id: cardId,
            preset: source.preset,
            credentialRef: credentialId,
            draftRevisionId: revisionId,
            publishedRevisionId: null,
            createdBy: parsed.value.userId,
            createdAt: now,
            updatedAt: now,
          });
          await repositories.revisions.create({
            id: revisionId,
            cardId,
            status: 'draft',
            displayName,
            notes: sourceRevision.notes,
            consoleUrl: sourceRevision.consoleUrl,
            config: sourceRevision.config,
            createdBy: parsed.value.userId,
            createdAt: now,
          });
        });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to copy provider card');
      }

      const card = await toCardDto(cardId);
      if (!card) return makeFailure('INTERNAL_ERROR', 'Failed to load copied card');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    /** 测试辅助：将当前 draft 快照为 published（#703 拥有真实发布）。 */
    async __testMarkDraftPublished(input: { cardId: string }): Promise<void> {
      const card = await deps.repositories.cards.getById(input.cardId);
      if (!card?.draftRevisionId) return;
      const draft = await deps.repositories.revisions.getById(card.draftRevisionId);
      if (!draft) return;
      const publishedId = deps.ids.nextId();
      const now = deps.clock.now();
      await deps.unitOfWork.run(async (repositories) => {
        await repositories.revisions.create({
          id: publishedId,
          cardId: card.id,
          status: 'published',
          displayName: draft.displayName,
          notes: draft.notes,
          consoleUrl: draft.consoleUrl,
          config: draft.config,
          createdBy: draft.createdBy,
          createdAt: now,
        });
        await repositories.cards.update({
          ...card,
          publishedRevisionId: publishedId,
          draftRevisionId: null,
          updatedAt: now,
        });
      });
    },
  };
}

export type PiProviderService = ReturnType<typeof createPiProviderService>;

export function presetDefaultsForCreate(preset: string) {
  return getPiProviderPreset(preset);
}

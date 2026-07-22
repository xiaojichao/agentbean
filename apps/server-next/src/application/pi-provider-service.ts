import {
  makeFailure,
  makeSuccess,
  type Ack,
  type ActivePiModelDto,
  type ActivePiModelHistoryEntryDto,
  type CancelPiProviderTestResult,
  type DiscoverPiProviderModelsResult,
  type ListPiProviderCardsResult,
  type ListPiProviderPresetsResult,
  type PiProviderCardDto,
  type PiProviderCardRevisionDto,
  type PiProviderConfigDto,
  type PiProviderTestResultDto,
  type PublicPiHealthDto,
  type PublishPiProviderCardResult,
  type RunPiProviderTestResult,
} from '../../../../packages/contracts/src/index.js';
import {
  computePiProviderConfigSummary,
  evaluatePiProviderPublish,
  getPiProviderPreset,
  listPiProviderPresets,
  parseCopyPiProviderCardRequest,
  parseCreatePiProviderCardRequest,
  parseDiscoverPiProviderModelsRequest,
  parseGetPiProviderCardRequest,
  parseListPiProviderCardsRequest,
  parseListPiProviderPresetsRequest,
  parsePublishPiProviderCardRequest,
  parseGetActivePiModelRequest,
  parsePublicPiHealthRequest,
  parseRunPiProviderTestRequest,
  parseSetActivePiModelRequest,
  parseUpdatePiProviderCardRequest,
} from '../../../../packages/domain/src/index.js';
import type {
  PiProviderCardRevisionRecord,
  PiProviderRepositories,
  PiProviderRevisionTestRecord,
  PiProviderUnitOfWork,
} from './pi-provider-repositories.js';
import type { UserRecord } from './repositories.js';
import {
  decryptPiProviderApiKey,
  encryptPiProviderApiKey,
  parseEncryptedSecret,
  resolvePiSecretKey,
  serializeEncryptedSecret,
  type PiSecretKeyResolution,
} from './pi-provider-secret.js';
import { discoverPiProviderModels } from './pi-provider-model-discovery.js';
import {
  runPiProviderProductionTest,
  type PiProviderProductionTestOutcome,
} from './pi-provider-production-test.js';

export interface PiProviderServiceDependencies {
  readonly repositories: PiProviderRepositories;
  readonly unitOfWork: PiProviderUnitOfWork;
  readonly users: {
    getById(id: string): Promise<UserRecord | null>;
  };
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly resolveSecretKey?: () => PiSecretKeyResolution;
  readonly fetch?: typeof fetch;
}

export function createPiProviderService(deps: PiProviderServiceDependencies) {
  const resolveKey = deps.resolveSecretKey ?? (() => resolvePiSecretKey());
  const fetchFn = deps.fetch ?? fetch;
  const activeTests = new Map<string, AbortController>();

  function activeTestKey(cardId: string): string {
    return cardId;
  }

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

  function toTestDto(test: PiProviderRevisionTestRecord): PiProviderTestResultDto {
    return {
      id: test.id,
      cardId: test.cardId,
      draftRevisionId: test.draftRevisionId,
      configSummary: test.configSummary,
      status: test.status,
      textOk: test.textOk,
      toolCallOk: test.toolCallOk,
      responseModel: test.responseModel,
      finishReasonText: test.finishReasonText,
      finishReasonTool: test.finishReasonTool,
      usageInputTokens: test.usageInputTokens,
      usageOutputTokens: test.usageOutputTokens,
      durationMs: test.durationMs,
      diagnosticCode: test.diagnosticCode,
      testedBy: test.testedBy,
      testedAt: test.testedAt,
    };
  }

  async function draftConfigSummary(
    repositories: PiProviderRepositories,
    cardId: string,
  ): Promise<{ summary: string; draftRevisionId: string; draft: PiProviderCardRevisionRecord } | null> {
    const card = await repositories.cards.getById(cardId);
    if (!card?.draftRevisionId) return null;
    const draft = await repositories.revisions.getById(card.draftRevisionId);
    if (!draft) return null;
    const credential = await repositories.credentials.getById(card.credentialRef);
    if (!credential) return null;
    return {
      draftRevisionId: draft.id,
      draft,
      summary: computePiProviderConfigSummary({
        protocol: draft.config.protocol,
        baseUrl: draft.config.baseUrl,
        endpointMode: draft.config.endpointMode,
        modelId: draft.config.modelId,
        timeoutMs: draft.config.timeoutMs,
        maxOutputTokens: draft.config.maxOutputTokens,
        compatibilityParams: draft.config.compatibilityParams,
        credentialFingerprint: credential.fingerprint,
      }),
    };
  }

  async function toCardDto(
    cardId: string,
    repositories: PiProviderRepositories,
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
    const publishedRevisions = (await repositories.revisions.listByCard(cardId))
      .filter((revision) => revision.status === 'published');
    const preferred = draft ?? published;
    const latestTest = await repositories.tests.getLatestByCard(cardId);
    let canPublish = false;
    if (draft && credential) {
      const summary = computePiProviderConfigSummary({
        protocol: draft.config.protocol,
        baseUrl: draft.config.baseUrl,
        endpointMode: draft.config.endpointMode,
        modelId: draft.config.modelId,
        timeoutMs: draft.config.timeoutMs,
        maxOutputTokens: draft.config.maxOutputTokens,
        compatibilityParams: draft.config.compatibilityParams,
        credentialFingerprint: credential.fingerprint,
      });
      const decision = evaluatePiProviderPublish({
        hasDraftRevision: true,
        draftConfigSummary: summary,
        latestTest: latestTest
          ? { status: latestTest.status, configSummary: latestTest.configSummary }
          : null,
      });
      canPublish = decision.allowed;
    }
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
      publishedRevisions: publishedRevisions.map(toRevisionDto),
      modelCandidates: (card.modelCandidates ?? []).map((modelId) => ({ modelId })),
      modelCandidatesUpdatedAt: card.modelCandidatesUpdatedAt,
      latestTest: latestTest ? toTestDto(latestTest) : null,
      canPublish,
      createdBy: card.createdBy,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    };
  }

  function assertSafeAckPayload(payload: unknown): void {
    const text = JSON.stringify(payload);
    if (/encrypted_payload|ciphertext|apiKeyCiphertext|"apiKey"\s*:/i.test(text)) {
      throw new Error('PI provider response leaked secret material');
    }
  }

  async function toActiveModelDto(
    active: { cardId: string; revisionId: string; changedBy: string; changedAt: number },
    repositories: PiProviderRepositories,
  ): Promise<ActivePiModelDto | null> {
    const revision = await repositories.revisions.getById(active.revisionId);
    if (!revision || revision.cardId !== active.cardId || revision.status !== 'published') return null;
    return { ...active, modelId: revision.config.modelId };
  }

  async function activeModelHealth(repositories: PiProviderRepositories): Promise<PublicPiHealthDto> {
    const active = await repositories.activeModel.get();
    if (!active) return { status: 'unavailable', diagnosticCode: 'PI_ACTIVE_MODEL_NOT_CONFIGURED' };
    const revision = await repositories.revisions.getById(active.revisionId);
    if (!revision || revision.status !== 'published' || revision.cardId !== active.cardId) {
      return { status: 'unavailable', diagnosticCode: 'PI_ACTIVE_MODEL_INVALID' };
    }
    const card = await repositories.cards.getById(active.cardId);
    if (!card) return { status: 'unavailable', diagnosticCode: 'PI_ACTIVE_MODEL_INVALID' };
    const credential = await resolveApiKey(repositories, card.credentialRef);
    if (!credential.ok) return { status: 'unavailable', diagnosticCode: 'PI_ACTIVE_MODEL_CREDENTIAL_UNAVAILABLE' };
    const summary = computePiProviderConfigSummary({ ...revision.config, credentialFingerprint: credential.fingerprint });
    const test = await repositories.tests.getLatestByConfigSummary({ cardId: card.id, configSummary: summary });
    if (!test || test.status !== 'passed' || test.configSummary !== summary) {
      return { status: 'degraded', diagnosticCode: 'PI_ACTIVE_MODEL_TEST_STALE' };
    }
    return { status: 'normal', diagnosticCode: null };
  }

  async function resolveApiKey(
    repositories: PiProviderRepositories,
    credentialRef: string,
  ): Promise<{ ok: true; apiKey: string; fingerprint: string } | { ok: false; failure: Ack<{}> }> {
    const key = requireEncryptionKey();
    if (!key.ok) return { ok: false, failure: key.failure };
    const credential = await repositories.credentials.getById(credentialRef);
    if (!credential) return { ok: false, failure: makeFailure('INTERNAL_ERROR', 'Credential missing') };
    const parsed = parseEncryptedSecret(credential.encryptedPayload);
    if (!parsed) return { ok: false, failure: makeFailure('INTERNAL_ERROR', 'Credential payload invalid') };
    try {
      const apiKey = decryptPiProviderApiKey(parsed, key.key);
      return { ok: true, apiKey, fingerprint: credential.fingerprint };
    } catch {
      return { ok: false, failure: makeFailure('INTERNAL_ERROR', 'Credential decryption failed') };
    }
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
      const dtos = await deps.unitOfWork.run(async (repositories) => {
        const cards = await repositories.cards.list();
        const result: PiProviderCardDto[] = [];
        for (const card of cards) {
          const dto = await toCardDto(card.id, repositories);
          if (dto) result.push(dto);
        }
        return result;
      });
      const result = makeSuccess({ cards: dtos });
      assertSafeAckPayload(result);
      return result;
    },

    async getCard(raw: unknown): Promise<Ack<{ card: PiProviderCardDto }>> {
      const parsed = parseGetPiProviderCardRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;
      const card = await deps.unitOfWork.run((repositories) =>
        toCardDto(parsed.value.cardId, repositories));
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

      let card: PiProviderCardDto | null;
      try {
        card = await deps.unitOfWork.run(async (repositories) => {
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
            modelCandidates: [],
            modelCandidatesUpdatedAt: null,
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
          return toCardDto(cardId, repositories);
        });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to create provider card');
      }

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

      let encrypted: ReturnType<typeof encryptPiProviderApiKey> | null = null;
      if (parsed.value.apiKey) {
        const key = requireEncryptionKey();
        if (!key.ok) return key.failure as Ack<{ card: PiProviderCardDto }>;
        encrypted = encryptPiProviderApiKey(parsed.value.apiKey, key.key);
      }

      const now = deps.clock.now();
      const revisionId = deps.ids.nextId();

      let outcome:
        | { readonly kind: 'not_found' }
        | { readonly kind: 'ok'; readonly card: PiProviderCardDto | null };
      try {
        outcome = await deps.unitOfWork.run(async (repositories) => {
          const existing = await repositories.cards.getById(parsed.value.cardId);
          if (!existing) return { kind: 'not_found' } as const;
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
            modelCandidates: [],
            modelCandidatesUpdatedAt: null,
            updatedAt: now,
          });
          return {
            kind: 'ok',
            card: await toCardDto(existing.id, repositories),
          } as const;
        });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to update provider card');
      }

      if (outcome.kind === 'not_found') return makeFailure('NOT_FOUND', 'Provider card not found');
      const card = outcome.card;
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

      const now = deps.clock.now();
      const cardId = deps.ids.nextId();
      const credentialId = deps.ids.nextId();
      const revisionId = deps.ids.nextId();

      let outcome:
        | { readonly kind: 'not_found' }
        | { readonly kind: 'no_revision' }
        | { readonly kind: 'missing_source_data' }
        | { readonly kind: 'ok'; readonly card: PiProviderCardDto | null };
      try {
        outcome = await deps.unitOfWork.run(async (repositories) => {
          const source = await repositories.cards.getById(parsed.value.sourceCardId);
          if (!source) return { kind: 'not_found' } as const;
          const sourceRevisionId = source.draftRevisionId ?? source.publishedRevisionId;
          if (!sourceRevisionId) return { kind: 'no_revision' } as const;
          const sourceRevision = await repositories.revisions.getById(sourceRevisionId);
          const sourceCredential = await repositories.credentials.getById(source.credentialRef);
          if (!sourceRevision || !sourceCredential) return { kind: 'missing_source_data' } as const;
          const displayName = parsed.value.displayName ?? `${sourceRevision.displayName} (copy)`;

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
            modelCandidates: [],
            modelCandidatesUpdatedAt: null,
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
          return {
            kind: 'ok',
            card: await toCardDto(cardId, repositories),
          } as const;
        });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to copy provider card');
      }

      if (outcome.kind === 'not_found') return makeFailure('NOT_FOUND', 'Source provider card not found');
      if (outcome.kind === 'no_revision') {
        return makeFailure('VALIDATION_ERROR', 'Source card has no configuration revision');
      }
      if (outcome.kind === 'missing_source_data') {
        return makeFailure('INTERNAL_ERROR', 'Source revision or credential missing');
      }
      const card = outcome.card;
      if (!card) return makeFailure('INTERNAL_ERROR', 'Failed to load copied card');
      const result = makeSuccess({ card });
      assertSafeAckPayload(result);
      return result;
    },

    async discoverModels(raw: unknown): Promise<Ack<DiscoverPiProviderModelsResult>> {
      const parsed = parseDiscoverPiProviderModelsRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;

      const prepared = await deps.unitOfWork.run(async (repositories) => {
        const card = await repositories.cards.getById(parsed.value.cardId);
        if (!card) return { kind: 'not_found' } as const;
        const workingRevisionId = card.draftRevisionId ?? card.publishedRevisionId;
        if (!workingRevisionId) return { kind: 'no_revision' } as const;
        const revision = await repositories.revisions.getById(workingRevisionId);
        if (!revision) return { kind: 'no_revision' } as const;
        const apiKey = await resolveApiKey(repositories, card.credentialRef);
        if (!apiKey.ok) return { kind: 'credential', failure: apiKey.failure } as const;
        return {
          kind: 'ok' as const,
          card,
          baseUrl: revision.config.baseUrl,
          timeoutMs: revision.config.timeoutMs,
          workingRevisionId,
          apiKey: apiKey.apiKey,
        };
      });

      if (prepared.kind === 'not_found') return makeFailure('NOT_FOUND', 'Provider card not found');
      if (prepared.kind === 'no_revision') {
        return makeFailure('VALIDATION_ERROR', 'Card has no configuration revision');
      }
      if (prepared.kind === 'credential') {
        return prepared.failure as Ack<DiscoverPiProviderModelsResult>;
      }

      const discovery = await discoverPiProviderModels({
        apiKey: prepared.apiKey,
        baseUrl: prepared.baseUrl,
        timeoutMs: prepared.timeoutMs,
        fetch: fetchFn,
      });

      // 刷新只更新候选，不发布 Draft、不改变生产绑定。
      const now = deps.clock.now();
      const models = discovery.modelIds.map((modelId) => ({ modelId }));
      let persistOutcome: 'updated' | 'stale';
      try {
        persistOutcome = await deps.unitOfWork.run(async (repositories) => {
          const card = await repositories.cards.getById(parsed.value.cardId);
          if (!card) throw new Error('card missing');
          const currentRevisionId = card.draftRevisionId ?? card.publishedRevisionId;
          if (currentRevisionId !== prepared.workingRevisionId) return 'stale' as const;
          await repositories.cards.update({
            ...card,
            modelCandidates: discovery.discoverySupported ? [...discovery.modelIds] : [...card.modelCandidates],
            modelCandidatesUpdatedAt: discovery.discoverySupported ? now : card.modelCandidatesUpdatedAt,
            updatedAt: now,
          });
          return 'updated' as const;
        });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to persist model candidates');
      }
      if (persistOutcome === 'stale') {
        return makeFailure('CONFLICT', 'Provider configuration changed during model discovery; refresh and retry');
      }

      // 发现失败仍返回成功 ack 且 discoverySupported=false，允许手填 Model ID；不自动发布。
      const result = makeSuccess({
        cardId: parsed.value.cardId,
        discoverySupported: discovery.discoverySupported,
        models: discovery.discoverySupported ? models : [],
        updatedAt: now,
        diagnosticCode: discovery.diagnosticCode,
      } satisfies DiscoverPiProviderModelsResult);
      assertSafeAckPayload(result);
      return result;
    },

    async runTest(raw: unknown): Promise<Ack<RunPiProviderTestResult>> {
      const parsed = parseRunPiProviderTestRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;

      const prepared = await deps.unitOfWork.run(async (repositories) => {
        const bound = await draftConfigSummary(repositories, parsed.value.cardId);
        if (!bound) return { kind: 'no_draft' } as const;
        const card = await repositories.cards.getById(parsed.value.cardId);
        if (!card) return { kind: 'not_found' } as const;
        const apiKey = await resolveApiKey(repositories, card.credentialRef);
        if (!apiKey.ok) return { kind: 'credential', failure: apiKey.failure } as const;
        return {
          kind: 'ok' as const,
          draft: bound.draft,
          draftRevisionId: bound.draftRevisionId,
          configSummary: bound.summary,
          apiKey: apiKey.apiKey,
        };
      });

      if (prepared.kind === 'not_found') return makeFailure('NOT_FOUND', 'Provider card not found');
      if (prepared.kind === 'no_draft') {
        return makeFailure('VALIDATION_ERROR', 'Only Draft revisions can be tested for publish');
      }
      if (prepared.kind === 'credential') {
        return prepared.failure as Ack<RunPiProviderTestResult>;
      }

      const testKey = activeTestKey(parsed.value.cardId);
      if (activeTests.has(testKey)) {
        return makeFailure('CONFLICT', 'A provider test is already running for this card');
      }
      const controller = new AbortController();
      activeTests.set(testKey, controller);

      let outcome: PiProviderProductionTestOutcome;
      try {
        outcome = await runPiProviderProductionTest({
          apiKey: prepared.apiKey,
          config: prepared.draft.config,
          fetch: fetchFn,
          now: deps.clock.now,
          signal: controller.signal,
        });
      } finally {
        if (activeTests.get(testKey) === controller) activeTests.delete(testKey);
      }

      const testId = deps.ids.nextId();
      const testedAt = deps.clock.now();
      let card: PiProviderCardDto | null = null;
      let testDto: PiProviderTestResultDto | null = null;
      try {
        const saved = await deps.unitOfWork.run(async (repositories) => {
          const record: PiProviderRevisionTestRecord = {
            id: testId,
            cardId: parsed.value.cardId,
            draftRevisionId: prepared.draftRevisionId,
            configSummary: prepared.configSummary,
            status: outcome.status,
            textOk: outcome.textOk,
            toolCallOk: outcome.toolCallOk,
            responseModel: outcome.responseModel,
            finishReasonText: outcome.finishReasonText,
            finishReasonTool: outcome.finishReasonTool,
            usageInputTokens: outcome.usageInputTokens,
            usageOutputTokens: outcome.usageOutputTokens,
            durationMs: outcome.durationMs,
            diagnosticCode: outcome.diagnosticCode,
            testedBy: parsed.value.userId,
            testedAt,
          };
          await repositories.tests.create(record);
          return {
            test: toTestDto(record),
            card: await toCardDto(parsed.value.cardId, repositories),
          };
        });
        testDto = saved.test;
        card = saved.card;
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to persist test result');
      }

      if (!card || !testDto) return makeFailure('INTERNAL_ERROR', 'Failed to load test result');
      const result = makeSuccess({ test: testDto, card });
      assertSafeAckPayload(result);
      return result;
    },

    async cancelTest(raw: unknown): Promise<Ack<CancelPiProviderTestResult>> {
      const parsed = parseRunPiProviderTestRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;
      const controller = activeTests.get(activeTestKey(parsed.value.cardId));
      if (!controller) return makeSuccess({ cancelled: false });
      controller.abort();
      return makeSuccess({ cancelled: true });
    },

    async publishCard(raw: unknown): Promise<Ack<PublishPiProviderCardResult>> {
      const parsed = parsePublishPiProviderCardRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;

      const now = deps.clock.now();
      const publishedId = deps.ids.nextId();

      let outcome:
        | { readonly kind: 'not_found' }
        | { readonly kind: 'no_draft' }
        | { readonly kind: 'gate'; readonly reason: string }
        | { readonly kind: 'ok'; readonly card: PiProviderCardDto | null };
      try {
        outcome = await deps.unitOfWork.run(async (repositories) => {
          const card = await repositories.cards.getById(parsed.value.cardId);
          if (!card) return { kind: 'not_found' } as const;
          const bound = await draftConfigSummary(repositories, card.id);
          if (!bound) return { kind: 'no_draft' } as const;

          const latestTest = await repositories.tests.getLatestByCard(card.id);
          const decision = evaluatePiProviderPublish({
            hasDraftRevision: true,
            draftConfigSummary: bound.summary,
            latestTest: latestTest
              ? { status: latestTest.status, configSummary: latestTest.configSummary }
              : null,
          });
          if (!decision.allowed) {
            return { kind: 'gate', reason: decision.reason } as const;
          }

          // 发布：从当前 Draft 生成不可变 published revision；Draft 指针清空。
          await repositories.revisions.create({
            id: publishedId,
            cardId: card.id,
            status: 'published',
            displayName: bound.draft.displayName,
            notes: bound.draft.notes,
            consoleUrl: bound.draft.consoleUrl,
            config: bound.draft.config,
            createdBy: parsed.value.userId,
            createdAt: now,
          });
          await repositories.cards.update({
            ...card,
            publishedRevisionId: publishedId,
            draftRevisionId: null,
            updatedAt: now,
          });
          return {
            kind: 'ok',
            card: await toCardDto(card.id, repositories),
          } as const;
        });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Failed to publish provider card');
      }

      if (outcome.kind === 'not_found') return makeFailure('NOT_FOUND', 'Provider card not found');
      if (outcome.kind === 'no_draft') {
        return makeFailure('VALIDATION_ERROR', 'Only a Draft can be published');
      }
      if (outcome.kind === 'gate') {
        return makeFailure('VALIDATION_ERROR', `Publish rejected: ${outcome.reason}`);
      }
      if (!outcome.card) return makeFailure('INTERNAL_ERROR', 'Failed to load published card');
      const result = makeSuccess({ card: outcome.card });
      assertSafeAckPayload(result);
      return result;
    },

    async setActiveModel(raw: unknown): Promise<Ack<{ activeModel: ActivePiModelDto }>> {
      const parsed = parseSetActivePiModelRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;
      const now = deps.clock.now();
      const active = await deps.unitOfWork.run(async (repositories) => {
        const revision = await repositories.revisions.getById(parsed.value.revisionId);
        if (!revision || revision.status !== 'published') return null;
        const card = await repositories.cards.getById(revision.cardId);
        if (!card) return null;
        const credential = await repositories.credentials.getById(card.credentialRef);
        if (!credential) return null;
        const summary = computePiProviderConfigSummary({ ...revision.config, credentialFingerprint: credential.fingerprint });
        const test = await repositories.tests.getLatestByConfigSummary({ cardId: card.id, configSummary: summary });
        if (!test || test.status !== 'passed' || test.configSummary !== summary) return null;
        const saved = await repositories.activeModel.set({ cardId: card.id, revisionId: revision.id, changedBy: parsed.value.userId, changedAt: now });
        return toActiveModelDto(saved, repositories);
      });
      if (!active) return makeFailure('VALIDATION_ERROR', 'Active PI Model must reference a tested published revision');
      const result = makeSuccess({ activeModel: active });
      assertSafeAckPayload(result);
      return result;
    },

    async getActiveModel(raw: unknown): Promise<Ack<{ activeModel: ActivePiModelDto | null; history: ActivePiModelHistoryEntryDto[]; health: PublicPiHealthDto }>> {
      const parsed = parseGetActivePiModelRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const admin = await requireSystemAdmin(parsed.value.userId);
      if (!admin.ok) return admin;
      const result = await deps.unitOfWork.run(async (repositories) => {
        const active = await repositories.activeModel.get();
        const history = await repositories.activeModel.listHistory();
        return makeSuccess({
          activeModel: active ? await toActiveModelDto(active, repositories) : null,
          history: (await Promise.all(history.map((entry) => toActiveModelDto(entry, repositories)))).filter((entry): entry is ActivePiModelHistoryEntryDto => entry !== null),
          health: await activeModelHealth(repositories),
        });
      });
      assertSafeAckPayload(result);
      return result;
    },

    async getPublicHealth(raw: unknown): Promise<Ack<{ health: PublicPiHealthDto }>> {
      const parsed = parsePublicPiHealthRequest(raw);
      if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
      const user = await deps.users.getById(parsed.value.userId);
      if (!user) return makeFailure('UNAUTHENTICATED', 'User not found');
      const result = makeSuccess({ health: await deps.unitOfWork.run(activeModelHealth) });
      assertSafeAckPayload(result);
      return result;
    },
  };
}

export type PiProviderService = ReturnType<typeof createPiProviderService>;

export function presetDefaultsForCreate(preset: string) {
  return getPiProviderPreset(preset);
}

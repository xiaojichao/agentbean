import { createHash, scryptSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { createPiProviderService } from '../src/application/pi-provider-service.js';
import {
  decryptPiProviderApiKey,
  encryptPiProviderApiKey,
  parseEncryptedSecret,
  resolvePiSecretKey,
  serializeEncryptedSecret,
} from '../src/application/pi-provider-secret.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { createServerNextUseCases } from '../src/application/usecases.js';

const SECRET = 'test-pi-secret-key-material-32b!!';

function secretKey(): Buffer {
  return scryptSync(SECRET, 'agentbean-pi-provider-v1', 32);
}

async function seedUsers(repos: ReturnType<typeof createInMemoryRepositories>) {
  const now = 1;
  await repos.users.create({
    id: 'admin-1',
    username: 'sysadmin',
    role: 'admin',
    passwordHash: 'x',
    createdAt: now,
    updatedAt: now,
  });
  await repos.users.create({
    id: 'owner-1',
    username: 'owner',
    role: 'user',
    passwordHash: 'x',
    createdAt: now,
    updatedAt: now,
  });
  await repos.users.create({
    id: 'member-1',
    username: 'member',
    role: 'user',
    passwordHash: 'x',
    createdAt: now,
    updatedAt: now,
  });
  await repos.teams.create({
    id: 'team-1',
    name: 'Team',
    path: 'team',
    visibility: 'private',
    ownerId: 'owner-1',
    createdAt: now,
  });
  await repos.teams.addMember({
    teamId: 'team-1',
    userId: 'owner-1',
    username: 'owner',
    role: 'owner',
    joinedAt: now,
  });
  await repos.teams.addMember({
    teamId: 'team-1',
    userId: 'member-1',
    username: 'member',
    role: 'member',
    joinedAt: now,
  });
  await repos.teams.addMember({
    teamId: 'team-1',
    userId: 'admin-1',
    username: 'sysadmin',
    role: 'admin',
    joinedAt: now,
  });
}

function createService(repos = createInMemoryRepositories()) {
  let seq = 0;
  const service = createPiProviderService({
    repositories: repos.piProvider,
    users: repos.users,
    clock: { now: () => 1_700_000_000_000 + seq },
    ids: { nextId: () => `id-${++seq}` },
    resolveSecretKey: () => ({ ok: true, key: secretKey() }),
  });
  return { repos, service };
}

describe('pi provider secret crypto', () => {
  test('encrypts with AES-256-GCM and round-trips', () => {
    const key = secretKey();
    const encrypted = encryptPiProviderApiKey('sk-live-secret', key);
    expect(encrypted.ciphertext.equals(Buffer.from('sk-live-secret'))).toBe(false);
    const serialized = serializeEncryptedSecret(encrypted);
    const parsed = parseEncryptedSecret(serialized);
    expect(parsed).not.toBeNull();
    expect(decryptPiProviderApiKey(parsed!, key)).toBe('sk-live-secret');
    expect(encrypted.fingerprint).toBe(
      createHash('sha256').update('sk-live-secret', 'utf8').digest('hex').slice(0, 12),
    );
  });

  test('resolves AGENTBEAN_PI_SECRET_KEY from env', () => {
    expect(resolvePiSecretKey({}).ok).toBe(false);
    expect(resolvePiSecretKey({ AGENTBEAN_PI_SECRET_KEY: SECRET }).ok).toBe(true);
  });
});

describe('pi provider service', () => {
  test('system admin can create a draft card from preset without leaking secrets', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    const created = await service.createCard({
      userId: 'admin-1',
      preset: 'openai',
      displayName: 'Primary OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt-4.1-mini',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      notes: 'prod candidate',
      consoleUrl: 'https://platform.openai.com',
      apiKey: 'sk-live-never-echo',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.card.displayName).toBe('Primary OpenAI');
    expect(created.card.draftRevision?.status).toBe('draft');
    expect(created.card.draftRevision?.config.modelId).toBe('gpt-4.1-mini');
    expect(created.card.credential.configured).toBe(true);
    expect(created.card.credential.credentialRef).toBeTruthy();
    const payload = JSON.stringify(created);
    expect(payload).not.toContain('sk-live-never-echo');
    expect(payload).not.toMatch(/encrypted_payload|ciphertext|v1\./i);

    const stored = await repos.piProvider.credentials.getById(created.card.credential.credentialRef);
    expect(stored?.encryptedPayload).toContain('v1.');
    expect(decryptPiProviderApiKey(parseEncryptedSecret(stored!.encryptedPayload)!, secretKey()))
      .toBe('sk-live-never-echo');
  });

  test('advanced JSON edits the same typed config and rejects bypass fields', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    const ok = await service.createCard({
      userId: 'admin-1',
      preset: 'custom_openai_compatible',
      displayName: 'Custom',
      baseUrl: 'https://example.invalid/v1',
      endpointMode: 'chat_completions',
      modelId: 'old-model',
      timeoutMs: 60_000,
      maxOutputTokens: 1024,
      apiKey: 'sk-a',
      advancedConfig: {
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openrouter/auto',
        timeoutMs: 12_000,
        maxOutputTokens: 512,
        compatibilityParams: {},
      },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.card.draftRevision?.config.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(ok.card.draftRevision?.config.modelId).toBe('openrouter/auto');
      expect(ok.card.draftRevision?.config.timeoutMs).toBe(12_000);
    }

    const rejected = await service.createCard({
      userId: 'admin-1',
      preset: 'openai',
      displayName: 'Bad',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt',
      timeoutMs: 60_000,
      maxOutputTokens: 1024,
      apiKey: 'sk-a',
      advancedConfig: { headers: { Authorization: 'Bearer x' } },
    });
    expect(rejected).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('team owner/admin/member fail closed on provider supply APIs', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    for (const userId of ['owner-1', 'member-1'] as const) {
      const list = await service.listCards({ userId });
      expect(list).toMatchObject({ ok: false, error: 'FORBIDDEN' });
      // Fail-closed: no card payload and no secret-bearing fields.
      expect(list).not.toHaveProperty('cards');
      expect(JSON.stringify(list)).not.toMatch(/modelId|baseUrl|credentialRef|draftRevision|apiKey/i);

      const create = await service.createCard({
        userId,
        preset: 'openai',
        displayName: 'Nope',
        baseUrl: 'https://api.openai.com/v1',
        endpointMode: 'chat_completions',
        modelId: 'gpt',
        timeoutMs: 60_000,
        maxOutputTokens: 1024,
        apiKey: 'sk-x',
      });
      expect(create).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    }
  });

  test('editing a published card creates a new draft without mutating published revision', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    const created = await service.createCard({
      userId: 'admin-1',
      preset: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      endpointMode: 'chat_completions',
      modelId: 'deepseek-chat',
      timeoutMs: 60_000,
      maxOutputTokens: 2048,
      apiKey: 'sk-ds',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await service.__testMarkDraftPublished({ cardId: created.card.id });
    const published = await service.getCard({ userId: 'admin-1', cardId: created.card.id });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.card.publishedRevision?.status).toBe('published');
    expect(published.card.draftRevision).toBeNull();
    const publishedRevisionId = published.card.publishedRevision!.id;
    const publishedConfig = published.card.publishedRevision!.config;

    const updated = await service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'DeepSeek edited',
      baseUrl: 'https://api.deepseek.com',
      endpointMode: 'chat_completions',
      modelId: 'deepseek-reasoner',
      timeoutMs: 90_000,
      maxOutputTokens: 4096,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.card.displayName).toBe('DeepSeek edited');
    expect(updated.card.draftRevision?.id).not.toBe(publishedRevisionId);
    expect(updated.card.draftRevision?.status).toBe('draft');
    expect(updated.card.draftRevision?.config.modelId).toBe('deepseek-reasoner');
    expect(updated.card.publishedRevision?.id).toBe(publishedRevisionId);
    expect(updated.card.publishedRevision?.config).toEqual(publishedConfig);

    const storedPublished = await repos.piProvider.revisions.getById(publishedRevisionId);
    expect(storedPublished?.config.modelId).toBe('deepseek-chat');
  });

  test('copy creates a new draft card with independent credential ref', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    const created = await service.createCard({
      userId: 'admin-1',
      preset: 'openrouter',
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      endpointMode: 'chat_completions',
      modelId: 'openrouter/auto',
      timeoutMs: 60_000,
      maxOutputTokens: 2048,
      apiKey: 'sk-or',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const copied = await service.copyCard({
      userId: 'admin-1',
      sourceCardId: created.card.id,
      displayName: 'OpenRouter copy',
    });
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.card.id).not.toBe(created.card.id);
    expect(copied.card.displayName).toBe('OpenRouter copy');
    expect(copied.card.credential.credentialRef).not.toBe(created.card.credential.credentialRef);
    expect(copied.card.draftRevision?.config.modelId).toBe('openrouter/auto');
    expect(copied.card.publishedRevision).toBeNull();

    const sourceCred = await repos.piProvider.credentials.getById(created.card.credential.credentialRef);
    const copyCred = await repos.piProvider.credentials.getById(copied.card.credential.credentialRef);
    expect(copyCred?.encryptedPayload).toBe(sourceCred?.encryptedPayload);
    expect(JSON.stringify(copied)).not.toContain('sk-or');
  });

  test('credential replace keeps stable credentialRef and never echoes secrets', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    const created = await service.createCard({
      userId: 'admin-1',
      preset: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt-4.1-mini',
      timeoutMs: 60_000,
      maxOutputTokens: 2048,
      apiKey: 'sk-old',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const credentialRef = created.card.credential.credentialRef;

    const updated = await service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt-4.1-mini',
      timeoutMs: 60_000,
      maxOutputTokens: 2048,
      apiKey: 'sk-new',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.card.credential.credentialRef).toBe(credentialRef);
    expect(JSON.stringify(updated)).not.toContain('sk-old');
    expect(JSON.stringify(updated)).not.toContain('sk-new');

    const stored = await repos.piProvider.credentials.getById(credentialRef);
    expect(decryptPiProviderApiKey(parseEncryptedSecret(stored!.encryptedPayload)!, secretKey()))
      .toBe('sk-new');
  });

  test('use-case surface lists four presets for system admin only', async () => {
    const repos = createInMemoryRepositories();
    await seedUsers(repos);
    const app = createServerNextUseCases({
      repositories: repos,
      clock: { now: () => Date.now() },
      ids: { nextId: (() => { let n = 0; return () => `uc-${++n}`; })() },
    });

    // Inject secret for create path
    process.env.AGENTBEAN_PI_SECRET_KEY = SECRET;
    try {
      const forbidden = await app.listPiProviderPresets({ userId: 'owner-1' });
      expect(forbidden).toMatchObject({ ok: false, error: 'FORBIDDEN' });

      const presets = await app.listPiProviderPresets({ userId: 'admin-1' });
      expect(presets.ok).toBe(true);
      if (!presets.ok) return;
      expect(presets.presets.map((p) => p.preset)).toEqual([
        'openai',
        'openrouter',
        'deepseek',
        'custom_openai_compatible',
      ]);
    } finally {
      delete process.env.AGENTBEAN_PI_SECRET_KEY;
    }
  });
});

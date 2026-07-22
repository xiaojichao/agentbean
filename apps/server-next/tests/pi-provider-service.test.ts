import { createRequire } from 'node:module';
import { createHash, scryptSync } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { createPiProviderService } from '../src/application/pi-provider-service.js';
import {
  decryptPiProviderApiKey,
  encryptPiProviderApiKey,
  parseEncryptedSecret,
  resolvePiSecretKey,
} from '../src/application/pi-provider-secret.js';
import { createInMemoryPiProviderPersistence } from '../src/infra/memory/pi-provider-repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import {
  applyGlobalMigrations,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import { createSqlitePiProviderPersistence } from '../src/infra/sqlite/pi-provider-repositories.js';

const SECRET = 'test-pi-secret-key-material-32b!!';
const require = createRequire(import.meta.url);
type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = require('better-sqlite3') as DatabaseConstructor;

function secretKey(): Buffer {
  return scryptSync(SECRET, 'agentbean-pi-provider-v1', 32);
}

async function seedUsers(repos: ReturnType<typeof createInMemoryRepositories>) {
  const now = 1;
  await repos.users.create({
    id: 'admin-1', username: 'sysadmin', role: 'admin', passwordHash: 'x', createdAt: now, updatedAt: now,
  });
  await repos.users.create({
    id: 'owner-1', username: 'owner', role: 'user', passwordHash: 'x', createdAt: now, updatedAt: now,
  });
  await repos.users.create({
    id: 'member-1', username: 'member', role: 'user', passwordHash: 'x', createdAt: now, updatedAt: now,
  });
  await repos.teams.create({
    id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'owner-1', createdAt: now,
  });
  await repos.teams.addMember({ teamId: 'team-1', userId: 'owner-1', username: 'owner', role: 'owner', joinedAt: now });
  await repos.teams.addMember({ teamId: 'team-1', userId: 'member-1', username: 'member', role: 'member', joinedAt: now });
  await repos.teams.addMember({ teamId: 'team-1', userId: 'admin-1', username: 'sysadmin', role: 'admin', joinedAt: now });
}

function createService(
  repos = createInMemoryRepositories(),
  options: { fetch?: typeof fetch } = {},
) {
  let seq = 0;
  const service = createPiProviderService({
    repositories: repos.piProvider,
    unitOfWork: repos.piProviderUnitOfWork,
    users: repos.users,
    clock: { now: () => 1_700_000_000_000 + seq },
    ids: { nextId: () => `id-${++seq}` },
    resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    fetch: options.fetch,
  });
  return { repos, service };
}

function passingTestFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role?: string }>;
      tools?: unknown[];
    };
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const hasToolResult = body.messages?.some((m) => m.role === 'tool');
    if (hasTools && !hasToolResult) {
      return new Response(JSON.stringify({
        model: 'probe-model',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'context.get_root_message', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      model: 'probe-model',
      usage: { prompt_tokens: hasToolResult ? 3 : 1, completion_tokens: 1, total_tokens: hasToolResult ? 4 : 2 },
      choices: [{ message: { role: 'assistant', content: hasToolResult ? 'DONE' : 'OK' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function validCreate(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('pi provider secret crypto', () => {
  test('encrypts with AES-256-GCM and round-trips', () => {
    const key = secretKey();
    const encrypted = encryptPiProviderApiKey('sk-live-secret', key);
    expect(encrypted.ciphertext.equals(Buffer.from('sk-live-secret'))).toBe(false);
    const serialized = serializeForTest(encrypted);
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

function serializeForTest(secret: ReturnType<typeof encryptPiProviderApiKey>): string {
  return [
    `v${secret.keyVersion}`,
    secret.iv.toString('base64url'),
    secret.authTag.toString('base64url'),
    secret.ciphertext.toString('base64url'),
  ].join('.');
}

describe('pi provider service', () => {
  test('system admin can create a draft card from preset without leaking secrets', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.card.displayName).toBe('Primary OpenAI');
    expect(created.card.draftRevision?.status).toBe('draft');
    expect(created.card.draftRevision?.displayName).toBe('Primary OpenAI');
    expect(created.card.draftRevision?.config.modelId).toBe('gpt-4.1-mini');
    expect(created.card.credential.configured).toBe(true);
    const payload = JSON.stringify(created);
    expect(payload).not.toContain('sk-live-never-echo');
    expect(payload).not.toMatch(/encrypted_payload|ciphertext|v1\./i);

    const stored = await repos.piProvider.credentials.getById(created.card.credential.credentialRef);
    expect(decryptPiProviderApiKey(parseEncryptedSecret(stored!.encryptedPayload)!, secretKey()))
      .toBe('sk-live-never-echo');
  });

  test('rejects top-level unsupported fields on create/update/copy', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    for (const field of ['headers', 'body', 'oauth', 'shell', 'env', 'temperature']) {
      const rejected = await service.createCard(validCreate({ [field]: true }));
      expect(rejected).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    }

    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updateRejected = await service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'X',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt',
      timeoutMs: 60_000,
      maxOutputTokens: 1024,
      headers: { Authorization: 'Bearer x' },
    });
    expect(updateRejected).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    const copyRejected = await service.copyCard({
      userId: 'admin-1',
      sourceCardId: created.card.id,
      oauth: true,
    });
    expect(copyRejected).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('advanced JSON cannot bypass schema restrictions', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);
    const rejected = await service.createCard(validCreate({
      advancedConfig: { headers: { Authorization: 'Bearer x' } },
    }));
    expect(rejected).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('team owner/admin/member fail closed on provider supply APIs', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    for (const userId of ['owner-1', 'member-1'] as const) {
      const list = await service.listCards({ userId });
      expect(list).toMatchObject({ ok: false, error: 'FORBIDDEN' });
      expect(list).not.toHaveProperty('cards');
      expect(JSON.stringify(list)).not.toMatch(/modelId|baseUrl|credentialRef|draftRevision|apiKey/i);

      const create = await service.createCard(validCreate({ userId, apiKey: 'sk-x' }));
      expect(create).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    }
  });

  test('editing a published card creates new draft metadata without mutating published revision', async () => {
    const { repos, service } = createService(createInMemoryRepositories(), { fetch: passingTestFetch() });
    await seedUsers(repos);

    const created = await service.createCard(validCreate({
      preset: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      notes: 'published notes',
      consoleUrl: 'https://platform.deepseek.com',
      apiKey: 'sk-ds',
    }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const tested = await service.runTest({ userId: 'admin-1', cardId: created.card.id });
    expect(tested.ok && tested.test.status === 'passed').toBe(true);
    const publishedResult = await service.publishCard({ userId: 'admin-1', cardId: created.card.id });
    expect(publishedResult.ok).toBe(true);
    const published = await service.getCard({ userId: 'admin-1', cardId: created.card.id });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.card.publishedRevision?.status).toBe('published');
    expect(published.card.publishedRevision?.displayName).toBe('DeepSeek');
    expect(published.card.publishedRevision?.notes).toBe('published notes');
    expect(published.card.draftRevision).toBeNull();
    const publishedRevisionId = published.card.publishedRevision!.id;

    const updated = await service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'DeepSeek edited',
      baseUrl: 'https://api.deepseek.com',
      endpointMode: 'chat_completions',
      modelId: 'deepseek-reasoner',
      timeoutMs: 90_000,
      maxOutputTokens: 4096,
      notes: 'draft notes',
      consoleUrl: 'https://example.com/console',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    // 投影展示当前 Draft 工作视图
    expect(updated.card.displayName).toBe('DeepSeek edited');
    expect(updated.card.notes).toBe('draft notes');
    expect(updated.card.draftRevision?.displayName).toBe('DeepSeek edited');
    expect(updated.card.draftRevision?.notes).toBe('draft notes');
    expect(updated.card.draftRevision?.consoleUrl).toBe('https://example.com/console');
    expect(updated.card.draftRevision?.config.modelId).toBe('deepseek-reasoner');

    // published revision 元数据与配置均不变
    expect(updated.card.publishedRevision?.id).toBe(publishedRevisionId);
    expect(updated.card.publishedRevision?.displayName).toBe('DeepSeek');
    expect(updated.card.publishedRevision?.notes).toBe('published notes');
    expect(updated.card.publishedRevision?.consoleUrl).toBe('https://platform.deepseek.com');
    expect(updated.card.publishedRevision?.config.modelId).toBe('deepseek-chat');

    const storedPublished = await repos.piProvider.revisions.getById(publishedRevisionId);
    expect(storedPublished?.displayName).toBe('DeepSeek');
    expect(storedPublished?.notes).toBe('published notes');
    expect(storedPublished?.config.modelId).toBe('deepseek-chat');
  });

  test('copy creates a new draft card with independent credential ref', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    const created = await service.createCard(validCreate({
      preset: 'openrouter',
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/auto',
      apiKey: 'sk-or',
    }));
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
    expect(JSON.stringify(copied)).not.toContain('sk-or');
  });

  test('credential replace keeps stable credentialRef and never echoes secrets', async () => {
    const { repos, service } = createService();
    await seedUsers(repos);

    const created = await service.createCard(validCreate({ apiKey: 'sk-old' }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const credentialRef = created.card.credential.credentialRef;

    const updated = await service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'Primary OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt-4.1-mini',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
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

  test('memory unit of work rolls back orphan credential/card/revision on mid-write failure', async () => {
    const persistence = createInMemoryPiProviderPersistence();
    const repos = createInMemoryRepositories();
    // 替换为可注入失败的 persistence
    (repos as { piProvider: typeof persistence.repositories }).piProvider = persistence.repositories;
    (repos as { piProviderUnitOfWork: typeof persistence.unitOfWork }).piProviderUnitOfWork = persistence.unitOfWork;
    await seedUsers(repos);

    let seq = 0;
    const service = createPiProviderService({
      repositories: persistence.repositories,
      unitOfWork: persistence.unitOfWork,
      users: repos.users,
      clock: { now: () => 1 },
      ids: { nextId: () => `id-${++seq}` },
      resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    });

    // 第一次写 credential 成功，第二次写 card 失败
    let writes = 0;
    const originalCreate = persistence.repositories.cards.create.bind(persistence.repositories.cards);
    persistence.repositories.cards.create = async (input) => {
      writes += 1;
      if (writes === 1) throw new Error('inject-fail-after-credential');
      return originalCreate(input);
    };

    const failed = await service.createCard(validCreate());
    expect(failed).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
    expect(await persistence.repositories.credentials.getById('id-2')).toBeNull();
    expect(await persistence.repositories.cards.list()).toEqual([]);
    expect(await persistence.repositories.revisions.listByCard('id-1')).toEqual([]);
  });

  test('sqlite unit of work rolls back when revision insert fails after credential/card writes', async () => {
    const db = new Database(':memory:');
    applyGlobalMigrations(db);
    // 需要 users 外键：插入 admin
    db.prepare(`
      INSERT INTO users (id, username, email, display_name, password_hash, role, current_team_id, created_at, updated_at)
      VALUES ('admin-1', 'sysadmin', null, null, 'x', 'admin', null, 1, 1)
    `).run();
    const persistence = createSqlitePiProviderPersistence(db);
    const users = {
      async getById(id: string) {
        if (id !== 'admin-1') return null;
        return {
          id: 'admin-1', username: 'sysadmin', role: 'admin' as const, passwordHash: 'x', createdAt: 1, updatedAt: 1,
        };
      },
    };
    let seq = 0;
    const service = createPiProviderService({
      repositories: persistence.repositories,
      unitOfWork: persistence.unitOfWork,
      users,
      clock: { now: () => 1 },
      ids: { nextId: () => `id-${++seq}` },
      resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    });

    const original = persistence.repositories.revisions.create.bind(persistence.repositories.revisions);
    let revisionCalls = 0;
    persistence.repositories.revisions.create = async (input) => {
      revisionCalls += 1;
      if (revisionCalls === 1) throw new Error('inject-revision-fail');
      return original(input);
    };

    const failed = await service.createCard(validCreate());
    expect(failed).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
    expect(db.prepare('SELECT COUNT(*) AS c FROM pi_provider_credentials').get() as { c: number }).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM pi_provider_cards').get() as { c: number }).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM pi_provider_card_revisions').get() as { c: number }).toEqual({ c: 0 });
    db.close();
  });

  test('sqlite update failure after credential rotate does not leave rotated secret', async () => {
    const db = new Database(':memory:');
    applyGlobalMigrations(db);
    db.prepare(`
      INSERT INTO users (id, username, email, display_name, password_hash, role, current_team_id, created_at, updated_at)
      VALUES ('admin-1', 'sysadmin', null, null, 'x', 'admin', null, 1, 1)
    `).run();
    const persistence = createSqlitePiProviderPersistence(db);
    const users = {
      async getById(id: string) {
        if (id !== 'admin-1') return null;
        return {
          id: 'admin-1', username: 'sysadmin', role: 'admin' as const, passwordHash: 'x', createdAt: 1, updatedAt: 1,
        };
      },
    };
    let seq = 0;
    const service = createPiProviderService({
      repositories: persistence.repositories,
      unitOfWork: persistence.unitOfWork,
      users,
      clock: { now: () => Date.now() },
      ids: { nextId: () => `id-${++seq}` },
      resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    });

    const created = await service.createCard(validCreate({ apiKey: 'sk-old' }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const credentialRef = created.card.credential.credentialRef;
    const before = await persistence.repositories.credentials.getById(credentialRef);

    const original = persistence.repositories.revisions.create.bind(persistence.repositories.revisions);
    persistence.repositories.revisions.create = async () => {
      throw new Error('inject-update-fail');
    };

    const failed = await service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'Primary OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt-4.1-mini',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      apiKey: 'sk-new',
    });
    expect(failed).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });

    const after = await persistence.repositories.credentials.getById(credentialRef);
    expect(after?.encryptedPayload).toBe(before?.encryptedPayload);
    expect(decryptPiProviderApiKey(parseEncryptedSecret(after!.encryptedPayload)!, secretKey())).toBe('sk-old');
    // 恢复以关闭
    persistence.repositories.revisions.create = original;
    db.close();
  });

  test('memory unit of work isolates a failed transaction from a queued successful create', async () => {
    const persistence = createInMemoryPiProviderPersistence();
    const repos = createInMemoryRepositories();
    await seedUsers(repos);

    let seq = 0;
    const service = createPiProviderService({
      repositories: persistence.repositories,
      unitOfWork: persistence.unitOfWork,
      users: repos.users,
      clock: { now: () => 1 },
      ids: { nextId: () => `concurrent-memory-${++seq}` },
      resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    });

    const firstCardWriteStarted = createDeferred();
    const releaseFirstCardWrite = createDeferred();
    const originalCreate = persistence.repositories.cards.create.bind(persistence.repositories.cards);
    let cardCreateCalls = 0;
    persistence.repositories.cards.create = async (input) => {
      cardCreateCalls += 1;
      if (cardCreateCalls === 1) {
        firstCardWriteStarted.resolve();
        await releaseFirstCardWrite.promise;
        throw new Error('fail-first-transaction');
      }
      return originalCreate(input);
    };

    const failedCreate = service.createCard(validCreate({ displayName: 'Failed create' }));
    await firstCardWriteStarted.promise;
    const successfulCreate = service.createCard(validCreate({
      displayName: 'Successful create',
      apiKey: 'sk-successful-create',
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirstCardWrite.resolve();

    const [failed, succeeded] = await Promise.all([failedCreate, successfulCreate]);
    expect(failed).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
    expect(succeeded).toMatchObject({ ok: true });
    const cards = await persistence.repositories.cards.list();
    expect(cards).toHaveLength(1);
    const stored = await service.listCards({ userId: 'admin-1' });
    expect(stored).toMatchObject({
      ok: true,
      cards: [{ displayName: 'Successful create' }],
    });
  });

  test('management reads wait for an in-flight rollback and return the committed snapshot', async () => {
    const persistence = createInMemoryPiProviderPersistence();
    const repos = createInMemoryRepositories();
    await seedUsers(repos);
    let seq = 0;
    const service = createPiProviderService({
      repositories: persistence.repositories,
      unitOfWork: persistence.unitOfWork,
      users: repos.users,
      clock: { now: () => 1 + seq },
      ids: { nextId: () => `read-isolation-${++seq}` },
      resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    });

    const created = await service.createCard(validCreate({
      displayName: 'Committed card',
      apiKey: 'sk-committed',
    }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const failedWriteVisible = createDeferred();
    const releaseFailedWrite = createDeferred();
    const originalUpdate = persistence.repositories.cards.update.bind(persistence.repositories.cards);
    persistence.repositories.cards.update = async (input) => {
      const result = await originalUpdate(input);
      failedWriteVisible.resolve();
      await releaseFailedWrite.promise;
      throw new Error('rollback-after-card-update');
    };

    const failedUpdate = service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'Uncommitted card',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'uncommitted-model',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      apiKey: 'sk-uncommitted',
    });
    await failedWriteVisible.promise;

    let readsSettled = false;
    const reads = Promise.all([
      service.listCards({ userId: 'admin-1' }),
      service.getCard({ userId: 'admin-1', cardId: created.card.id }),
    ]).then((result) => {
      readsSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readsSettled).toBe(false);

    releaseFailedWrite.resolve();
    const [updateResult, [listed, fetched]] = await Promise.all([failedUpdate, reads]);
    expect(updateResult).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
    expect(listed).toMatchObject({ ok: true, cards: [{ displayName: 'Committed card' }] });
    expect(fetched).toMatchObject({ ok: true, card: { displayName: 'Committed card' } });
  });

  test('copy waits for a concurrent update and copies one committed revision and credential snapshot', async () => {
    const persistence = createInMemoryPiProviderPersistence();
    const repos = createInMemoryRepositories();
    await seedUsers(repos);
    let seq = 0;
    const service = createPiProviderService({
      repositories: persistence.repositories,
      unitOfWork: persistence.unitOfWork,
      users: repos.users,
      clock: { now: () => 1 + seq },
      ids: { nextId: () => `copy-isolation-${++seq}` },
      resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    });

    const created = await service.createCard(validCreate({
      displayName: 'Old revision',
      modelId: 'old-model',
      apiKey: 'sk-old-snapshot',
    }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const credentialRotated = createDeferred();
    const releaseUpdate = createDeferred();
    const originalRevisionCreate = persistence.repositories.revisions.create.bind(
      persistence.repositories.revisions,
    );
    let revisionWrites = 0;
    persistence.repositories.revisions.create = async (input) => {
      revisionWrites += 1;
      if (revisionWrites === 1) {
        credentialRotated.resolve();
        await releaseUpdate.promise;
      }
      return originalRevisionCreate(input);
    };

    const update = service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'New revision',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'new-model',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      apiKey: 'sk-new-snapshot',
    });
    await credentialRotated.promise;
    const copy = service.copyCard({ userId: 'admin-1', sourceCardId: created.card.id });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseUpdate.resolve();

    const [updated, copied] = await Promise.all([update, copy]);
    expect(updated).toMatchObject({ ok: true, card: { displayName: 'New revision' } });
    expect(copied).toMatchObject({
      ok: true,
      card: {
        displayName: 'New revision (copy)',
        draftRevision: { config: { modelId: 'new-model' } },
      },
    });
    if (!copied.ok) return;
    const copiedCredential = await persistence.repositories.credentials.getById(
      copied.card.credential.credentialRef,
    );
    expect(decryptPiProviderApiKey(
      parseEncryptedSecret(copiedCredential!.encryptedPayload)!,
      secretKey(),
    )).toBe('sk-new-snapshot');
  });

  test('sqlite unit of work serializes concurrent creates on one connection', async () => {
    const db = new Database(':memory:');
    applyGlobalMigrations(db);
    db.prepare(`
      INSERT INTO users (id, username, email, display_name, password_hash, role, current_team_id, created_at, updated_at)
      VALUES ('admin-1', 'sysadmin', null, null, 'x', 'admin', null, 1, 1)
    `).run();
    const persistence = createSqlitePiProviderPersistence(db);
    const users = {
      async getById(id: string) {
        if (id !== 'admin-1') return null;
        return {
          id: 'admin-1', username: 'sysadmin', role: 'admin' as const, passwordHash: 'x', createdAt: 1, updatedAt: 1,
        };
      },
    };
    let seq = 0;
    const service = createPiProviderService({
      repositories: persistence.repositories,
      unitOfWork: persistence.unitOfWork,
      users,
      clock: { now: () => 1 },
      ids: { nextId: () => `concurrent-sqlite-${++seq}` },
      resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    });

    const firstCredentialWriteStarted = createDeferred();
    const releaseFirstCredentialWrite = createDeferred();
    const originalCreate = persistence.repositories.credentials.create.bind(persistence.repositories.credentials);
    let credentialCreateCalls = 0;
    persistence.repositories.credentials.create = async (input) => {
      const result = await originalCreate(input);
      credentialCreateCalls += 1;
      if (credentialCreateCalls === 1) {
        firstCredentialWriteStarted.resolve();
        await releaseFirstCredentialWrite.promise;
      }
      return result;
    };

    const firstCreate = service.createCard(validCreate({ displayName: 'First concurrent create' }));
    await firstCredentialWriteStarted.promise;
    const secondCreate = service.createCard(validCreate({
      displayName: 'Second concurrent create',
      apiKey: 'sk-second-concurrent-create',
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirstCredentialWrite.resolve();

    const results = await Promise.all([firstCreate, secondCreate]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS c FROM pi_provider_credentials').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM pi_provider_cards').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM pi_provider_card_revisions').get()).toEqual({ c: 2 });
    db.close();
  });

  test('use-case surface lists four presets for system admin only', async () => {
    const repos = createInMemoryRepositories();
    await seedUsers(repos);
    const app = createServerNextUseCases({
      repositories: repos,
      clock: { now: () => Date.now() },
      ids: { nextId: (() => { let n = 0; return () => `uc-${++n}`; })() },
    });

    process.env.AGENTBEAN_PI_SECRET_KEY = SECRET;
    try {
      const forbidden = await app.listPiProviderPresets({ userId: 'owner-1' });
      expect(forbidden).toMatchObject({ ok: false, error: 'FORBIDDEN' });

      const presets = await app.listPiProviderPresets({ userId: 'admin-1' });
      expect(presets.ok).toBe(true);
      if (!presets.ok) return;
      expect(presets.presets.map((p) => p.preset)).toEqual([
        'openai', 'openrouter', 'deepseek', 'custom_openai_compatible',
      ]);

      // 顶层未知字段经 use-case 入口拒绝
      const bad = await app.createPiProviderCard(validCreate({ headers: { a: 1 } }));
      expect(bad).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    } finally {
      delete process.env.AGENTBEAN_PI_SECRET_KEY;
    }
  });
});

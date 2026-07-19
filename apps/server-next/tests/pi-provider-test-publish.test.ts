import { createRequire } from 'node:module';
import { scryptSync } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { createPiProviderService } from '../src/application/pi-provider-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
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

async function seedAdmin(repos: ReturnType<typeof createInMemoryRepositories>) {
  await repos.users.create({
    id: 'admin-1', username: 'sysadmin', role: 'admin', passwordHash: 'x', createdAt: 1, updatedAt: 1,
  });
}

function validCreate(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    preset: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    endpointMode: 'chat_completions',
    modelId: 'gpt-4.1-mini',
    timeoutMs: 60_000,
    maxOutputTokens: 4096,
    apiKey: 'sk-live',
    ...overrides,
  };
}

function createService(options: {
  fetch?: typeof fetch;
  repos?: ReturnType<typeof createInMemoryRepositories>;
} = {}) {
  const repos = options.repos ?? createInMemoryRepositories();
  let seq = 0;
  const service = createPiProviderService({
    repositories: repos.piProvider,
    unitOfWork: repos.piProviderUnitOfWork,
    users: repos.users,
    clock: { now: () => 1_700_000_000_000 + (seq * 10) },
    ids: { nextId: () => `id-${++seq}` },
    resolveSecretKey: () => ({ ok: true, key: secretKey() }),
    fetch: options.fetch,
  });
  return { repos, service };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function passingTestFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4o' }] });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role?: string; tool_calls?: unknown[] }>;
      tools?: unknown[];
    };
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const hasToolResult = body.messages?.some((m) => m.role === 'tool');
    if (hasTools && !hasToolResult) {
      return jsonResponse({
        model: 'gpt-4.1-mini',
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
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }
    if (hasToolResult) {
      return jsonResponse({
        model: 'gpt-4.1-mini',
        choices: [{ message: { role: 'assistant', content: 'DONE' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      });
    }
    return jsonResponse({
      model: 'gpt-4.1-mini',
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
  });
}

describe('PI Provider discover / test / publish', () => {
  test('discover models updates candidates only and never publishes', async () => {
    const { repos, service } = createService({ fetch: passingTestFetch() });
    await seedAdmin(repos);
    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const discovered = await service.discoverModels({
      userId: 'admin-1',
      cardId: created.card.id,
    });
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.discoverySupported).toBe(true);
    expect(discovered.models.map((m) => m.modelId)).toEqual(['gpt-4.1-mini', 'gpt-4o']);

    const card = await service.getCard({ userId: 'admin-1', cardId: created.card.id });
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    expect(card.card.modelCandidates.map((m) => m.modelId)).toEqual(['gpt-4.1-mini', 'gpt-4o']);
    expect(card.card.publishedRevision).toBeNull();
    expect(card.card.draftRevision?.status).toBe('draft');
  });

  test('unsupported discovery still allows manual model id and does not wipe candidates on unsupported response after empty', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('nope', { status: 404 }));
    const { repos, service } = createService({ fetch: fetchFn });
    await seedAdmin(repos);
    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const discovered = await service.discoverModels({
      userId: 'admin-1',
      cardId: created.card.id,
    });
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.discoverySupported).toBe(false);
    expect(discovered.models).toEqual([]);
  });

  test('production-path test passes and binds config summary for publish', async () => {
    const { repos, service } = createService({ fetch: passingTestFetch() });
    await seedAdmin(repos);
    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const tested = await service.runTest({ userId: 'admin-1', cardId: created.card.id });
    expect(tested.ok).toBe(true);
    if (!tested.ok) return;
    expect(tested.test.status).toBe('passed');
    expect(tested.test.textOk).toBe(true);
    expect(tested.test.toolCallOk).toBe(true);
    expect(tested.test.configSummary).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(tested)).not.toContain('sk-live');
    expect(JSON.stringify(tested)).not.toMatch(/probe|Coordinate|systemPrompt/i);
    expect(tested.card.canPublish).toBe(true);

    const published = await service.publishCard({ userId: 'admin-1', cardId: created.card.id });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.card.publishedRevision?.status).toBe('published');
    expect(published.card.publishedRevision?.config.modelId).toBe('gpt-4.1-mini');
    expect(published.card.draftRevision).toBeNull();
    expect(published.card.canPublish).toBe(false);
  });

  test('401 or tool-call failure blocks publish and returns secret-free diagnostics', async () => {
    const authFailFetch = vi.fn<typeof fetch>(async () => new Response('no', { status: 401 }));
    const { repos, service } = createService({ fetch: authFailFetch });
    await seedAdmin(repos);
    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const tested = await service.runTest({ userId: 'admin-1', cardId: created.card.id });
    expect(tested.ok).toBe(true);
    if (!tested.ok) return;
    expect(tested.test.status).toBe('failed');
    expect(tested.test.diagnosticCode).toBe('MANAGEMENT_MODEL_AUTHENTICATION_FAILED');
    expect(tested.card.canPublish).toBe(false);
    expect(JSON.stringify(tested)).not.toContain('sk-live');

    const published = await service.publishCard({ userId: 'admin-1', cardId: created.card.id });
    expect(published).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('config change invalidates old passing test for publish', async () => {
    const { repos, service } = createService({ fetch: passingTestFetch() });
    await seedAdmin(repos);
    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const tested = await service.runTest({ userId: 'admin-1', cardId: created.card.id });
    expect(tested.ok && tested.test.status === 'passed').toBe(true);

    const updated = await service.updateCard({
      userId: 'admin-1',
      cardId: created.card.id,
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions',
      modelId: 'gpt-4o',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.card.canPublish).toBe(false);

    const published = await service.publishCard({ userId: 'admin-1', cardId: created.card.id });
    expect(published).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    expect(String((published as { message?: string }).message)).toMatch(/CONFIG_SUMMARY_MISMATCH|Publish rejected/);
  });

  test('reject unknown fields on discover/test/publish requests', async () => {
    const { repos, service } = createService({ fetch: passingTestFetch() });
    await seedAdmin(repos);
    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    for (const method of ['discoverModels', 'runTest', 'publishCard'] as const) {
      const result = await service[method]({
        userId: 'admin-1',
        cardId: created.card.id,
        headers: { Authorization: 'Bearer x' },
      });
      expect(result).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    }
  });

  test('sqlite path persists candidates, tests, and published revision', async () => {
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
      fetch: passingTestFetch(),
    });

    const created = await service.createCard(validCreate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await service.discoverModels({ userId: 'admin-1', cardId: created.card.id });
    const tested = await service.runTest({ userId: 'admin-1', cardId: created.card.id });
    expect(tested.ok && tested.test.status === 'passed').toBe(true);
    const published = await service.publishCard({ userId: 'admin-1', cardId: created.card.id });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const cardRow = db.prepare('SELECT * FROM pi_provider_cards WHERE id = ?').get(created.card.id) as {
      published_revision_id: string | null;
      draft_revision_id: string | null;
      model_candidates_json: string;
    };
    expect(cardRow.published_revision_id).toBeTruthy();
    expect(cardRow.draft_revision_id).toBeNull();
    expect(JSON.parse(cardRow.model_candidates_json)).toEqual(['gpt-4.1-mini', 'gpt-4o']);

    const testCount = db.prepare('SELECT COUNT(*) AS c FROM pi_provider_revision_tests').get() as { c: number };
    expect(testCount.c).toBe(1);
    const testRow = db.prepare('SELECT * FROM pi_provider_revision_tests LIMIT 1').get() as Record<string, unknown>;
    expect(JSON.stringify(testRow)).not.toContain('sk-live');
    expect(testRow).not.toHaveProperty('prompt');
    expect(testRow).not.toHaveProperty('messages');

    db.close();
  });
});

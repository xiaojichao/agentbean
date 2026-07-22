import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import { createChannelCoordinator, type CoordinatorModelResolver } from '../src/application/channel-coordination-coordinator.js';
import { createInMemoryRepositories } from '../src/index';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories';
import type { ChannelCoordinationJobRecord } from '../../../packages/contracts/src/index.js';

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };
const requireFromWorkspace = createRequire(import.meta.url);
const Database = requireFromWorkspace('better-sqlite3') as BetterSqlite3Constructor;

/** 构造一条合法的 OpenAI Chat Completions 响应（content 为意图 JSON 字符串）。 */
function okResponse(
  content: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null,
) {
  const body: Record<string, unknown> = {
    model: 'pi-test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
  // usage=null → 整个 usage 键省略（provider 不返回 usage → adapter 视为 unknown/null）。
  if (usage !== null) {
    body.usage = usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  }
  return { status: 200, body };
}

type FetchSpec = { status?: number; body?: unknown; reject?: string };

/** 受控 fake fetch：按队列消费响应；空队列抛错（测试要求精确调用次数）。 */
function makeFetch(responses: FetchSpec[]) {
  const queue = [...responses];
  return async () => {
    const spec = queue.shift();
    if (!spec) throw new Error('fake fetch exhausted');
    if (spec.reject) throw new Error(spec.reject);
    const status = spec.status ?? 200;
    const parsed = typeof spec.body === 'string' ? JSON.parse(spec.body) : (spec.body ?? {});
    const bodyText = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => bodyText,
      json: async () => parsed,
    } as unknown as Response;
  };
}

const availableResolver: CoordinatorModelResolver = {
  async resolveInvocationTarget() {
    return {
      kind: 'available',
      config: {
        baseUrl: 'https://pi.example/v1',
        modelId: 'pi-test-model',
        timeoutMs: 5000,
        maxOutputTokens: 256,
      },
      apiKey: 'test-key',
      modelId: 'pi-test-model',
    };
  },
};

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('Test id sequence exhausted');
    return id;
  };
}

interface Setup {
  repos: ReturnType<typeof createInMemoryRepositories>;
  coordinator: ReturnType<typeof createChannelCoordinator>;
}

function setup(input: { fetch?: typeof fetch; resolver?: CoordinatorModelResolver; maxAttempts?: number; now?: number }): Setup {
  const repos = createInMemoryRepositories();
  const coordinator = createChannelCoordinator({
    jobs: repos.channelCoordination.jobs,
    decisions: repos.channelCoordination.decisions,
    unitOfWork: repos.channelCoordinationUnitOfWork,
    messages: repos.messages,
    modelResolver: input.resolver ?? availableResolver,
    clock: { now: () => input.now ?? 1000 },
    ids: { nextId: createIds(['decision-1', 'sysmsg-1', 'decision-2', 'sysmsg-2', 'decision-3', 'sysmsg-3']) },
    fetch: input.fetch,
    maxAttempts: input.maxAttempts,
    baseDelayMs: 100,
  });
  return { repos, coordinator };
}

async function seedHumanMessageJob(
  repos: Setup['repos'],
  input: {
    messageId?: string;
    jobId?: string;
    body?: string;
    activeModel?: ChannelCoordinationJobRecord['activeModel'];
    status?: ChannelCoordinationJobRecord['status'];
    attempt?: number;
  } = {},
): Promise<{ messageId: string; jobId: string }> {
  const messageId = input.messageId ?? 'message-1';
  const jobId = input.jobId ?? 'job-1';
  await repos.messages.append({
    id: messageId,
    teamId: 'team-1',
    channelId: 'channel-1',
    threadId: messageId,
    senderKind: 'human',
    senderId: 'user-1',
    body: input.body ?? '请帮我理解这条消息',
    createdAt: 900,
  });
  await repos.channelCoordination.jobs.create({
    id: jobId,
    teamId: 'team-1',
    channelId: 'channel-1',
    messageId,
    idempotencyKey: `message:team-1:${messageId}`,
    status: input.status ?? 'pending',
    attempt: input.attempt ?? 0,
    nextRetryAt: null,
    activeModel: input.activeModel ?? {
      availability: 'available',
      cardId: 'card-1',
      revisionId: 'revision-1',
      modelId: 'pi-test-model',
    },
    createdAt: 950,
    updatedAt: 950,
  });
  return { messageId, jobId };
}

describe('channel coordinator: happy path intents', () => {
  test('system_reply produces a resolved decision and one system coordination message (AC#2/AC#3)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'system_reply', reasonCode: 'status_ok', text: 'PI 已就绪' }))]),
    });
    const { jobId, messageId } = await seedHumanMessageJob(repos);

    const outcome = await coordinator.processJob(jobId);

    expect(outcome.kind).toBe('resolved');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision).toMatchObject({
      outcome: 'resolved',
      intent: 'system_reply',
      reasonCode: 'status_ok',
      replyText: 'PI 已就绪',
      diagnosticCode: null,
    });
    expect(decision?.systemMessageId).not.toBeNull();

    const sysMessages = (await repos.messages.listByChannel('channel-1', 10))
      .filter((m) => m.senderKind === 'system');
    expect(sysMessages).toHaveLength(1);
    expect(sysMessages[0]).toMatchObject({
      senderKind: 'system',
      senderId: 'pi-coordinator',
      body: 'PI 已就绪',
      threadId: messageId,
    });
    // AC#4：系统消息 meta 只含协调引用，绝不含 provider/model 身份或完整 prompt。
    expect(JSON.stringify(sysMessages[0])).not.toContain('pi-test-model');
    expect(JSON.stringify(sysMessages[0])).not.toContain('test-key');
    expect(JSON.stringify(sysMessages[0])).not.toContain('pi.example');

    const job = await repos.channelCoordination.jobs.getById(jobId);
    expect(job?.status).toBe('completed');
    // 原人类消息仍在（AC#5）。
    expect(await repos.messages.getById(messageId)).not.toBeNull();
  });

  test('clarification_required posts a clarifying system message', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'clarification_required', reasonCode: 'target_unclear', text: '请问你想让哪个 Agent 处理？' }))]),
    });
    const { jobId } = await seedHumanMessageJob(repos);

    const outcome = await coordinator.processJob(jobId);
    expect(outcome.kind).toBe('resolved');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.intent).toBe('clarification_required');
    expect(decision?.replyText).toBe('请问你想让哪个 Agent 处理？');
    expect(decision?.systemMessageId).not.toBeNull();
  });

  test('no_action records a decision but posts NO system message', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'greeting' }))]),
    });
    const { jobId } = await seedHumanMessageJob(repos);

    const outcome = await coordinator.processJob(jobId);
    expect(outcome.kind).toBe('resolved');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.intent).toBe('no_action');
    expect(decision?.systemMessageId).toBeNull();
    expect(decision?.replyText).toBeNull();
    const sysMessages = (await repos.messages.listByChannel('channel-1', 10))
      .filter((m) => m.senderKind === 'system');
    expect(sysMessages).toHaveLength(0);
  });
});

describe('channel coordinator: fail-closed on invalid model output (AC#2/AC#5)', () => {
  test('non-JSON prose output is retried then failed', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse('请理解这条消息'), okResponse('still prose')]),
      maxAttempts: 2,
    });
    const { jobId } = await seedHumanMessageJob(repos);

    const first = await coordinator.processJob(jobId);
    expect(first.kind).toBe('retry_wait');
    const jobAfterRetry = await repos.channelCoordination.jobs.getById(jobId);
    expect(jobAfterRetry?.status).toBe('retry_wait');

    const second = await coordinator.processJob(jobId);
    expect(second.kind).toBe('failed');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.outcome).toBe('failed');
    expect(decision?.diagnosticCode).toBe('MODEL_INVALID_JSON');
    expect(decision?.systemMessageId).toBeNull();
    const finalJob = await repos.channelCoordination.jobs.getById(jobId);
    expect(finalJob?.status).toBe('failed');
  });

  test('an unknown intent fails closed as invalid output', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', text: 'x' })), okResponse(JSON.stringify({ intent: 'tracked_task', text: 'x' }))]),
      maxAttempts: 2,
    });
    const { jobId } = await seedHumanMessageJob(repos);
    await coordinator.processJob(jobId);
    const second = await coordinator.processJob(jobId);
    expect(second.kind).toBe('failed');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.diagnosticCode).toBe('MODEL_INVALID_OUTPUT');
  });
});

describe('channel coordinator: model failure classification (AC#5/AC#6)', () => {
  test('401 is permanent: fails immediately without retry, no side effects', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([{ status: 401, body: { error: 'unauthorized' } }]),
      maxAttempts: 3,
    });
    const { jobId, messageId } = await seedHumanMessageJob(repos);

    const outcome = await coordinator.processJob(jobId);
    expect(outcome.kind).toBe('failed');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.diagnosticCode).toBe('MODEL_AUTH_ERROR');
    // 只调用了一次（永久错误不重试）。
    // AC#6：不建系统消息、不建 Task/Offer/Claim/Memory。
    expect(decision?.systemMessageId).toBeNull();
    const sysMessages = (await repos.messages.listByChannel('channel-1', 10)).filter((m) => m.senderKind === 'system');
    expect(sysMessages).toHaveLength(0);
    // 原消息仍在（AC#5）。
    expect(await repos.messages.getById(messageId)).not.toBeNull();
  });

  test('429 is transient: retries with backoff, then fails exhausted', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([{ status: 429, body: {} }, { status: 429, body: {} }]),
      maxAttempts: 2,
      now: 1000,
    });
    const { jobId } = await seedHumanMessageJob(repos);

    const first = await coordinator.processJob(jobId);
    expect(first.kind).toBe('retry_wait');
    if (first.kind === 'retry_wait') {
      expect(first.nextRetryAt).toBe(1000 + 100); // baseDelay * 2^(1-1) = 100
    }
    const jobMid = await repos.channelCoordination.jobs.getById(jobId);
    expect(jobMid?.status).toBe('retry_wait');
    expect(jobMid?.attempt).toBe(1);

    const second = await coordinator.processJob(jobId);
    expect(second.kind).toBe('failed');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.diagnosticCode).toBe('MODEL_RATE_LIMIT');
  });

  test('5xx is transient and retries', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([
        { status: 503, body: {} },
        okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'ok' })),
      ]),
      maxAttempts: 3,
    });
    const { jobId } = await seedHumanMessageJob(repos);
    const first = await coordinator.processJob(jobId);
    expect(first.kind).toBe('retry_wait');
    const second = await coordinator.processJob(jobId);
    expect(second.kind).toBe('resolved');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.outcome).toBe('resolved');
  });

  test('network failure (fetch rejects) is transient', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([{ reject: 'ECONNRESET' }, { reject: 'ECONNRESET' }]),
      maxAttempts: 2,
    });
    const { jobId } = await seedHumanMessageJob(repos);
    await coordinator.processJob(jobId);
    const second = await coordinator.processJob(jobId);
    expect(second.kind).toBe('failed');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.diagnosticCode).toBe('MODEL_NETWORK_ERROR');
  });
});

describe('channel coordinator: unavailable active model (AC#1/AC#6)', () => {
  test('job pinned unavailable produces a failed decision without calling the model', async () => {
    const fetch_calls: string[] = [];
    const { repos, coordinator } = setup({
      fetch: async () => {
        fetch_calls.push('called');
        return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
      },
    });
    const { jobId } = await seedHumanMessageJob(repos, {
      activeModel: { availability: 'unavailable' },
    });

    const outcome = await coordinator.processJob(jobId);
    expect(outcome.kind).toBe('failed');
    expect(fetch_calls).toHaveLength(0);
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.diagnosticCode).toBe('ACTIVE_MODEL_UNAVAILABLE');
    expect(decision?.pinnedModel).toEqual({ availability: 'unavailable' });
  });

  test('resolver reports unavailable (credential/revision invalid) fails closed', async () => {
    const resolver: CoordinatorModelResolver = {
      async resolveInvocationTarget() {
        return { kind: 'unavailable', diagnosticCode: 'PI_ACTIVE_MODEL_CREDENTIAL_UNAVAILABLE' };
      },
    };
    const { repos, coordinator } = setup({ resolver });
    const { jobId } = await seedHumanMessageJob(repos);
    const outcome = await coordinator.processJob(jobId);
    expect(outcome.kind).toBe('failed');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.diagnosticCode).toBe('PI_ACTIVE_MODEL_CREDENTIAL_UNAVAILABLE');
  });
});

describe('channel coordinator: idempotency (AC#7)', () => {
  test('reprocessing a completed job does not create a second decision or system message', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'system_reply', reasonCode: 'ok', text: '回复' }))]),
    });
    const { jobId } = await seedHumanMessageJob(repos);

    await coordinator.processJob(jobId);
    // 模拟重启/重复消费：再次 processJob 应幂等返回已有 decision。
    const second = await coordinator.processJob(jobId);
    expect(second.kind).toBe('already_decided');

    const decisions = (await repos.channelCoordination.jobs.listByChannel('channel-1', 10))
      ?.[0] ? [await repos.channelCoordination.decisions.getByJobId(jobId)] : [];
    expect(decisions.filter(Boolean)).toHaveLength(1);
    const sysMessages = (await repos.messages.listByChannel('channel-1', 10)).filter((m) => m.senderKind === 'system');
    expect(sysMessages).toHaveLength(1);
  });

  test('runCoordinationCycle twice does not duplicate work', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'ok' }))]),
    });
    await seedHumanMessageJob(repos);

    const first = await coordinator.runCoordinationCycle({ now: 1000 });
    expect(first.processed).toBe(1);
    const second = await coordinator.runCoordinationCycle({ now: 1000 });
    expect(second.processed).toBe(0); // 已 completed，不再 runnable
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision).not.toBeNull();
  });

  test('a failed job is terminal and skipped on replay', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([{ status: 401, body: {} }]),
    });
    const { jobId } = await seedHumanMessageJob(repos);
    await coordinator.processJob(jobId);
    const replay = await coordinator.processJob(jobId);
    expect(replay.kind).toBe('already_decided');
  });
});

describe('channel coordinator: token usage (AC#8)', () => {
  test('records provider-returned usage; missing usage becomes unknown (null)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([
        okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'ok' }), {
          prompt_tokens: 42,
          completion_tokens: 7,
          total_tokens: 49,
        }),
      ]),
    });
    const { jobId } = await seedHumanMessageJob(repos);
    await coordinator.processJob(jobId);
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  test('usage omitted by provider is stored as null (unknown)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'ok' }), null)]),
    });
    const { jobId } = await seedHumanMessageJob(repos);
    await coordinator.processJob(jobId);
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  test('system message and decision never leak provider/model identity to Team view', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'system_reply', reasonCode: 'ok', text: '可见回复' }))]),
    });
    const { jobId } = await seedHumanMessageJob(repos);
    await coordinator.processJob(jobId);

    const sysMessages = (await repos.messages.listByChannel('channel-1', 10)).filter((m) => m.senderKind === 'system');
    const serialized = JSON.stringify(sysMessages);
    expect(serialized).not.toContain('pi-test-model');
    expect(serialized).not.toContain('test-key');
    expect(serialized).not.toContain('pi.example');
    expect(serialized).not.toContain('card-1');
    // Decision 是服务端内部记录（含 responseModel 用于诊断），但绝不应出现在 Team 可见消息里。
    expect(sysMessages[0]?.body).toBe('可见回复');
  });
});

describe('channel coordinator: cycle processing', () => {
  test('processes multiple runnable jobs serially and respects retry_wait timing', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([
        okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'a' })),
        okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'b' })),
      ]),
    });
    await seedHumanMessageJob(repos, { messageId: 'message-1', jobId: 'job-1' });
    await seedHumanMessageJob(repos, { messageId: 'message-2', jobId: 'job-2' });

    const summary = await coordinator.runCoordinationCycle({ now: 1000 });
    expect(summary.processed).toBe(2);
    expect(summary.outcomes.every((o) => o.kind === 'resolved')).toBe(true);
    expect(await repos.channelCoordination.decisions.getByJobId('job-1')).not.toBeNull();
    expect(await repos.channelCoordination.decisions.getByJobId('job-2')).not.toBeNull();
  });

  test('retry_wait job whose nextRetryAt is in the future is not runnable yet', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([{ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }]),
      maxAttempts: 3,
      now: 1000,
    });
    const { jobId } = await seedHumanMessageJob(repos);
    await coordinator.processJob(jobId); // → retry_wait, nextRetryAt = 1100
    const summary = await coordinator.runCoordinationCycle({ now: 1050 });
    expect(summary.processed).toBe(0); // 未到期
    const summary2 = await coordinator.runCoordinationCycle({ now: 1100 });
    expect(summary2.processed).toBe(1); // 到期
  });
});

describe('channel coordinator: SQLite persistence (migration 0026)', () => {
  test('persists decision + system message in the real team DB; UNIQUE(job_id) enforces idempotency', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      const repos = createSqliteRepositories({ globalDb, teamDb });
      // 决策表存在（migration 0026 已跑）。
      expect(
        teamDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_coordination_decisions'").get(),
      ).toBeTruthy();

      await repos.messages.append({
        id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
        senderKind: 'human', senderId: 'user-1', body: 'SQLite 理解测试', createdAt: 900,
      });
      await repos.channelCoordination.jobs.create({
        id: 'job-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
        idempotencyKey: 'message:team-1:message-1', status: 'pending', attempt: 0, nextRetryAt: null,
        activeModel: { availability: 'available', cardId: 'card-1', revisionId: 'revision-1', modelId: 'pi-test-model' },
        createdAt: 950, updatedAt: 950,
      });
      const coordinator = createChannelCoordinator({
        jobs: repos.channelCoordination.jobs,
        decisions: repos.channelCoordination.decisions,
        unitOfWork: repos.channelCoordinationUnitOfWork,
        messages: repos.messages,
        modelResolver: availableResolver,
        clock: { now: () => 1000 },
        ids: { nextId: createIds(['decision-1', 'sysmsg-1']) },
        fetch: makeFetch([okResponse(JSON.stringify({ intent: 'system_reply', reasonCode: 'ok', text: 'SQLite 回复' }))]),
        baseDelayMs: 100,
      });

      const outcome = await coordinator.processJob('job-1');
      expect(outcome.kind).toBe('resolved');

      // 决策行落库，字段正确。
      const row = teamDb.prepare('SELECT * FROM channel_coordination_decisions WHERE job_id = ?').get('job-1') as Record<string, unknown>;
      expect(row).toMatchObject({
        outcome: 'resolved',
        intent: 'system_reply',
        reason_code: 'ok',
        reply_text: 'SQLite 回复',
        usage_input: 10,
        usage_output: 5,
        diagnostic_code: null,
      });
      expect(row?.system_message_id).not.toBeNull();
      // 系统消息落库。
      const sysRow = teamDb.prepare('SELECT * FROM messages WHERE id = ?').get(row?.system_message_id) as Record<string, unknown>;
      expect(sysRow).toMatchObject({ sender_kind: 'system', sender_id: 'pi-coordinator', body: 'SQLite 回复' });
      // Team 视图（系统消息）不含 provider/model 身份。
      expect(JSON.stringify(sysRow)).not.toContain('pi-test-model');
      expect(JSON.stringify(sysRow)).not.toContain('card-1');

      // UNIQUE(job_id)：再插同 job_id 决策必须失败（幂等硬兜底）。
      expect(() =>
        teamDb.prepare('INSERT INTO channel_coordination_decisions (id, job_id, team_id, channel_id, message_id, outcome, attempt, active_model_availability, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('dup', 'job-1', 'team-1', 'channel-1', 'message-1', 'failed', 1, 'unavailable', 'dup', 1, 1),
      ).toThrow();

      // 重放幂等：再次 processJob 返回 already_decided，不新增行。
      const replay = await coordinator.processJob('job-1');
      expect(replay.kind).toBe('already_decided');
      expect(teamDb.prepare('SELECT COUNT(*) AS count FROM channel_coordination_decisions').get()).toEqual({ count: 1 });
      expect(teamDb.prepare('SELECT COUNT(*) AS count FROM messages WHERE sender_kind = ?').get('system')).toEqual({ count: 1 });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });
});

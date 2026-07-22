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
import type {
  AgentStatus,
  ChannelCoordinationJobRecord,
  CoordinationSystemMessageMeta,
  MessageMetaDto,
} from '../../../packages/contracts/src/index.js';

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

function invalidToolCallResponse() {
  return {
    status: 200,
    body: {
      model: 'pi-test-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'pi_coordinate', arguments: '{' } }],
        },
        finish_reason: 'tool_calls',
      }],
    },
  };
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

function setup(input: {
  fetch?: typeof fetch;
  resolver?: CoordinatorModelResolver;
  maxAttempts?: number;
  now?: number;
  processingTimeoutMs?: number;
}): Setup {
  const repos = createInMemoryRepositories();
  const coordinator = createChannelCoordinator({
    jobs: repos.channelCoordination.jobs,
    decisions: repos.channelCoordination.decisions,
    unitOfWork: repos.channelCoordinationUnitOfWork,
    messages: repos.messages,
    channels: repos.channels,
    teams: repos.teams,
    agents: repos.agents,
    teamPolicy: repos.teamPiPolicy,
    modelResolver: input.resolver ?? availableResolver,
    clock: { now: () => input.now ?? 1000 },
    ids: { nextId: createIds(['decision-1', 'sysmsg-1', 'task-1', 'decision-2', 'sysmsg-2', 'task-2', 'decision-3', 'sysmsg-3', 'task-3', 'decision-4', 'sysmsg-4', 'task-4']) },
    fetch: input.fetch,
    maxAttempts: input.maxAttempts,
    baseDelayMs: 100,
    processingTimeoutMs: input.processingTimeoutMs,
  });
  return { repos, coordinator };
}

async function seedAccessContext(repos: Setup['repos']): Promise<void> {
  if (!(await repos.users.getById('user-1'))) {
    await repos.users.create({
      id: 'user-1', username: 'alice', role: 'user', passwordHash: 'x', createdAt: 1, updatedAt: 1,
    });
  }
  if (!(await repos.teams.getById('team-1'))) {
    await repos.teams.create({
      id: 'team-1', name: 'Team 1', path: 'team-1', visibility: 'private', ownerId: 'user-1', createdAt: 1,
    });
  }
  if (!(await repos.teams.isMember('team-1', 'user-1'))) {
    await repos.teams.addMember({
      teamId: 'team-1', userId: 'user-1', username: 'alice', role: 'owner', joinedAt: 1,
    });
  }
  if (!(await repos.channels.getById('channel-1'))) {
    await repos.channels.create({
      id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public',
      createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: [],
    });
  }
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
  await seedAccessContext(repos);
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

    const second = await coordinator.processJob(jobId, 1100);
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
    const second = await coordinator.processJob(jobId, 1100);
    expect(second.kind).toBe('failed');
    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.diagnosticCode).toBe('MODEL_INVALID_OUTPUT');
  });

  test('an invalid tool call uses the bounded invalid-output retry policy', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([invalidToolCallResponse(), invalidToolCallResponse()]),
      maxAttempts: 2,
    });
    const { jobId } = await seedHumanMessageJob(repos);

    expect((await coordinator.processJob(jobId)).kind).toBe('retry_wait');
    expect((await coordinator.processJob(jobId, 1100)).kind).toBe('failed');
    expect((await repos.channelCoordination.decisions.getByJobId(jobId))?.diagnosticCode)
      .toBe('MODEL_INVALID_OUTPUT');
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

    expect((await coordinator.processJob(jobId, 1050)).kind).toBe('not_runnable');
    const second = await coordinator.processJob(jobId, 1100);
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
    const second = await coordinator.processJob(jobId, 1100);
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
    const second = await coordinator.processJob(jobId, 1100);
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
  test('concurrent consumers atomically claim a job and call the model only once', async () => {
    let fetchCalls = 0;
    const { repos, coordinator } = setup({
      fetch: async () => {
        fetchCalls += 1;
        return makeFetch([okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'ok' }))])();
      },
    });
    const { jobId } = await seedHumanMessageJob(repos);

    const outcomes = await Promise.all([
      coordinator.processJob(jobId),
      coordinator.processJob(jobId),
    ]);

    expect(fetchCalls).toBe(1);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['not_runnable', 'resolved']);
    expect(await repos.channelCoordination.decisions.getByJobId(jobId)).not.toBeNull();
  });

  test('a stale running job is reclaimed after its processing lease expires', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'no_action', reasonCode: 'recovered' }))]),
      now: 1000,
      processingTimeoutMs: 25,
    });
    const { jobId } = await seedHumanMessageJob(repos, { status: 'running', attempt: 1 });

    const outcome = await coordinator.processJob(jobId);

    expect(outcome.kind).toBe('resolved');
    expect((await repos.channelCoordination.decisions.getByJobId(jobId))?.attempt).toBe(2);
  });

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

describe('channel coordinator: decision gate (#707)', () => {
  test('tracked_task auto-on + low-risk → applied: creates a Task and links it', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'needs_tracking', risk: 'low', objective: '交付周报' }))]),
    });
    const { jobId } = await seedHumanMessageJob(repos);

    const outcome = await coordinator.processJob(jobId);
    expect(outcome.kind).toBe('resolved');

    const decision = await repos.channelCoordination.decisions.getByJobId(jobId);
    expect(decision?.gateStatus).toBe('applied');
    expect(decision?.riskLevel).toBe('low');
    expect(decision?.objective).toBe('交付周报');
    expect(decision?.linkedTaskId).not.toBeNull();

    const task = await repos.tasks.getById(decision!.linkedTaskId!);
    expect(task?.title).toBe('交付周报');
    expect(task?.teamId).toBe('team-1');
    // 系统消息说明已创建，且不含 CoT/model 身份。
    const sys = (await repos.messages.listByChannel('channel-1', 10)).find((m) => m.senderKind === 'system');
    expect(sys?.body).toContain('已创建跟踪任务');
    expect(JSON.stringify(sys)).not.toContain('pi-test-model');
  });

  test('tracked_task auto-OFF + low-risk + no explicit target → suggested: no Task created (AC#5)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'r', risk: 'low', objective: '交付周报' }))]),
    });
    await seedHumanMessageJob(repos);
    await repos.teamPiPolicy.setAutoCoordination({ teamId: 'team-1', enabled: false, actorId: 'user-1', now: 1000 });

    const outcome = await coordinator.processJob('job-1');
    expect(outcome.kind).toBe('resolved');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('suggested');
    expect(decision?.linkedTaskId).toBeNull();
    const tasks = await repos.tasks.list({ teamId: 'team-1', channelIds: ['channel-1'], includeGlobal: false });
    expect(tasks).toHaveLength(0);
    const sys = (await repos.messages.listByChannel('channel-1', 10)).find((m) => m.senderKind === 'system');
    expect(sys?.body).toContain('PI 建议');
  });

  test('high-risk tracked_task is always blocked even with auto-on (AC#7)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'r', risk: 'high', objective: '删除生产数据库' }))]),
    });
    await seedHumanMessageJob(repos);

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('blocked');
    expect(decision?.blockingReason).toBe('HIGH_RISK_REQUIRES_CONFIRMATION');
    expect(decision?.linkedTaskId).toBeNull();
    const tasks = await repos.tasks.list({ teamId: 'team-1', channelIds: ['channel-1'], includeGlobal: false });
    expect(tasks).toHaveLength(0);
    const sys = (await repos.messages.listByChannel('channel-1', 10)).find((m) => m.senderKind === 'system');
    expect(sys?.body).toContain('已拦截');
  });

  test('explicit @Agent with auto-OFF is not silenced → applied + targetAgentId resolved (AC#6)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'agent_request', reasonCode: 'code', risk: 'low', objective: '重构 X', targetAgentName: 'Codex' }))]),
    });
    await seedAccessContext(repos);
    await repos.agents.upsert({
      id: 'agent-codex', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Codex',
      adapterKind: 'codex', category: 'executor-hosted', source: 'scanned', status: 'offline', lastSeenAt: 1,
    });
    await repos.channels.update({
      channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-codex'], updatedAt: 2 },
    });
    // 人类消息显式 @Codex（agent 提及）。
    await repos.messages.append({
      id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
      senderKind: 'human', senderId: 'user-1', body: '@Codex 重构 X', createdAt: 900,
      meta: { mentions: [{ id: 'agent-codex', kind: 'agent', name: 'Codex', start: 0, end: 6 }] },
    });
    await repos.channelCoordination.jobs.create({
      id: 'job-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      idempotencyKey: 'message:team-1:message-1', status: 'pending', attempt: 0, nextRetryAt: null,
      activeModel: { availability: 'available', cardId: 'card-1', revisionId: 'revision-1', modelId: 'pi-test-model' },
      createdAt: 950, updatedAt: 950,
    });
    await repos.teamPiPolicy.setAutoCoordination({ teamId: 'team-1', enabled: false, actorId: 'user-1', now: 1000 });

    const outcome = await coordinator.processJob('job-1');
    expect(outcome.kind).toBe('resolved');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('applied'); // 不被开关吞
    expect(decision?.targetAgentId).toBe('agent-codex');
    expect(decision?.linkedTaskId).not.toBeNull();
  });

  test('server elevates an obviously destructive objective even when the model reports low risk', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({
        intent: 'tracked_task', reasonCode: 'unsafe', risk: 'low', objective: '删除生产数据库',
      }))]),
    });
    await seedHumanMessageJob(repos);

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.riskLevel).toBe('high');
    expect(decision?.gateStatus).toBe('blocked');
    expect(decision?.linkedTaskId).toBeNull();
  });

  test('archiving the channel before consumption blocks replies and emits no new system message', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'system_reply', reasonCode: 'late', text: '迟到回复' }))]),
    });
    await seedHumanMessageJob(repos);
    await repos.channels.archive({ channelId: 'channel-1', timestamp: 999 });

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('blocked');
    expect(decision?.blockingReason).toBe('CHANNEL_ARCHIVED');
    expect((await repos.messages.listByChannel('channel-1', 10)).filter((m) => m.senderKind === 'system')).toHaveLength(0);
  });

  test('revoked sender permission blocks a queued side effect', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({
        intent: 'tracked_task', reasonCode: 'queued', risk: 'low', objective: '交付周报',
      }))]),
    });
    await seedHumanMessageJob(repos);
    await repos.teams.removeMember({ teamId: 'team-1', userId: 'user-1' });

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('blocked');
    expect(decision?.blockingReason).toBe('SENDER_NOT_AUTHORIZED');
    expect(decision?.linkedTaskId).toBeNull();
  });

  test('a direct-channel Agent removal is authoritative even when dmTargetAgentId remains', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({
        intent: 'agent_request', reasonCode: 'targeted', risk: 'low', objective: '重构 X', targetAgentName: 'Codex',
      }))]),
    });
    await seedHumanMessageJob(repos);
    await repos.agents.upsert({
      id: 'agent-removed', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Codex',
      adapterKind: 'codex', category: 'executor-hosted', source: 'scanned', status: 'offline', lastSeenAt: 1,
    });
    await repos.channels.delete({ channelId: 'channel-1' });
    await repos.channels.create({
      id: 'channel-1', teamId: 'team-1', kind: 'direct', name: 'dm-codex', visibility: 'private',
      createdBy: 'user-1', createdAt: 2, humanMemberIds: ['user-1'], agentMemberIds: [],
      dmTargetAgentId: 'agent-removed', dmOwnerUserId: 'user-1',
    });
    await repos.messages.updateMeta({
      messageId: 'message-1',
      meta: { mentions: [{ id: 'agent-removed', kind: 'agent', name: 'Codex', start: 0, end: 6 }] },
    });

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('blocked');
    expect(decision?.blockingReason).toBe('TARGET_AGENT_OUT_OF_SCOPE');
    expect(decision?.linkedTaskId).toBeNull();
  });

  test('task_followup applied posts a system note and creates no Task', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'r', risk: 'low', objective: '更新进度' }))]),
    });
    await seedHumanMessageJob(repos);
    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('applied');
    expect(decision?.linkedTaskId).toBeNull();
    const sys = (await repos.messages.listByChannel('channel-1', 10)).find((m) => m.senderKind === 'system');
    expect(sys?.body).toContain('已记录任务跟进');
  });

  test('decision audit fields are populated and system message carries no chain-of-thought', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'needs_tracking', risk: 'low', objective: '交付周报', text: '一些模型解释性文本不应进入审计' }))]),
    });
    await seedHumanMessageJob(repos);
    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    // 审计字段存在；reasonCode 是短码，objective 是结构化目标。
    expect(decision?.reasonCode).toBe('needs_tracking');
    expect(decision?.objective).toBe('交付周报');
    const sys = (await repos.messages.listByChannel('channel-1', 10)).find((m) => m.senderKind === 'system');
    // 系统消息正文是「已创建跟踪任务」前缀 + objective，不含模型的解释性 text。
    expect(sys?.body).not.toContain('不应进入审计');
  });

  test('task_followup supersedes the prior tracked_task decision for the same thread task (AC#8 superseded)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([
        okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'needs_tracking', risk: 'low', objective: '交付周报' })),
        okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'progress', risk: 'low', objective: '更新进度' })),
      ]),
    });
    // M1 → tracked_task D1（创建 task T，关联 M1）
    await seedHumanMessageJob(repos, { messageId: 'message-1', jobId: 'job-1', body: '帮我交付周报' });
    await coordinator.processJob('job-1');
    const d1 = await repos.channelCoordination.decisions.getByJobId('job-1');
    const taskId = d1?.linkedTaskId;
    expect(taskId).not.toBeNull();
    expect(d1?.supersededByDecisionId).toBeNull();

    // M2（同线程 message-1）→ task_followup D2
    await repos.messages.append({
      id: 'message-2', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
      senderKind: 'human', senderId: 'user-1', body: '进度更新', createdAt: 910,
    });
    await repos.channelCoordination.jobs.create({
      id: 'job-2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-2',
      idempotencyKey: 'message:team-1:message-2', status: 'pending', attempt: 0, nextRetryAt: null,
      activeModel: { availability: 'available', cardId: 'card-1', revisionId: 'revision-1', modelId: 'pi-test-model' },
      createdAt: 920, updatedAt: 920,
    });
    await coordinator.processJob('job-2');

    const d2 = await repos.channelCoordination.decisions.getByJobId('job-2');
    expect(d2?.intent).toBe('task_followup');
    expect(d2?.linkedTaskId).toBe(taskId); // D2 关联到同 Task
    // D1 被标记为被 D2 取代（AC#8 superseded 状态可审计）
    const d1After = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(d1After?.supersededByDecisionId).toBe(d2?.id);
    // follow-up 消息也被关联到该 Task
    const m2 = await repos.messages.getById('message-2');
    expect(m2?.meta?.taskId).toBe(taskId);
  });
});

describe('channel coordinator: SQLite persistence (migration 0026)', () => {
  test('atomically claims a pending job only once across concurrent consumers', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      const repos = createSqliteRepositories({ globalDb, teamDb });
      await seedAccessContext(repos);
      await repos.messages.append({
        id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
        senderKind: 'human', senderId: 'user-1', body: '并发抢占测试', createdAt: 900,
      });
      await repos.channelCoordination.jobs.create({
        id: 'job-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
        idempotencyKey: 'message:team-1:message-1', status: 'pending', attempt: 0, nextRetryAt: null,
        activeModel: { availability: 'unavailable' }, createdAt: 950, updatedAt: 950,
      });

      const claims = await Promise.all([
        repos.channelCoordination.jobs.claimForProcessing({ jobId: 'job-1', now: 1000, runningBefore: 0 }),
        repos.channelCoordination.jobs.claimForProcessing({ jobId: 'job-1', now: 1000, runningBefore: 0 }),
      ]);

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)).toMatchObject({ status: 'running', attempt: 1 });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });

  test('persists decision + system message in the real team DB; UNIQUE(job_id) enforces idempotency', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      const repos = createSqliteRepositories({ globalDb, teamDb });
      await seedAccessContext(repos);
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
        channels: repos.channels,
        teams: repos.teams,
        agents: repos.agents,
        teamPolicy: repos.teamPiPolicy,
        modelResolver: availableResolver,
        clock: { now: () => 1000 },
        ids: { nextId: createIds(['decision-1', 'sysmsg-1', 'task-1']) },
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

  test('task_followup marks the prior tracked_task decision superseded_by_decision_id in SQLite (AC#8)', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      expect(teamDb.prepare("SELECT 1 FROM pragma_table_info('channel_coordination_decisions') WHERE name='superseded_by_decision_id'").get()).toBeTruthy();
      const repos = createSqliteRepositories({ globalDb, teamDb });
      // 增强门禁需要 channel/team/成员访问上下文（tracked_task applied 的前置）。
      await repos.users.create({ id: 'user-1', username: 'alice', role: 'user', passwordHash: 'x', createdAt: 1, updatedAt: 1 });
      await repos.teams.create({ id: 'team-1', name: 'Team 1', path: 'team-1', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
      await repos.teams.addMember({ teamId: 'team-1', userId: 'user-1', username: 'alice', role: 'owner', joinedAt: 1 });
      await repos.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: [] });
      const coordinator = createChannelCoordinator({
        jobs: repos.channelCoordination.jobs,
        decisions: repos.channelCoordination.decisions,
        unitOfWork: repos.channelCoordinationUnitOfWork,
        messages: repos.messages,
        channels: repos.channels,
        teams: repos.teams,
        agents: repos.agents,
        tasks: repos.tasks,
        teamPolicy: repos.teamPiPolicy,
        modelResolver: availableResolver,
        clock: { now: () => 1000 },
        ids: { nextId: createIds(['decision-1', 'sysmsg-1', 'task-1', 'decision-2', 'sysmsg-2']) },
        fetch: makeFetch([
          okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'needs_tracking', risk: 'low', objective: '交付周报' })),
          okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'progress', risk: 'low', objective: '更新进度' })),
        ]),
        baseDelayMs: 100,
      });
      await repos.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1', senderKind: 'human', senderId: 'user-1', body: '交付周报', createdAt: 900 });
      await repos.channelCoordination.jobs.create({ id: 'job-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1', idempotencyKey: 'message:team-1:message-1', status: 'pending', attempt: 0, nextRetryAt: null, activeModel: { availability: 'available', cardId: 'card-1', revisionId: 'revision-1', modelId: 'pi-test-model' }, createdAt: 950, updatedAt: 950 });
      await coordinator.processJob('job-1');
      const taskId = (await repos.channelCoordination.decisions.getByJobId('job-1'))?.linkedTaskId;

      await repos.messages.append({ id: 'message-2', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1', senderKind: 'human', senderId: 'user-1', body: '进度更新', createdAt: 910 });
      await repos.channelCoordination.jobs.create({ id: 'job-2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-2', idempotencyKey: 'message:team-1:message-2', status: 'pending', attempt: 0, nextRetryAt: null, activeModel: { availability: 'available', cardId: 'card-1', revisionId: 'revision-1', modelId: 'pi-test-model' }, createdAt: 960, updatedAt: 960 });
      await coordinator.processJob('job-2');

      expect(taskId).not.toBeNull();
      const d1 = teamDb.prepare('SELECT superseded_by_decision_id AS s FROM channel_coordination_decisions WHERE job_id = ?').get('job-1') as { s: string | null };
      const d2Id = (await repos.channelCoordination.decisions.getByJobId('job-2'))?.id;
      expect(d1.s).toBe(d2Id); // D1 被 D2 取代
      const d2 = teamDb.prepare('SELECT linked_task_id AS t FROM channel_coordination_decisions WHERE job_id = ?').get('job-2') as { t: string | null };
      expect(d2.t).toBe(taskId); // D2 关联到同 Task
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });
});

describe('channel coordinator: system message meta + target anomaly (#708)', () => {
  /** 构造一条显式 @Codex 的人类消息 + Job；agent 可见性/状态可配。 */
  async function seedAgentRequestJob(
    repos: Setup['repos'],
    options: {
      status?: AgentStatus;
      visibleTeamIds?: string[];
      body?: string;
      autoOff?: boolean;
    } = {},
  ): Promise<{ jobId: string }> {
    await seedAccessContext(repos);
    await repos.agents.upsert({
      id: 'agent-codex', primaryTeamId: 'team-1',
      visibleTeamIds: options.visibleTeamIds ?? ['team-1'],
      name: 'Codex', adapterKind: 'codex', category: 'executor-hosted', source: 'scanned',
      status: options.status ?? 'online', lastSeenAt: 1,
    });
    await repos.channels.update({
      channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-codex'], updatedAt: 2 },
    });
    await repos.messages.append({
      id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
      senderKind: 'human', senderId: 'user-1', body: options.body ?? '@Codex 重构 X', createdAt: 900,
      meta: { mentions: [{ id: 'agent-codex', kind: 'agent', name: 'Codex', start: 0, end: 6 }] },
    });
    await repos.channelCoordination.jobs.create({
      id: 'job-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      idempotencyKey: 'message:team-1:message-1', status: 'pending', attempt: 0, nextRetryAt: null,
      activeModel: { availability: 'available', cardId: 'card-1', revisionId: 'revision-1', modelId: 'pi-test-model' },
      createdAt: 950, updatedAt: 950,
    });
    if (options.autoOff) {
      await repos.teamPiPolicy.setAutoCoordination({ teamId: 'team-1', enabled: false, actorId: 'user-1', now: 1000 });
    }
    return { jobId: 'job-1' };
  }

  function coordMeta(msg: { meta?: MessageMetaDto } | null | undefined): CoordinationSystemMessageMeta | null {
    const coordination = msg?.meta?.coordination;
    return (coordination as CoordinationSystemMessageMeta | undefined) ?? null;
  }

  async function lastSystemMessage(repos: Setup['repos']) {
    const msgs = await repos.messages.listByChannel('channel-1', 50);
    const systems = msgs.filter((m) => m.senderKind === 'system');
    return systems.length > 0 ? systems[systems.length - 1] : null;
  }

  test('applied tracked_task 系统消息 meta.coordination.taskId 匹配 linkedTaskId (AC#4)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'needs_tracking', risk: 'low', objective: '交付周报' }))]),
    });
    await seedHumanMessageJob(repos);

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.linkedTaskId).not.toBeNull();

    const sys = await lastSystemMessage(repos);
    const meta = coordMeta(sys);
    expect(meta?.taskId).toBe(decision?.linkedTaskId);
    expect(meta?.intent).toBe('tracked_task');
    expect(meta?.gateStatus).toBe('applied');
    // meta 绝不泄漏 provider/model 身份（AC#4）。
    expect(JSON.stringify(sys)).not.toContain('pi-test-model');
    expect(JSON.stringify(sys)).not.toContain('test-key');
  });

  test('applied agent_request 离线目标：保持 applied + 建 Task + meta 携带离线状态与请求决定 (AC#5 case b, 约束3)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'agent_request', reasonCode: 'code', risk: 'low', objective: '重构 X', targetAgentName: 'Codex' }))]),
    });
    await seedAgentRequestJob(repos, { status: 'offline', autoOff: true });

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    // 硬目标不被吞：离线仍 applied 并建 Task。
    expect(decision?.gateStatus).toBe('applied');
    expect(decision?.linkedTaskId).not.toBeNull();

    const sys = await lastSystemMessage(repos);
    const meta = coordMeta(sys);
    expect(meta?.targetStatus).toBe('offline');
    expect(meta?.targetAgentId).toBe('agent-codex');
    expect(meta?.action).toBe('confirm_offline_target');
    expect(meta?.taskId).toBe(decision?.linkedTaskId);
    expect(sys?.body).toContain('不可用');
    expect(sys?.body).toContain('Codex');
  });

  test('applied agent_request 在线目标：action 为 null，普通记录正文', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'agent_request', reasonCode: 'code', risk: 'low', objective: '重构 X', targetAgentName: 'Codex' }))]),
    });
    await seedAgentRequestJob(repos, { status: 'online' });

    await coordinator.processJob('job-1');
    const sys = await lastSystemMessage(repos);
    const meta = coordMeta(sys);
    expect(meta?.targetStatus).toBe('online');
    expect(meta?.action).toBeNull();
    expect(sys?.body).toContain('已记录 Agent 请求');
  });

  test('blocked 目标不在频道作用域：无 Task，正文说明请求用户决定 (AC#5 case a)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'agent_request', reasonCode: 'code', risk: 'low', objective: '重构 X', targetAgentName: 'Codex' }))]),
    });
    // agent 在 channel（mention 通过 sanitize）但 visibleTeamIds 不含本 team → targetScopeValid=false。
    await seedAgentRequestJob(repos, { status: 'online', visibleTeamIds: [] });

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('blocked');
    expect(decision?.blockingReason).toBe('TARGET_AGENT_OUT_OF_SCOPE');
    expect(decision?.linkedTaskId).toBeNull();

    const sys = await lastSystemMessage(repos);
    const meta = coordMeta(sys);
    expect(meta?.taskId).toBeNull();
    expect(meta?.action).toBe('specify_target');
    expect(sys?.body).toContain('不在当前频道');
  });

  test('blocked 无法确认目标（显式 @ 但名称不匹配）：meta 保留模型给的名 + 请求指定 (AC#5 case c)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'agent_request', reasonCode: 'code', risk: 'low', objective: '重构 X', targetAgentName: 'Ghost' }))]),
    });
    // mention 是 Codex，但模型给 targetAgentName='Ghost' → 无法匹配 → 无法确认。
    await seedAgentRequestJob(repos, { status: 'online' });

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('blocked');
    expect(decision?.targetAgentId).toBeNull();

    const sys = await lastSystemMessage(repos);
    const meta = coordMeta(sys);
    expect(meta?.targetAgentName).toBe('Ghost');
    expect(meta?.targetAgentId).toBeNull();
    expect(meta?.action).toBe('specify_target');
    expect(sys?.body).toContain('无法确认');
  });

  test('suggested（自动协调关闭、非硬目标）：action=confirm_suggested，无 Task', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'r', risk: 'low', objective: '交付周报' }))]),
    });
    await seedHumanMessageJob(repos);
    await repos.teamPiPolicy.setAutoCoordination({ teamId: 'team-1', enabled: false, actorId: 'user-1', now: 1000 });

    await coordinator.processJob('job-1');
    const sys = await lastSystemMessage(repos);
    const meta = coordMeta(sys);
    expect(meta?.action).toBe('confirm_suggested');
    expect(meta?.taskId).toBeNull();
  });

  test('high-risk blocked：action=confirm_high_risk', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'r', risk: 'high', objective: '删除生产数据库' }))]),
    });
    await seedHumanMessageJob(repos);

    await coordinator.processJob('job-1');
    const sys = await lastSystemMessage(repos);
    const meta = coordMeta(sys);
    expect(meta?.action).toBe('confirm_high_risk');
  });

  test('task_followup applied 系统 meta.taskId 关联线程既有 Task (AC#4)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([
        okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'needs_tracking', risk: 'low', objective: '交付周报' })),
        okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'progress', risk: 'low', objective: '更新进度' })),
      ]),
    });
    await seedHumanMessageJob(repos, { messageId: 'message-1', jobId: 'job-1', body: '帮我交付周报' });
    await coordinator.processJob('job-1');
    const taskId = (await repos.channelCoordination.decisions.getByJobId('job-1'))?.linkedTaskId;
    expect(taskId).not.toBeNull();

    await repos.messages.append({
      id: 'message-2', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
      senderKind: 'human', senderId: 'user-1', body: '进度更新', createdAt: 910,
    });
    await repos.channelCoordination.jobs.create({
      id: 'job-2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-2',
      idempotencyKey: 'message:team-1:message-2', status: 'pending', attempt: 0, nextRetryAt: null,
      activeModel: { availability: 'available', cardId: 'card-1', revisionId: 'revision-1', modelId: 'pi-test-model' },
      createdAt: 920, updatedAt: 920,
    });
    await coordinator.processJob('job-2');

    const sys = await lastSystemMessage(repos);
    const meta = coordMeta(sys);
    expect(meta?.taskId).toBe(taskId);
    expect(meta?.intent).toBe('task_followup');
  });

  test('SQLite: applied tracked_task 系统消息行持久化 meta.coordination.taskId', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      const repos = createSqliteRepositories({ globalDb, teamDb });
      await seedAccessContext(repos);
      await repos.messages.append({
        id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
        senderKind: 'human', senderId: 'user-1', body: 'SQLite Task 测试', createdAt: 900,
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
        channels: repos.channels,
        teams: repos.teams,
        agents: repos.agents,
        teamPolicy: repos.teamPiPolicy,
        modelResolver: availableResolver,
        clock: { now: () => 1000 },
        ids: { nextId: createIds(['decision-1', 'sysmsg-1', 'task-1']) },
        fetch: makeFetch([okResponse(JSON.stringify({ intent: 'tracked_task', reasonCode: 'needs_tracking', risk: 'low', objective: '交付周报' }))]),
        baseDelayMs: 100,
      });
      await coordinator.processJob('job-1');
      const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
      // 直查 messages 表的系统行，meta JSON 含 coordination.taskId。
      const sysRow = teamDb.prepare('SELECT meta_json FROM messages WHERE sender_kind = ?').get('system') as { meta_json: string | null };
      const parsed = sysRow.meta_json ? JSON.parse(sysRow.meta_json) : null;
      expect(parsed?.coordination?.taskId).toBe(decision?.linkedTaskId);
      expect(parsed?.coordination?.intent).toBe('tracked_task');
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });
});

describe('channel coordinator: task_followup evidence binding (#709)', () => {
  function bindingCoordMeta(msg: { meta?: MessageMetaDto } | null | undefined): CoordinationSystemMessageMeta | null {
    const coordination = msg?.meta?.coordination;
    return (coordination as CoordinationSystemMessageMeta | undefined) ?? null;
  }

  async function bindingLastSystemMessage(repos: Setup['repos']) {
    const msgs = await repos.messages.listByChannel('channel-1', 50);
    const systems = msgs.filter((m) => m.senderKind === 'system');
    return systems.length > 0 ? systems[systems.length - 1] : null;
  }

  async function seedFollowupJob(
    repos: Setup['repos'],
    options: { objective?: string; priorTaskIdInThread?: string } = {},
  ): Promise<void> {
    await seedAccessContext(repos);
    if (options.priorTaskIdInThread) {
      await repos.messages.append({
        id: 'prior-msg', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
        senderKind: 'system', senderId: 'pi-coordinator', body: '已创建跟踪任务', createdAt: 800,
        meta: {
          coordination: {
            decisionId: 'd0', jobId: 'j0', intent: 'tracked_task', gateStatus: 'applied',
            taskId: options.priorTaskIdInThread,
          },
        },
      });
    }
    await repos.messages.append({
      id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
      senderKind: 'human', senderId: 'user-1', body: options.objective ?? '补充进度', createdAt: 900,
    });
    await repos.channelCoordination.jobs.create({
      id: 'job-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      idempotencyKey: 'message:team-1:message-1', status: 'pending', attempt: 0, nextRetryAt: null,
      activeModel: { availability: 'available', cardId: 'card-1', revisionId: 'revision-1', modelId: 'pi-test-model' },
      createdAt: 950, updatedAt: 950,
    });
  }

  async function seedChannelTask(
    repos: Setup['repos'],
    id: string,
    status: 'todo' | 'in_progress' | 'in_review' = 'in_progress',
    sortOrder = 0,
  ): Promise<void> {
    await repos.tasks.create({
      id, teamId: 'team-1', title: `任务 ${id}`, status, creatorId: 'user-1', channelId: 'channel-1',
      tags: [], sortOrder, createdAt: 700, updatedAt: 700,
    });
  }

  test('strong: 线程内含 taskId → 直接关联 + applied (AC1)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'followup', risk: 'low', objective: '补充进度' }))]),
    });
    await seedFollowupJob(repos, { priorTaskIdInThread: 'existing-task' });
    await seedChannelTask(repos, 'existing-task');

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.linkedTaskId).toBe('existing-task');
    expect(decision?.gateStatus).toBe('applied');
    const sys = await bindingLastSystemMessage(repos);
    expect(bindingCoordMeta(sys)?.taskId).toBe('existing-task');
  });

  test('suggested: 无线程 taskId + 唯一活跃候选 → 关联 + confirm_suggested (AC2)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'followup', risk: 'low', objective: '补充一个实现细节' }))]),
    });
    await seedFollowupJob(repos);
    await seedChannelTask(repos, 'lone-task');

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.linkedTaskId).toBe('lone-task');
    const sys = await bindingLastSystemMessage(repos);
    expect(bindingCoordMeta(sys)?.action).toBe('confirm_suggested');
  });

  test('needs_confirmation: 无线程 taskId + 多候选 → blocked + 候选列表 (AC3)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'followup', risk: 'low', objective: '更新进度' }))]),
    });
    await seedFollowupJob(repos);
    await seedChannelTask(repos, 'task-a', 'todo', 0);
    await seedChannelTask(repos, 'task-b', 'in_progress', 1);

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.gateStatus).toBe('blocked');
    expect(decision?.linkedTaskId).toBeNull();
    const sys = await bindingLastSystemMessage(repos);
    const meta = bindingCoordMeta(sys);
    expect(meta?.gateStatus).toBe('blocked');
    expect(meta?.followupCandidateTaskIds).toEqual(['task-a', 'task-b']);
  });

  test('none: 无线程 taskId + 无候选 → 不关联', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'followup', risk: 'low', objective: '随便跟进' }))]),
    });
    await seedFollowupJob(repos);

    await coordinator.processJob('job-1');
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.linkedTaskId).toBeNull();
  });

  test('replay 同一 job 不重复系统消息 (AC6 幂等)', async () => {
    const { repos, coordinator } = setup({
      fetch: makeFetch([
        okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'followup', risk: 'low', objective: '补充' })),
        okResponse(JSON.stringify({ intent: 'task_followup', reasonCode: 'followup', risk: 'low', objective: '补充' })),
      ]),
    });
    await seedFollowupJob(repos);
    await seedChannelTask(repos, 'lone-task');

    await coordinator.processJob('job-1');
    await coordinator.processJob('job-1');
    const msgs = await repos.messages.listByChannel('channel-1', 50);
    expect(msgs.filter((m) => m.senderKind === 'system').length).toBe(1);
    const decision = await repos.channelCoordination.decisions.getByJobId('job-1');
    expect(decision?.linkedTaskId).toBe('lone-task');
  });
});

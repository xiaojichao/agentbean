import { describe, expect, test } from 'vitest';

import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/index';
import { createMessageTracerCommandDispatcher } from '../src/application/message-tracer-dispatcher.js';
import type {
  AckReadCandidateCommandHandler,
  CheckInboxCommandHandler,
  SendMessageCommandHandler,
} from '../src/application/message-tracer-handlers.js';
import type { MessageTracerCommandResponseV1 } from '@agentbean/contracts';

// #921 切片 C-wire：dispatcher 路由 + dispatchMessageTracerCommand flag 门禁。

const NOW = 1_700_000_000_000;

function stub(commandName: 'send-message' | 'check-inbox' | 'ack-read-candidate', seen: { actorId?: string }[]) {
  const handler = (async (input: { senderId?: string; requesterId?: string }) => {
    seen.push({ actorId: input.senderId ?? input.requesterId });
    return {
      schemaVersion: 1, commandName, outcome: 'applied', retryDirective: 'none', stableCode: 'STUB',
    } as MessageTracerCommandResponseV1;
  }) as SendMessageCommandHandler & CheckInboxCommandHandler & AckReadCandidateCommandHandler;
  return handler;
}

describe('message-tracer command dispatcher', () => {
  test('按 commandName 路由到对应 handler，注入 authority', async () => {
    const sendSeen: { actorId?: string }[] = [];
    const checkSeen: { actorId?: string }[] = [];
    const ackSeen: { actorId?: string }[] = [];
    const dispatcher = createMessageTracerCommandDispatcher({
      send: stub('send-message', sendSeen),
      checkInbox: stub('check-inbox', checkSeen),
      ack: stub('ack-read-candidate', ackSeen),
    });

    const authority = { actorId: 'user-1', teamId: 'team-1' };
    const r1 = await dispatcher.dispatch({ commandName: 'send-message', envelope: {}, payload: {}, authority });
    const r2 = await dispatcher.dispatch({ commandName: 'check-inbox', envelope: {}, payload: {}, authority });
    const r3 = await dispatcher.dispatch({ commandName: 'ack-read-candidate', envelope: {}, payload: {}, authority });

    expect(r1.commandName).toBe('send-message');
    expect(r2.commandName).toBe('check-inbox');
    expect(r3.commandName).toBe('ack-read-candidate');
    // authority 注入：send→senderId, check/ack→requesterId
    expect(sendSeen[0].actorId).toBe('user-1');
    expect(checkSeen[0].actorId).toBe('user-1');
    expect(ackSeen[0].actorId).toBe('user-1');
  });

  test('未知 command 被拒（封闭 registry，ADR-0067）', async () => {
    const dispatcher = createMessageTracerCommandDispatcher({
      send: stub('send-message', []),
      checkInbox: stub('check-inbox', []),
      ack: stub('ack-read-candidate', []),
    });
    await expect(dispatcher.dispatch({
      commandName: 'bogus' as never, envelope: {}, payload: {}, authority: { actorId: 'u', teamId: 't' },
    })).rejects.toThrow();
  });
});

describe('dispatchMessageTracerCommand usecase 方法 + flag 门禁', () => {
  async function seedChannel(repos: ReturnType<typeof createInMemoryRepositories>): Promise<void> {
    if (!(await repos.teams.getById('team-1'))) {
      await repos.teams.create({ id: 'team-1', name: 'Team 1', path: 'team-1', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
    }
    await repos.channels.create({
      id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public',
      createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [],
    });
  }

  test('flag=false（默认）→ disabled 响应；legacy 路径不受影响', async () => {
    const repos = createInMemoryRepositories();
    let n = 0;
    const app = createServerNextUseCases({ repositories: repos, clock: { now: () => NOW }, ids: { nextId: () => `id-${++n}` } });
    const res = await app.dispatchMessageTracerCommand({
      envelope: { schemaVersion: 1, commandName: 'send-message', commandSchemaVersion: 1, idempotencyKey: 'k-1' },
      payload: {},
      userId: 'user-1', teamId: 'team-1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('MESSAGE_TRACER_DISABLED');
  });

  test('flag=true → dispatch send-message，返回 {ok:true, response: applied}', async () => {
    const repos = createInMemoryRepositories();
    await seedChannel(repos);
    let n = 0;
    const app = createServerNextUseCases({
      repositories: repos, clock: { now: () => NOW }, ids: { nextId: () => `id-${++n}` }, messageTracerEnabled: true,
    });
    const res = await app.dispatchMessageTracerCommand({
      envelope: { schemaVersion: 1, commandName: 'send-message', commandSchemaVersion: 1, idempotencyKey: 'k-1' },
      payload: {
        channelId: 'channel-1', senderKind: 'human', body: 'hi',
        freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' } },
      },
      userId: 'user-1', teamId: 'team-1',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.response.outcome).toBe('applied');
      expect(res.response.commandName).toBe('send-message');
    }
  });

  test('flag=true + 无效 envelope → {ok:false, MESSAGE_TRACER_PAYLOAD_INVALID}', async () => {
    const repos = createInMemoryRepositories();
    let n = 0;
    const app = createServerNextUseCases({
      repositories: repos, clock: { now: () => NOW }, ids: { nextId: () => `id-${++n}` }, messageTracerEnabled: true,
    });
    const res = await app.dispatchMessageTracerCommand({
      envelope: { notAnEnvelope: true }, payload: {}, userId: 'user-1', teamId: 'team-1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('MESSAGE_TRACER_PAYLOAD_INVALID');
  });
});

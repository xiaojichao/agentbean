import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type {
  TaskOfferObjectiveDto,
  TaskOfferRecord,
  TaskOfferResponseRecordDto,
  TaskOfferStatus,
} from '../../packages/contracts/src/index.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyTeamMigrations, createSqliteRepositories, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

const objective: TaskOfferObjectiveDto = {
  objective: 'review PR #758',
  inputs: ['diff', 'context'],
  deliverables: ['approval comment'],
  constraints: ['read-only'],
  riskLevel: 'low',
  requiredCapabilities: ['code-review'],
  requiredSkills: ['typescript'],
  preferredSkills: ['rust'],
};

function makeOffer(over: Partial<TaskOfferRecord> = {}): TaskOfferRecord {
  return {
    id: 'offer-1',
    teamId: 'team-1',
    taskId: 'task-1',
    agentId: 'agent-a',
    taskRevision: 1,
    taskAttempt: 1,
    manifestRevision: 1,
    objective,
    offerTtlMs: 15_000,
    offerExpiresAt: 1_000 + 15_000,
    hardSpecified: false,
    status: 'open',
    response: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

const acceptedResponse: TaskOfferResponseRecordDto = {
  offerId: 'offer-1', agentId: 'agent-a', kind: 'accepted', detail: null, respondedAt: 2_000,
};

describe.each([
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { repositories: createSqliteRepositories({ globalDb: db, teamDb: db }), close: () => db.close() };
  }],
] as const)('Task offers persistence (%s)', (_name, createFixture) => {
  test('create + getById round-trips all fixed fields incl objective (AC#1)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.taskCoordination.offers.create(makeOffer({ hardSpecified: true }));
      const got = await fixture.repositories.taskCoordination.offers.getById('offer-1');
      expect(got).toMatchObject({
        id: 'offer-1', teamId: 'team-1', taskId: 'task-1', agentId: 'agent-a',
        taskRevision: 1, taskAttempt: 1, manifestRevision: 1,
        offerTtlMs: 15_000, offerExpiresAt: 16_000, hardSpecified: true,
        status: 'open', response: null,
      });
      expect(got?.objective).toEqual(objective); // JSON 列无损
    } finally { fixture.close(); }
  });

  test('listByTask returns only that task offers sorted by createdAt (AC#7)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.taskCoordination.offers.create(makeOffer({ id: 'b', createdAt: 3_000, updatedAt: 3_000 }));
      await fixture.repositories.taskCoordination.offers.create(makeOffer({ id: 'a', createdAt: 1_000, updatedAt: 1_000 }));
      await fixture.repositories.taskCoordination.offers.create(makeOffer({ id: 'c', taskId: 'task-2', createdAt: 2_000, updatedAt: 2_000 }));
      const list = await fixture.repositories.taskCoordination.offers.listByTask('task-1');
      expect(list.map((o) => o.id)).toEqual(['a', 'b']);
    } finally { fixture.close(); }
  });

  test('listByAgent filters by agent and optional statuses (AC#7/AC#8)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.taskCoordination.offers.create(makeOffer({ id: 'o1', agentId: 'agent-a', status: 'open' }));
      await fixture.repositories.taskCoordination.offers.create(makeOffer({ id: 'o2', agentId: 'agent-a', status: 'accepted' }));
      await fixture.repositories.taskCoordination.offers.create(makeOffer({ id: 'o3', agentId: 'agent-b', status: 'open' }));
      const all = await fixture.repositories.taskCoordination.offers.listByAgent({ teamId: 'team-1', agentId: 'agent-a' });
      expect(all.map((o) => o.id).sort()).toEqual(['o1', 'o2']);
      const openOnly = await fixture.repositories.taskCoordination.offers.listByAgent({
        teamId: 'team-1', agentId: 'agent-a', statuses: ['open' as TaskOfferStatus],
      });
      expect(openOnly.map((o) => o.id)).toEqual(['o1']);
    } finally { fixture.close(); }
  });

  test('updateStatus CAS: open→accepted with response succeeds (AC#3/AC#4 持久化)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.taskCoordination.offers.create(makeOffer());
      const updated = await fixture.repositories.taskCoordination.offers.updateStatus({
        id: 'offer-1', expectedStatus: 'open', status: 'accepted', response: acceptedResponse, now: 2_000,
      });
      expect(updated?.status).toBe('accepted');
      expect(updated?.response).toEqual(acceptedResponse);
      expect(updated?.updatedAt).toBe(2_000);
      // 落库持久化
      await expect(fixture.repositories.taskCoordination.offers.getById('offer-1'))
        .resolves.toMatchObject({ status: 'accepted' });
    } finally { fixture.close(); }
  });

  test('updateStatus CAS: 并发第二次 open→accepted 在已 accepted 后返回 null (AC#6 败者)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.taskCoordination.offers.create(makeOffer());
      await fixture.repositories.taskCoordination.offers.updateStatus({
        id: 'offer-1', expectedStatus: 'open', status: 'accepted', response: acceptedResponse, now: 2_000,
      });
      // 败者：仍以为 open，尝试接受 → CAS 失败
      const loser = await fixture.repositories.taskCoordination.offers.updateStatus({
        id: 'offer-1', expectedStatus: 'open', status: 'accepted', response: { ...acceptedResponse, agentId: 'agent-b' }, now: 2_001,
      });
      expect(loser).toBeNull();
      // 状态未被败者覆盖
      await expect(fixture.repositories.taskCoordination.offers.getById('offer-1'))
        .resolves.toMatchObject({ status: 'accepted' });
    } finally { fixture.close(); }
  });

  test('updateStatus wrong expectedStatus → null (乐观并发)', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.taskCoordination.offers.create(makeOffer());
      const result = await fixture.repositories.taskCoordination.offers.updateStatus({
        id: 'offer-1', expectedStatus: 'accepted', status: 'rejected', response: null, now: 2_000,
      });
      expect(result).toBeNull();
    } finally { fixture.close(); }
  });

  test('rejected/needs_info/counter_proposed persist status + response, no accepted (AC#5)', async () => {
    const fixture = createFixture();
    try {
      for (const kind of ['rejected', 'needs_info', 'counter_proposed'] as const) {
        const id = `offer-${kind}`;
        await fixture.repositories.taskCoordination.offers.create(makeOffer({ id }));
        const resp: TaskOfferResponseRecordDto = {
          offerId: id, agentId: 'agent-a', kind, detail: 'reason', respondedAt: 5_000,
        };
        const updated = await fixture.repositories.taskCoordination.offers.updateStatus({
          id, expectedStatus: 'open', status: kind, response: resp, now: 5_000,
        });
        expect(updated?.status).toBe(kind);
        expect(updated?.response?.kind).toBe(kind);
      }
    } finally { fixture.close(); }
  });

  test('getById unknown → null', async () => {
    const fixture = createFixture();
    try {
      await expect(fixture.repositories.taskCoordination.offers.getById('nope')).resolves.toBeNull();
    } finally { fixture.close(); }
  });
});

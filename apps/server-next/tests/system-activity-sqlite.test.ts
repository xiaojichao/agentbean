import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { createSystemActivityDispatcher } from '../src/application/system-activity-dispatcher.js';
import {
  createSqliteSystemActivityRepositories,
  createSqliteSystemActivityUnitOfWork,
} from '../src/infra/sqlite/system-activity-repositories.js';

/**
 * #999：SQLite 持久化 — 重启后 query 仍可见投影与 attention。
 */

const here = dirname(fileURLToPath(import.meta.url));

// 轻量：直接读 migration SQL 应用 system_activity 表（避免整库依赖）
function applySystemActivitySchema(db: Database.Database) {
  const migration = readFileSync(
    join(here, '../src/infra/sqlite/migrations/team/0072_system_activity.sql'),
    'utf8',
  );
  db.exec(migration);
}

describe('system-activity SQLite persistence (#999)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  test('project 后关闭再开，query 仍返回投影与 attention', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-sqlite-'));
    dirs.push(dir);
    const path = join(dir, 'team.sqlite');

    let seq = 0;
    const ids = { nextId: () => `id-${++seq}` };
    const clock = { now: () => 10_000 + seq };

    // ---- 第一次打开：写入 ----
    {
      const db = new Database(path);
      applySystemActivitySchema(db);
      const repos = createSqliteSystemActivityRepositories(db as never);
      const uow = createSqliteSystemActivityUnitOfWork(db as never, repos);
      const dispatcher = createSystemActivityDispatcher({
        teamId: 'team-1',
        unitOfWork: uow,
        ids,
        clock,
      });
      const res = await dispatcher.dispatchCommand({
        envelope: {
          schemaVersion: 1,
          commandName: 'project-source-fact',
          commandSchemaVersion: 1,
          idempotencyKey: 'idem-persist-1',
        },
        payload: {
          fact: {
            schemaVersion: 1,
            eventId: 'evt-1',
            streamKind: 'task',
            streamId: 'task-1',
            sequence: 3,
            teamId: 'team-1',
            taskId: 'task-1',
            channelId: 'ch-1',
            factKind: 'action_required_opened',
            occurredAt: 1000,
            visibleRecipientIds: ['user-a', 'user-b'],
            responsibleRecipientIds: ['user-a'],
            summary: '需要人工处置',
            attentionKey: 'esc:1',
            allowedCommands: ['retry-attempt'],
            confirmationToken: 'tok',
            escalationRevision: 1,
          },
          projectionWatermark: 3,
        },
      });
      expect(res.outcome).toBe('applied');
      db.close();
    }

    // ---- 第二次打开：读取（模拟重启；表已存在，不再跑 migration） ----
    {
      const db = new Database(path);
      const repos = createSqliteSystemActivityRepositories(db as never);
      const uow = createSqliteSystemActivityUnitOfWork(db as never, repos);
      const dispatcher = createSystemActivityDispatcher({
        teamId: 'team-1',
        unitOfWork: uow,
        ids,
        clock,
      });

      const timeline = await dispatcher.dispatchQuery({
        queryName: 'query-task-activity',
        payload: { taskId: 'task-1', recipientId: 'user-a', limit: 20 },
      });
      expect(timeline.outcome).toBe('ready');
      if (timeline.result?.queryName === 'query-task-activity') {
        expect(timeline.result.items.length).toBeGreaterThan(0);
        expect(timeline.result.items.every((i) => i.actorKind === 'system')).toBe(true);
      }

      const inbox = await dispatcher.dispatchQuery({
        queryName: 'query-attention-inbox',
        payload: { recipientId: 'user-a', limit: 20 },
      });
      expect(inbox.outcome).toBe('ready');
      if (inbox.result?.queryName === 'query-attention-inbox') {
        expect(inbox.result.items).toHaveLength(1);
        expect(inbox.result.items[0]?.level).toBe('action_required');
        expect(inbox.result.items[0]?.summary).toBe('需要人工处置');
      }

      // 幂等 replay
      const replay = await dispatcher.dispatchCommand({
        envelope: {
          schemaVersion: 1,
          commandName: 'project-source-fact',
          commandSchemaVersion: 1,
          idempotencyKey: 'idem-persist-1',
        },
        payload: {
          fact: {
            schemaVersion: 1,
            eventId: 'evt-1',
            streamKind: 'task',
            streamId: 'task-1',
            sequence: 3,
            teamId: 'team-1',
            taskId: 'task-1',
            channelId: 'ch-1',
            factKind: 'action_required_opened',
            occurredAt: 1000,
            visibleRecipientIds: ['user-a', 'user-b'],
            responsibleRecipientIds: ['user-a'],
            summary: '需要人工处置',
            attentionKey: 'esc:1',
            allowedCommands: ['retry-attempt'],
            confirmationToken: 'tok',
            escalationRevision: 1,
          },
          projectionWatermark: 3,
        },
      });
      expect(replay.outcome).toBe('replayed');
      db.close();
    }
  });
});

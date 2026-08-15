import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  here,
  '../src/infra/sqlite/migrations/team/0085_direct_agent_task_lineage.sql',
);

describe('0085_direct_agent_task_lineage migration', () => {
  test('只回填可由 origin Message 严格证明的 Direct Agent Dispatch fallback', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE output_packages (
        team_id TEXT NOT NULL,
        package_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        publish_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_binding TEXT NOT NULL,
        task_revision INTEGER,
        PRIMARY KEY (team_id, package_id)
      );
      CREATE TABLE workspace_publish_stagings (
        team_id TEXT NOT NULL,
        publish_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        provenance_json TEXT,
        PRIMARY KEY (team_id, publish_id)
      );
      CREATE TABLE dispatches (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        meta_json TEXT
      );
      CREATE TABLE tasks (
        id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        channel_id TEXT,
        revision INTEGER NOT NULL,
        superseded_by_revision INTEGER,
        PRIMARY KEY (id, team_id, revision)
      );
    `);

    const insertCase = (input: {
      suffix: string;
      taskId: string;
      packageBinding?: 'managed' | 'unmanaged';
      workspaceRunId?: string;
      createTask?: boolean;
    }) => {
      const dispatchId = `dispatch-${input.suffix}`;
      const publishId = `publish-${input.suffix}`;
      db.prepare(`
        INSERT INTO messages (id, team_id, channel_id, meta_json)
        VALUES (?, 'team-1', 'channel-1', ?)
      `).run(`message-${input.suffix}`, JSON.stringify({ taskId: input.taskId }));
      db.prepare(`
        INSERT INTO dispatches (id, team_id, channel_id, message_id, agent_id)
        VALUES (?, 'team-1', 'channel-1', ?, 'agent-1')
      `).run(dispatchId, `message-${input.suffix}`);
      if (input.createTask !== false) {
        db.prepare(`
          INSERT INTO tasks (id, team_id, channel_id, revision, superseded_by_revision)
          VALUES (?, 'team-1', 'channel-1', 3, NULL)
        `).run(input.taskId);
      }
      db.prepare(`
        INSERT INTO workspace_publish_stagings (
          team_id, publish_id, channel_id, provenance_json
        ) VALUES ('team-1', ?, 'channel-1', ?)
      `).run(publishId, JSON.stringify({
        agentId: 'agent-1',
        taskId: dispatchId,
        workspaceRunId: input.workspaceRunId ?? dispatchId,
      }));
      db.prepare(`
        INSERT INTO output_packages (
          team_id, package_id, channel_id, publish_id, agent_id,
          task_id, task_binding, task_revision
        ) VALUES ('team-1', ?, 'channel-1', ?, 'agent-1', ?, ?, ?)
      `).run(
        `package-${input.suffix}`,
        publishId,
        dispatchId,
        input.packageBinding ?? 'unmanaged',
        input.packageBinding === 'managed' ? 1 : null,
      );
    };

    insertCase({ suffix: 'exact', taskId: 'task-exact' });
    insertCase({ suffix: 'missing-task', taskId: 'task-missing', createTask: false });
    insertCase({ suffix: 'wrong-run', taskId: 'task-wrong-run', workspaceRunId: 'other-run' });
    insertCase({ suffix: 'managed', taskId: 'task-managed', packageBinding: 'managed' });

    db.exec(readFileSync(migrationPath, 'utf8'));

    const readPackage = (suffix: string) => db.prepare(`
      SELECT task_id AS taskId, task_binding AS taskBinding, task_revision AS taskRevision
      FROM output_packages
      WHERE team_id = 'team-1' AND package_id = ?
    `).get(`package-${suffix}`) as { taskId: string; taskBinding: string; taskRevision: number | null };
    const readStagingTaskId = (suffix: string) => {
      const row = db.prepare(`
        SELECT provenance_json AS provenanceJson
        FROM workspace_publish_stagings
        WHERE team_id = 'team-1' AND publish_id = ?
      `).get(`publish-${suffix}`) as { provenanceJson: string };
      return (JSON.parse(row.provenanceJson) as { taskId: string }).taskId;
    };

    expect(readPackage('exact')).toEqual({
      taskId: 'task-exact', taskBinding: 'managed', taskRevision: 3,
    });
    expect(readStagingTaskId('exact')).toBe('task-exact');

    expect(readPackage('missing-task')).toEqual({
      taskId: 'dispatch-missing-task', taskBinding: 'unmanaged', taskRevision: null,
    });
    expect(readStagingTaskId('missing-task')).toBe('dispatch-missing-task');
    expect(readPackage('wrong-run')).toEqual({
      taskId: 'dispatch-wrong-run', taskBinding: 'unmanaged', taskRevision: null,
    });
    expect(readStagingTaskId('wrong-run')).toBe('dispatch-wrong-run');
    expect(readPackage('managed')).toEqual({
      taskId: 'dispatch-managed', taskBinding: 'managed', taskRevision: 1,
    });
    expect(readStagingTaskId('managed')).toBe('dispatch-managed');

    db.close();
  });
});

import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
} from '../src/infra/sqlite/repositories.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

interface Variant { name: string; make: () => { repositories: ServerNextRepositories; close: () => void } }
const variants: Variant[] = [
  { name: 'memory', make: () => ({ repositories: createInMemoryRepositories(), close: () => undefined }) },
  {
    name: 'sqlite',
    make: () => {
      const globalDb = new Database(':memory:') as unknown as Database.Database;
      const teamDb = new Database(':memory:') as unknown as Database.Database;
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      return { repositories: createSqliteRepositories({ globalDb, teamDb }), close: () => { globalDb.close(); teamDb.close(); } };
    },
  },
];

const file = (path: string, artifactId: string) => ({ path, artifactId, filename: path, mimeType: 'text/plain', sizeBytes: 1 });

describe.each(variants)('workspace publish bootstrap ($name)', ({ make }) => {
  test('首次发布(无 workspace)自动建初始 workspace+revision', async () => {
    const { repositories, close } = make();
    try {
      const outcome = await repositories.projectChannelWorkspaces.publishRevision({
        teamId: 't1', channelId: 'c1', // 无 baselineRevisionId = 首次发布
        newWorkspaceId: 'ws-1',
        newRevision: { id: 'rev-1', files: [file('a.md', 'art-1')], createdBy: 'u1', createdAt: 100 },
      });
      expect(outcome.kind).toBe('published');
      if (outcome.kind !== 'published') return;
      expect(outcome.workspace.id).toBe('ws-1');
      expect(outcome.workspace.currentRevisionId).toBe('rev-1');
      expect(outcome.workspace.currentRevision.revision).toBe(1);
      const read = await repositories.projectChannelWorkspaces.getForTeam({ teamId: 't1', channelId: 'c1' });
      expect(read?.id).toBe('ws-1');
    } finally { close(); }
  });

  test('第二次发布基于 bootstrap baseline 推进 revision 号', async () => {
    const { repositories, close } = make();
    try {
      const first = await repositories.projectChannelWorkspaces.publishRevision({
        teamId: 't1', channelId: 'c1', newWorkspaceId: 'ws-1',
        newRevision: { id: 'rev-1', files: [file('a.md', 'art-1')], createdBy: 'u1', createdAt: 100 },
      });
      expect(first.kind).toBe('published');
      const second = await repositories.projectChannelWorkspaces.publishRevision({
        teamId: 't1', channelId: 'c1', baselineRevisionId: 'rev-1',
        newRevision: { id: 'rev-2', files: [file('b.md', 'art-2')], createdBy: 'u1', createdAt: 200 },
      });
      expect(second.kind).toBe('published');
      if (second.kind !== 'published') return;
      expect(second.workspace.currentRevision.revision).toBe(2);
    } finally { close(); }
  });

  test('给了 baselineRevisionId 却无 workspace → 抛错（非法态，不 bootstrap）', async () => {
    const { repositories, close } = make();
    try {
      await expect(repositories.projectChannelWorkspaces.publishRevision({
        teamId: 't1', channelId: 'c1', baselineRevisionId: 'rev-x',
        newRevision: { id: 'rev-1', files: [file('a.md', 'art-1')], createdBy: 'u1', createdAt: 100 },
      })).rejects.toThrow(/Project Channel Workspace not found/);
    } finally { close(); }
  });
});

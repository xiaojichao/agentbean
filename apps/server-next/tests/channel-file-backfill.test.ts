import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  applyTeamMigrations,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories';
import {
  createChannelFileBackfill,
  createChannelFileBackfillIfSupported,
} from '../src/infra/sqlite/channel-file-backfill';
import { createSqliteArtifactPreviewRepository } from '../src/infra/sqlite/artifact-preview-repository';

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };

const requireFromWorkspace = createRequire(import.meta.url);
const Database = requireFromWorkspace('better-sqlite3') as BetterSqlite3Constructor;

describe('频道历史文件回填', () => {
  test('缺少 0039 能力表的旧库不会启动永久失败的回填轮询', () => {
    const db = new Database(':memory:');
    try {
      expect(createChannelFileBackfillIfSupported({
        db,
        dataDir: '/srv/agentbean',
      })).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('把历史 Markdown 消息附件建立为独立文档并记录批次游标', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      insertMessage(db, {
        id: 'message-1',
        threadId: 'root-message',
        senderId: 'user-1',
      });
      insertArtifact(db, {
        id: 'artifact-1',
        messageId: 'message-1',
        filename: 'notes.md',
        mimeType: 'text/markdown',
        storagePath: 'artifacts/team-1/artifact-1/notes.md',
      });

      const backfill = createChannelFileBackfill({
        db,
        dataDir: '/srv/agentbean',
        batchSize: 10,
        now: () => 500,
      });

      expect(backfill.runBatch()).toEqual({
        processed: 1,
        completed: true,
        cursor: { createdAt: 100, artifactId: 'artifact-1' },
      });
      expect(db.prepare(
        'SELECT artifact_role FROM artifacts WHERE id = ?',
      ).get('artifact-1')).toEqual({ artifact_role: 'attachment' });
      expect(db.prepare(
        'SELECT id, current_revision_id FROM channel_documents',
      ).all()).toEqual([{
        id: 'channel-document:artifact-1',
        current_revision_id: 'channel-document:artifact-1:revision:1',
      }]);
      expect(db.prepare(
        'SELECT document_id, artifact_id, revision FROM channel_document_revisions',
      ).all()).toEqual([{
        document_id: 'channel-document:artifact-1',
        artifact_id: 'artifact-1',
        revision: 1,
      }]);
      expect(db.prepare(`SELECT id, revision_id, message_id, published_by, published_at
        FROM channel_document_publications`).all()).toEqual([{
        id: 'channel-document:artifact-1:revision:1:publication',
        revision_id: 'channel-document:artifact-1:revision:1',
        message_id: 'message-1',
        published_by: 'user-1',
        published_at: 100,
      }]);
      expect(db.prepare(
        'SELECT cursor_created_at, cursor_artifact_id, completed_at FROM channel_file_backfill_progress',
      ).get()).toEqual({
        cursor_created_at: 100,
        cursor_artifact_id: 'artifact-1',
        completed_at: 500,
      });
    } finally {
      db.close();
    }
  });

  test('按游标分批处理同名 Markdown，重启和重复执行不产生重复记录', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      for (const suffix of ['1', '2']) {
        insertMessage(db, { id: `message-${suffix}`, senderId: 'user-1' });
        insertArtifact(db, {
          id: `artifact-${suffix}`,
          messageId: `message-${suffix}`,
          filename: 'notes.md',
          mimeType: 'text/markdown',
          createdAt: 100,
        });
      }

      const firstWorker = createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', batchSize: 1, now: () => 500,
      });
      expect(firstWorker.runBatch()).toEqual({
        processed: 1,
        completed: false,
        cursor: { createdAt: 100, artifactId: 'artifact-1' },
      });

      const restartedWorker = createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', batchSize: 1, now: () => 600,
      });
      expect(restartedWorker.runBatch()).toEqual({
        processed: 1,
        completed: true,
        cursor: { createdAt: 100, artifactId: 'artifact-2' },
      });
      expect(restartedWorker.runBatch()).toEqual({
        processed: 0,
        completed: true,
        cursor: { createdAt: 100, artifactId: 'artifact-2' },
      });
      expect(db.prepare('SELECT id FROM channel_documents ORDER BY id').all()).toEqual([
        { id: 'channel-document:artifact-1' },
        { id: 'channel-document:artifact-2' },
      ]);
      expect(db.prepare('SELECT id FROM channel_document_revisions ORDER BY id').all()).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('旧 Run 文件按 Run 隔离，并为缺失路径使用稳定安全分组', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      for (const suffix of ['1', '2']) {
        insertArtifact(db, {
          id: `artifact-run-${suffix}`,
          workspaceRunId: `run-${suffix}`,
          filename: suffix === '1' ? 'result.csv' : '',
          mimeType: 'text/csv',
        });
      }

      createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', now: () => 500,
      }).runBatch();

      expect(db.prepare(`SELECT id, artifact_role, source_root_id, source_root_kind,
        source_root_label, relative_path FROM artifacts ORDER BY id`).all()).toEqual([
        {
          id: 'artifact-run-1',
          artifact_role: 'run_output',
          source_root_id: 'legacy_run:run-1',
          source_root_kind: 'legacy_run',
          source_root_label: '历史运行产物',
          relative_path: 'result.csv',
        },
        {
          id: 'artifact-run-2',
          artifact_role: 'run_output',
          source_root_id: 'legacy_run:run-2',
          source_root_kind: 'legacy_run',
          source_root_label: '历史运行产物',
          relative_path: expect.stringMatching(/^未分组\/历史文件-[a-f0-9]{12}$/),
        },
      ]);
    } finally {
      db.close();
    }
  });

  test('纠正 0037 已按消息误标为 attachment 的历史 Run 文件', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      insertMessage(db, { id: 'message-run', senderId: 'agent-1' });
      insertArtifact(db, {
        id: 'artifact-message-run',
        messageId: 'message-run',
        workspaceRunId: 'run-legacy',
        filename: 'result.md',
        mimeType: 'text/markdown',
        artifactRole: 'attachment',
        sourceRootId: 'legacy_run:run-legacy',
        sourceRootKind: 'legacy_run',
      });

      createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', now: () => 500,
      }).runBatch();

      expect(db.prepare(`SELECT artifact_role, source_root_id, source_root_kind
        FROM artifacts WHERE id = ?`).get('artifact-message-run')).toEqual({
        artifact_role: 'run_output',
        source_root_id: 'legacy_run:run-legacy',
        source_root_kind: 'legacy_run',
      });
      expect(db.prepare('SELECT id FROM channel_documents').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('缺失源消息 metadata 的旧 Run 仍进入安全的 Run 分组', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      insertArtifact(db, {
        id: 'artifact-orphan-run',
        messageId: 'missing-message',
        workspaceRunId: 'run-legacy',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
      });

      createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', now: () => 500,
      }).runBatch();

      expect(db.prepare(`SELECT artifact_role, source_root_id, source_root_kind
        FROM artifacts WHERE id = ?`).get('artifact-orphan-run')).toEqual({
        artifact_role: 'run_output',
        source_root_id: 'legacy_run:run-legacy',
        source_root_kind: 'legacy_run',
      });
      expect(db.prepare('SELECT id FROM channel_documents').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('保留显式角色且不公开历史设备绝对路径', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      insertMessage(db, { id: 'message-1', senderId: 'user-1' });
      insertArtifact(db, {
        id: 'artifact-deliverable',
        messageId: 'message-1',
        filename: 'approved.pdf',
        mimeType: 'application/pdf',
        artifactRole: 'deliverable',
      });
      insertArtifact(db, {
        id: 'artifact-run',
        workspaceRunId: 'run-1',
        filename: 'result.csv',
        mimeType: 'text/csv',
        relativePath: '/Users/alice/customer-secret/result.csv',
      });

      createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', now: () => 500,
      }).runBatch();

      expect(db.prepare(
        'SELECT artifact_role FROM artifacts WHERE id = ?',
      ).get('artifact-deliverable')).toEqual({ artifact_role: 'deliverable' });
      expect(db.prepare(
        'SELECT relative_path FROM artifacts WHERE id = ?',
      ).get('artifact-run')).toEqual({ relative_path: 'result.csv' });
    } finally {
      db.close();
    }
  });

  test('带 charset 参数的历史 Markdown MIME 仍建立文档', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      insertMessage(db, { id: 'message-1', senderId: 'user-1' });
      insertArtifact(db, {
        id: 'artifact-markdown-charset',
        messageId: 'message-1',
        filename: 'README',
        mimeType: 'text/markdown; charset=utf-8',
      });

      createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', now: () => 500,
      }).runBatch();

      expect(db.prepare('SELECT id FROM channel_documents').all()).toEqual([{
        id: 'channel-document:artifact-markdown-charset',
      }]);
    } finally {
      db.close();
    }
  });

  test('已删除消息附件不会建立文档或 preview job', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      insertMessage(db, {
        id: 'message-deleted',
        senderId: 'user-1',
        metaJson: JSON.stringify({ deletedAt: 99, deletedBy: 'user-1' }),
      });
      insertArtifact(db, {
        id: 'artifact-deleted',
        messageId: 'message-deleted',
        filename: 'deleted.md',
        mimeType: 'text/markdown',
        storagePath: 'artifacts/team-1/artifact-deleted/deleted.md',
      });

      createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', now: () => 500,
      }).runBatch();

      expect(db.prepare('SELECT id FROM channel_documents').all()).toEqual([]);
      expect(db.prepare('SELECT id FROM artifact_preview_jobs').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('实时 preview job 优先于历史低优先级补齐任务', async () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      insertMessage(db, { id: 'message-old', senderId: 'user-1' });
      insertArtifact(db, {
        id: 'artifact-old',
        messageId: 'message-old',
        filename: 'old.png',
        mimeType: 'image/png',
        storagePath: 'artifacts/team-1/artifact-old/old.png',
      });
      insertArtifact(db, {
        id: 'artifact-live',
        filename: 'live.png',
        mimeType: 'image/png',
        storagePath: 'artifacts/team-1/artifact-live/live.png',
        createdAt: 200,
      });
      createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', batchSize: 1, now: () => 100,
      }).runBatch();

      const previews = createSqliteArtifactPreviewRepository(db);
      await previews.createIfAbsent({
        id: 'live-job',
        artifactId: 'artifact-live',
        teamId: 'team-1',
        inputPath: '/srv/agentbean/artifacts/team-1/artifact-live/live.png',
        mimeType: 'image/png',
        attempts: 0,
        status: 'pending',
        updatedAt: 200,
      });

      await expect(previews.claimNext({
        now: 300, leasedUntil: 400, maxAttempts: 3,
      })).resolves.toMatchObject({
        id: 'live-job',
        artifactId: 'artifact-live',
      });
    } finally {
      db.close();
    }
  });

  test('批次失败时回滚游标和写入，重启后可从原位置继续', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      for (const suffix of ['1', '2']) {
        insertMessage(db, { id: `message-${suffix}`, senderId: 'user-1' });
        insertArtifact(db, {
          id: `artifact-${suffix}`,
          messageId: `message-${suffix}`,
          filename: `${suffix}.md`,
          mimeType: 'text/markdown',
        });
      }
      db.exec(`CREATE TRIGGER fail_second_document
        BEFORE INSERT ON channel_documents
        WHEN NEW.id = 'channel-document:artifact-2'
        BEGIN
          SELECT RAISE(ABORT, 'simulated backfill interruption');
        END;`);
      const backfill = createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', batchSize: 10, now: () => 500,
      });

      expect(() => backfill.runBatch()).toThrow('simulated backfill interruption');
      expect(db.prepare('SELECT id FROM channel_documents').all()).toEqual([]);
      expect(db.prepare('SELECT id FROM channel_file_backfill_progress').all()).toEqual([]);

      db.exec('DROP TRIGGER fail_second_document');
      expect(backfill.runBatch()).toMatchObject({ processed: 2, completed: true });
      expect(db.prepare('SELECT id FROM channel_documents').all()).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('大批量历史附件使用稳定分页直至完成', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      insertChannel(db);
      for (let index = 0; index < 205; index += 1) {
        const suffix = String(index).padStart(3, '0');
        insertMessage(db, { id: `message-${suffix}`, senderId: 'user-1' });
        insertArtifact(db, {
          id: `artifact-${suffix}`,
          messageId: `message-${suffix}`,
          filename: `${suffix}.txt`,
          mimeType: 'text/plain',
          createdAt: 100 + index,
        });
      }
      const backfill = createChannelFileBackfill({
        db, dataDir: '/srv/agentbean', batchSize: 100, now: () => 500,
      });

      expect(backfill.runBatch()).toMatchObject({ processed: 100, completed: false });
      expect(backfill.runBatch()).toMatchObject({ processed: 100, completed: false });
      expect(backfill.runBatch()).toMatchObject({
        processed: 5,
        completed: true,
        cursor: { createdAt: 304, artifactId: 'artifact-204' },
      });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM artifacts WHERE artifact_role = 'attachment'",
      ).get()).toEqual({ count: 205 });
    } finally {
      db.close();
    }
  });
});

function insertChannel(db: SqliteDatabase): void {
  db.prepare(`INSERT INTO channels (
    id, team_id, kind, name, visibility, created_by, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'channel-1', 'team-1', 'channel', 'general', 'public', 'user-1', 1,
  );
}

function insertMessage(
  db: SqliteDatabase,
  input: { id: string; threadId?: string; senderId: string; metaJson?: string },
): void {
  db.prepare(`INSERT INTO messages (
    id, team_id, channel_id, thread_id, sender_kind, sender_id, body, meta_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id,
    'team-1',
    'channel-1',
    input.threadId ?? null,
    'human',
    input.senderId,
    'legacy',
    input.metaJson ?? null,
    50,
  );
}

function insertArtifact(
  db: SqliteDatabase,
  input: {
    id: string;
    messageId?: string;
    workspaceRunId?: string;
    filename: string;
    mimeType: string;
    storagePath?: string;
    relativePath?: string;
    artifactRole?: string;
    sourceRootId?: string;
    sourceRootKind?: string;
    createdAt?: number;
  },
): void {
  db.prepare(`INSERT INTO artifacts (
    id, team_id, channel_id, message_id, workspace_run_id, uploader_id,
    filename, mime_type, size_bytes, storage_path, relative_path, artifact_role,
    source_root_id, source_root_kind, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id,
    'team-1',
    'channel-1',
    input.messageId ?? null,
    input.workspaceRunId ?? null,
    'user-1',
    input.filename,
    input.mimeType,
    5,
    input.storagePath ?? null,
    input.relativePath ?? null,
    input.artifactRole ?? null,
    input.sourceRootId ?? null,
    input.sourceRootKind ?? null,
    input.createdAt ?? 100,
  );
}

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { MessageRow, ArtifactRow, TaskRow, TaskStatus } from './db.js';
import { newId } from './ids.js';

export interface StorageSpace {
  networkId: string;
  db: Database.Database;
  dbPath: string;
  artifactDir: string;
  messages: {
    append(m: MessageRow): void;
    listByChannel(channelId: string, limit: number): MessageRow[];
  };
  artifacts: {
    create(input: {
      id: string; messageId: string | null;
      uploaderId: string; filename: string; mimeType: string;
      sizeBytes: number; storagePath: string; createdAt: number;
      metaJson?: string | null;
    }): void;
    get(id: string): ArtifactRow | null;
    listByMessage(messageId: string): ArtifactRow[];
    bindMessageId(artifactIds: string[], messageId: string): void;
  };
  tasks: {
    create(input: { id?: string; title: string; description?: string; status?: TaskStatus; creatorId: string; assigneeId?: string; channelId?: string; tags?: string[]; sortOrder?: number; createdAt: number }): TaskRow;
    get(id: string): TaskRow | null;
    list(channelId?: string): TaskRow[];
    update(id: string, input: { title?: string; description?: string; status?: TaskStatus; assigneeId?: string | null; channelId?: string | null; tags?: string[]; sortOrder?: number }): void;
    delete(id: string): void;
    updateStatus(id: string, status: TaskStatus): void;
    updateSort(id: string, sortOrder: number): void;
  };
}

const NETWORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_members_agent ON channel_members(agent_id);

CREATE TABLE IF NOT EXISTS channel_user_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_members_user ON channel_user_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  sender_kind TEXT NOT NULL,
  sender_id   TEXT,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  meta_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  message_id   TEXT,
  uploader_id  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  meta_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'todo',
  creator_id  TEXT NOT NULL,
  assignee_id TEXT,
  channel_id  TEXT,
  tags        TEXT DEFAULT '[]',
  sort_order  REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id);
`;

function rowToMessage(r: any): MessageRow {
  return {
    id: r.id, channelId: r.channel_id, senderKind: r.sender_kind,
    senderId: r.sender_id, body: r.body, createdAt: r.created_at, metaJson: r.meta_json,
  };
}

function rowToArtifact(r: any): ArtifactRow {
  return {
    id: r.id, channelId: r.channel_id ?? '', messageId: r.message_id,
    uploaderId: r.uploader_id, filename: r.filename, mimeType: r.mime_type,
    sizeBytes: r.size_bytes, storagePath: r.storage_path,
    createdAt: r.created_at, metaJson: r.meta_json,
  };
}

function createDao(raw: Database.Database): Pick<StorageSpace, 'messages' | 'artifacts' | 'tasks'> {
  const messageAppend = raw.prepare(`
    INSERT INTO messages (id, channel_id, sender_kind, sender_id, body, created_at, meta_json)
    VALUES (@id, @channelId, @senderKind, @senderId, @body, @createdAt, @metaJson)
  `);
  const messageList = raw.prepare(`
    SELECT * FROM messages WHERE channel_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  const artifactCreate = raw.prepare(`
    INSERT INTO artifacts (id, message_id, uploader_id, filename, mime_type, size_bytes, storage_path, created_at, meta_json)
    VALUES (@id, @messageId, @uploaderId, @filename, @mimeType, @sizeBytes, @storagePath, @createdAt, @metaJson)
  `);
  const artifactGet = raw.prepare(`SELECT * FROM artifacts WHERE id = ?`);
  const artifactListByMessage = raw.prepare(`
    SELECT * FROM artifacts WHERE message_id = ?
    ORDER BY created_at ASC
  `);
  const artifactBindMessage = raw.prepare(`
    UPDATE artifacts SET message_id = ? WHERE id = ?
  `);

  // Task statements
  const taskCreate = raw.prepare(`
    INSERT INTO tasks (id, title, description, status, creator_id, assignee_id, channel_id, tags, sort_order, created_at, updated_at)
    VALUES (@id, @title, @description, @status, @creatorId, @assigneeId, @channelId, @tags, @sortOrder, @createdAt, @updatedAt)
  `);
  const taskGet = raw.prepare(`SELECT * FROM tasks WHERE id = ?`);
  const taskListAll = raw.prepare(`SELECT * FROM tasks ORDER BY sort_order ASC, created_at DESC`);
  const taskListByChannel = raw.prepare(`SELECT * FROM tasks WHERE channel_id = ? ORDER BY sort_order ASC, created_at DESC`);
  const taskUpdate = raw.prepare(`
    UPDATE tasks SET title = @title, description = @description, status = @status,
      assignee_id = @assigneeId, channel_id = @channelId, tags = @tags, sort_order = @sortOrder, updated_at = @updatedAt
    WHERE id = @id
  `);
  const taskDelete = raw.prepare(`DELETE FROM tasks WHERE id = ?`);
  const taskUpdateStatus = raw.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`);
  const taskUpdateSort = raw.prepare(`UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?`);

  function rowToTask(r: any): TaskRow {
    return {
      id: r.id,
      title: r.title,
      description: r.description ?? null,
      status: r.status as TaskStatus,
      creatorId: r.creator_id,
      assigneeId: r.assignee_id ?? null,
      channelId: r.channel_id ?? null,
      tags: (() => { try { return JSON.parse(r.tags); } catch { return []; } })(),
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  return {
    messages: {
      append: (m) => { messageAppend.run(m); },
      listByChannel: (channelId, limit) =>
        messageList.all(channelId, limit).map(rowToMessage).reverse(),
    },
    artifacts: {
      create: (input) => {
        artifactCreate.run({
          ...input,
          messageId: input.messageId ?? null,
          metaJson: input.metaJson ?? null,
        });
      },
      get: (id) => {
        const r = artifactGet.get(id) as any;
        return r ? rowToArtifact(r) : null;
      },
      listByMessage: (messageId) =>
        artifactListByMessage.all(messageId).map(rowToArtifact),
      bindMessageId: (artifactIds, messageId) => {
        for (const id of artifactIds) artifactBindMessage.run(messageId, id);
      },
    },
    tasks: {
      create: (input) => {
        const id = input.id ?? newId();
        const now = input.createdAt;
        const row = {
          id,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? 'todo',
          creatorId: input.creatorId,
          assigneeId: input.assigneeId ?? null,
          channelId: input.channelId ?? null,
          tags: JSON.stringify(input.tags ?? []),
          sortOrder: input.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        };
        taskCreate.run(row);
        return rowToTask(taskGet.get(id) as any);
      },
      get: (id) => {
        const r = taskGet.get(id) as any;
        return r ? rowToTask(r) : null;
      },
      list: (channelId) => {
        const rows = channelId ? taskListByChannel.all(channelId) as any[] : taskListAll.all() as any[];
        return rows.map(rowToTask);
      },
      update: (id, input) => {
        const existing = taskGet.get(id) as any;
        if (!existing) return;
        taskUpdate.run({
          id,
          title: input.title ?? existing.title,
          description: input.description !== undefined ? input.description : existing.description,
          status: input.status ?? existing.status,
          assigneeId: input.assigneeId !== undefined ? input.assigneeId : existing.assignee_id,
          channelId: input.channelId !== undefined ? input.channelId : existing.channel_id,
          tags: input.tags ? JSON.stringify(input.tags) : existing.tags,
          sortOrder: input.sortOrder ?? existing.sort_order,
          updatedAt: Date.now(),
        });
      },
      delete: (id) => { taskDelete.run(id); },
      updateStatus: (id, status) => { taskUpdateStatus.run(status, Date.now(), id); },
      updateSort: (id, sortOrder) => { taskUpdateSort.run(sortOrder, Date.now(), id); },
    },
  };
}

export class StorageManager {
  private spaces = new Map<string, StorageSpace>();
  private baseDir: string;

  constructor(baseDir: string = './data/storage') {
    this.baseDir = baseDir;
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  }

  createSpace(networkId: string): StorageSpace {
    const spaceDir = join(this.baseDir, networkId);
    const dbPath = join(spaceDir, 'db.sqlite');
    const artifactDir = join(spaceDir, 'artifacts');

    if (!existsSync(spaceDir)) mkdirSync(spaceDir, { recursive: true });
    if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true });

    const existing = this.spaces.get(networkId);
    if (existing) {
      try { existing.db.close(); } catch {}
      this.spaces.delete(networkId);
    }

    const db = new Database(dbPath);
    db.exec(NETWORK_SCHEMA);
    try { db.exec(`ALTER TABLE pipeline_runs ADD COLUMN name TEXT`); } catch {}
    try { db.exec(`ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
    try { db.exec(`ALTER TABLE channels ADD COLUMN created_by TEXT`); } catch {}

    const dao = createDao(db);
    const space: StorageSpace = { networkId, db, dbPath, artifactDir, ...dao };
    this.spaces.set(networkId, space);
    return space;
  }

  getSpace(networkId: string): StorageSpace {
    const cached = this.spaces.get(networkId);
    if (cached) return cached;

    const spaceDir = join(this.baseDir, networkId);
    const dbPath = join(spaceDir, 'db.sqlite');
    const artifactDir = join(spaceDir, 'artifacts');

    if (!existsSync(dbPath)) {
      return this.createSpace(networkId);
    }

    const db = new Database(dbPath);
    db.exec(NETWORK_SCHEMA);
    try { db.exec(`ALTER TABLE pipeline_runs ADD COLUMN name TEXT`); } catch {}
    try { db.exec(`ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
    try { db.exec(`ALTER TABLE channels ADD COLUMN created_by TEXT`); } catch {}
    const dao = createDao(db);
    const space: StorageSpace = { networkId, db, dbPath, artifactDir, ...dao };
    this.spaces.set(networkId, space);
    return space;
  }

  closeAll(): void {
    for (const space of this.spaces.values()) {
      space.db.close();
    }
    this.spaces.clear();
  }
}

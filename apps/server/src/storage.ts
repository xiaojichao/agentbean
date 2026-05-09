import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { MessageRow, ArtifactRow } from './db.js';

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
}

const NETWORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_members_agent ON channel_members(agent_id);

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

function createDao(raw: Database.Database): Pick<StorageSpace, 'messages' | 'artifacts'> {
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

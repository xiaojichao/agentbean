import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import {
  initialChannelDocumentIds,
  isMarkdownArtifact,
  sanitizeMarkdownFilename,
} from '../../application/channel-document-policy.js';
import { supportsArtifactPreviewMime } from '../../application/artifact-preview-service.js';
import type { SqliteDatabase } from './repositories.js';

const BACKFILL_ID = 'channel-files-v1';
const DEFAULT_BATCH_SIZE = 100;
const LEGACY_PREVIEW_PRIORITY = -100;

interface BackfillCursor {
  createdAt: number;
  artifactId: string;
}

interface ArtifactBackfillRow {
  id: string;
  teamId: string;
  channelId: string;
  messageId?: string;
  workspaceRunId?: string;
  uploaderId: string;
  filename: string;
  mimeType: string;
  storagePath?: string;
  relativePath?: string;
  role?: string;
  sourceRootId?: string;
  sourceRootKind?: string;
  createdAt: number;
  messageMeta?: string;
  messageSenderId?: string;
  messageExists: boolean;
}

export interface ChannelFileBackfillResult {
  processed: number;
  completed: boolean;
  cursor?: BackfillCursor;
}

export function createChannelFileBackfillIfSupported(input: {
  db: SqliteDatabase;
  dataDir: string;
  batchSize?: number;
  now?: () => number;
}) {
  const progressTable = input.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_file_backfill_progress'",
  ).get();
  return progressTable ? createChannelFileBackfill(input) : undefined;
}

export function createChannelFileBackfill(input: {
  db: SqliteDatabase;
  dataDir: string;
  batchSize?: number;
  now?: () => number;
}) {
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? DEFAULT_BATCH_SIZE));
  const now = input.now ?? (() => Date.now());

  const runBatch = (): ChannelFileBackfillResult => {
    const progress = readProgress(input.db);
    const rows = listNextArtifacts(input.db, progress, batchSize + 1);
    const batch = rows.slice(0, batchSize);
    const completed = rows.length <= batchSize;
    const cursor = batch.length > 0
      ? { createdAt: batch[batch.length - 1]!.createdAt, artifactId: batch[batch.length - 1]!.id }
      : progress;
    const updatedAt = now();

    input.db.transaction(() => {
      for (const artifact of batch) {
        backfillArtifact(input.db, input.dataDir, artifact, updatedAt);
      }
      saveProgress(input.db, cursor, completed ? updatedAt : undefined, updatedAt);
    })();

    return {
      processed: batch.length,
      completed,
      ...(cursor ? { cursor } : {}),
    };
  };

  return { runBatch };
}

function readProgress(db: SqliteDatabase): BackfillCursor | undefined {
  const row = db.prepare(`SELECT cursor_created_at, cursor_artifact_id
    FROM channel_file_backfill_progress WHERE id = ?`).get(BACKFILL_ID) as
    | { cursor_created_at?: unknown; cursor_artifact_id?: unknown }
    | undefined;
  return typeof row?.cursor_created_at === 'number' && typeof row.cursor_artifact_id === 'string'
    ? { createdAt: row.cursor_created_at, artifactId: row.cursor_artifact_id }
    : undefined;
}

function listNextArtifacts(
  db: SqliteDatabase,
  cursor: BackfillCursor | undefined,
  limit: number,
): ArtifactBackfillRow[] {
  const rows = cursor
    ? db.prepare(`${artifactBackfillSelect()}
        WHERE a.created_at > ? OR (a.created_at = ? AND a.id > ?)
        ORDER BY a.created_at, a.id LIMIT ?`)
        .all(cursor.createdAt, cursor.createdAt, cursor.artifactId, limit)
    : db.prepare(`${artifactBackfillSelect()}
        ORDER BY a.created_at, a.id LIMIT ?`).all(limit);
  return rows.map(mapArtifactBackfillRow);
}

function artifactBackfillSelect(): string {
  return `SELECT
    a.id,
    a.team_id,
    a.channel_id,
    a.message_id,
    a.workspace_run_id,
    a.uploader_id,
    a.filename,
    a.mime_type,
    a.storage_path,
    a.relative_path,
    a.artifact_role,
    a.source_root_id,
    a.source_root_kind,
    a.created_at,
    m.meta_json AS message_meta_json,
    m.sender_id AS message_sender_id,
    m.id AS joined_message_id
  FROM artifacts a
  LEFT JOIN messages m ON m.id = a.message_id`;
}

function mapArtifactBackfillRow(row: unknown): ArtifactBackfillRow {
  const value = row as Record<string, unknown>;
  return {
    id: requiredString(value.id, 'artifacts.id'),
    teamId: requiredString(value.team_id, 'artifacts.team_id'),
    channelId: requiredString(value.channel_id, 'artifacts.channel_id'),
    messageId: optionalString(value.message_id),
    workspaceRunId: optionalString(value.workspace_run_id),
    uploaderId: requiredString(value.uploader_id, 'artifacts.uploader_id'),
    filename: requiredString(value.filename, 'artifacts.filename'),
    mimeType: requiredString(value.mime_type, 'artifacts.mime_type'),
    storagePath: optionalString(value.storage_path),
    relativePath: optionalString(value.relative_path),
    role: optionalString(value.artifact_role),
    sourceRootId: optionalString(value.source_root_id),
    sourceRootKind: optionalString(value.source_root_kind),
    createdAt: requiredNumber(value.created_at, 'artifacts.created_at'),
    messageMeta: optionalString(value.message_meta_json),
    messageSenderId: optionalString(value.message_sender_id),
    messageExists: typeof value.joined_message_id === 'string',
  };
}

function backfillArtifact(
  db: SqliteDatabase,
  dataDir: string,
  artifact: ArtifactBackfillRow,
  updatedAt: number,
): void {
  const deletedMessage = artifact.messageExists && isDeletedMessageMeta(artifact.messageMeta);
  const inferredLegacyRunRole = artifact.workspaceRunId !== undefined
    && artifact.role === 'attachment'
    && artifact.sourceRootKind === 'legacy_run'
    && artifact.sourceRootId === `legacy_run:${artifact.workspaceRunId}`;
  const runScopedArtifact = artifact.workspaceRunId !== undefined
    && (artifact.role !== 'attachment' || inferredLegacyRunRole);
  if (runScopedArtifact) {
    db.prepare(`UPDATE artifacts SET
      artifact_role = CASE
        WHEN artifact_role IS NULL OR ? THEN 'run_output'
        ELSE artifact_role
      END,
      source_root_id = COALESCE(source_root_id, ?),
      source_root_kind = COALESCE(source_root_kind, 'legacy_run'),
      source_root_label = COALESCE(source_root_label, '历史运行产物'),
      relative_path = ?
      WHERE id = ?`).run(
      inferredLegacyRunRole ? 1 : 0,
      `legacy_run:${artifact.workspaceRunId}`,
      safeRelativePath(artifact),
      artifact.id,
    );
  } else if (artifact.messageExists && !deletedMessage) {
    db.prepare(`UPDATE artifacts SET artifact_role = COALESCE(artifact_role, 'attachment'),
      relative_path = ?
      WHERE id = ?`).run(safeRelativePath(artifact), artifact.id);
    if (isMarkdownArtifact(artifact)) {
      createInitialDocument(db, artifact);
    }
  } else if (artifact.workspaceRunId) {
    db.prepare(`UPDATE artifacts SET
      artifact_role = COALESCE(artifact_role, 'run_output'),
      source_root_id = COALESCE(source_root_id, ?),
      source_root_kind = COALESCE(source_root_kind, 'legacy_run'),
      source_root_label = COALESCE(source_root_label, '历史运行产物'),
      relative_path = ?
      WHERE id = ?`).run(
      `legacy_run:${artifact.workspaceRunId}`,
      safeRelativePath(artifact),
      artifact.id,
    );
  }

  const inputPath = previewInputPath(dataDir, artifact.storagePath);
  if (!deletedMessage && inputPath && supportsArtifactPreviewMime(normalizedMediaType(artifact.mimeType))) {
    db.prepare(`INSERT OR IGNORE INTO artifact_preview_jobs (
      id, artifact_id, team_id, input_path, mime_type, attempts, status, priority, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?)`).run(
      `legacy-preview:${artifact.id}`,
      artifact.id,
      artifact.teamId,
      inputPath,
      artifact.mimeType,
      LEGACY_PREVIEW_PRIORITY,
      updatedAt,
    );
  }
}

function createInitialDocument(db: SqliteDatabase, artifact: ArtifactBackfillRow): void {
  const { documentId, revisionId } = initialChannelDocumentIds(artifact.id);
  const createdBy = artifact.messageSenderId ?? artifact.uploaderId;
  db.prepare(`INSERT OR IGNORE INTO channel_document_revisions (
    id, document_id, artifact_id, revision, created_by, created_at
  ) VALUES (?, ?, ?, 1, ?, ?)`).run(
    revisionId,
    documentId,
    artifact.id,
    createdBy,
    artifact.createdAt,
  );
  db.prepare(`INSERT OR IGNORE INTO channel_documents (
    id, team_id, channel_id, filename, current_revision_id, created_at, updated_at
  )
  SELECT ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (
    SELECT 1 FROM channel_document_revisions
    WHERE id = ? AND document_id = ? AND artifact_id = ?
  )`).run(
    documentId,
    artifact.teamId,
    artifact.channelId,
    sanitizeMarkdownFilename(artifact.filename),
    revisionId,
    artifact.createdAt,
    artifact.createdAt,
    revisionId,
    documentId,
    artifact.id,
  );
  if (artifact.messageId) {
    db.prepare(`INSERT OR IGNORE INTO channel_document_publications (
      id, revision_id, message_id, published_by, published_at
    )
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM channel_document_revisions
      WHERE id = ? AND document_id = ? AND artifact_id = ?
    )`).run(
      `${revisionId}:publication`,
      revisionId,
      artifact.messageId,
      createdBy,
      artifact.createdAt,
      revisionId,
      documentId,
      artifact.id,
    );
  }
}

function saveProgress(
  db: SqliteDatabase,
  cursor: BackfillCursor | undefined,
  completedAt: number | undefined,
  updatedAt: number,
): void {
  db.prepare(`INSERT INTO channel_file_backfill_progress (
    id, cursor_created_at, cursor_artifact_id, completed_at, updated_at
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    cursor_created_at = excluded.cursor_created_at,
    cursor_artifact_id = excluded.cursor_artifact_id,
    completed_at = excluded.completed_at,
    updated_at = excluded.updated_at`).run(
    BACKFILL_ID,
    cursor?.createdAt ?? null,
    cursor?.artifactId ?? null,
    completedAt ?? null,
    updatedAt,
  );
}

function safeRelativePath(artifact: ArtifactBackfillRow): string {
  if (artifact.relativePath && isSafePublicRelativePath(artifact.relativePath)) {
    return artifact.relativePath;
  }
  const filename = artifact.filename.trim();
  if (filename && filename !== '.' && filename !== '..' && !filename.includes('/')
    && !filename.includes('\\') && !/[\u0000-\u001f]/.test(filename)) {
    return filename;
  }
  const stableSuffix = createHash('sha256').update(artifact.id).digest('hex').slice(0, 12);
  return `未分组/历史文件-${stableSuffix}`;
}

function isSafePublicRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')
    || /[\u0000-\u001f]/.test(value) || /^[a-z]:/i.test(value)) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isDeletedMessageMeta(metaJson: string | undefined): boolean {
  if (!metaJson) return false;
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && 'deletedAt' in parsed);
  } catch {
    return false;
  }
}

function previewInputPath(dataDir: string, storagePath: string | undefined): string | undefined {
  if (!storagePath) return undefined;
  const dataRoot = resolve(dataDir);
  const absolutePath = resolve(dataRoot, storagePath);
  return absolutePath === dataRoot || absolutePath.startsWith(`${dataRoot}${sep}`)
    ? absolutePath
    : undefined;
}

function normalizedMediaType(mimeType: string): string {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Expected ${field} to be text`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') throw new Error(`Expected ${field} to be a number`);
  return value;
}

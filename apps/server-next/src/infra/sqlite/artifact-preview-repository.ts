import type {
  ArtifactPreviewJob,
  ArtifactPreviewRepository,
} from '../../application/artifact-preview-service.js';
import type { SqliteDatabase } from './repositories.js';

export function createSqliteArtifactPreviewRepository(
  db: SqliteDatabase,
): ArtifactPreviewRepository {
  return {
    async get(artifactId) {
      return mapPreviewJob(db.prepare(
        'SELECT * FROM artifact_preview_jobs WHERE artifact_id = ?',
      ).get(artifactId));
    },

    async createIfAbsent(job) {
      db.prepare(`INSERT OR IGNORE INTO artifact_preview_jobs (
        id, artifact_id, team_id, input_path, mime_type, attempts, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        job.id,
        job.artifactId,
        job.teamId,
        job.inputPath,
        job.mimeType,
        job.attempts,
        job.status,
        job.updatedAt,
      );
      return mapPreviewJob(db.prepare(
        'SELECT * FROM artifact_preview_jobs WHERE artifact_id = ?',
      ).get(job.artifactId))!;
    },

    async claimNext(input) {
      const candidate = mapPreviewJob(db.prepare(`SELECT *
        FROM artifact_preview_jobs
        WHERE attempts < ?
          AND (status = 'pending' OR (status = 'processing' AND leased_until <= ?))
        ORDER BY priority DESC, updated_at ASC, id ASC
        LIMIT 1`).get(input.maxAttempts, input.now));
      if (!candidate) return undefined;
      const result = db.prepare(`UPDATE artifact_preview_jobs
        SET status = 'processing',
            attempts = attempts + 1,
            leased_until = ?,
            updated_at = ?
        WHERE artifact_id = ?
          AND attempts = ?
          AND (status = 'pending' OR (status = 'processing' AND leased_until <= ?))`).run(
        input.leasedUntil,
        input.now,
        candidate.artifactId,
        candidate.attempts,
        input.now,
      ) as { changes?: number };
      if (result.changes !== 1) return undefined;
      return mapPreviewJob(db.prepare(
        'SELECT * FROM artifact_preview_jobs WHERE artifact_id = ?',
      ).get(candidate.artifactId));
    },

    async save(job) {
      db.prepare(`UPDATE artifact_preview_jobs SET
        attempts = ?,
        status = ?,
        leased_until = ?,
        error_code = ?,
        width = ?,
        height = ?,
        duration_ms = ?,
        updated_at = ?
        WHERE artifact_id = ?`).run(
        job.attempts,
        job.status,
        job.leasedUntil ?? null,
        job.errorCode ?? null,
        job.width ?? null,
        job.height ?? null,
        job.durationMs ?? null,
        job.updatedAt,
        job.artifactId,
      );
    },
  };
}

function mapPreviewJob(row: unknown): ArtifactPreviewJob | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = row as Record<string, unknown>;
  const status = value.status;
  if (status !== 'pending' && status !== 'processing' && status !== 'ready'
    && status !== 'failed' && status !== 'unsupported') return undefined;
  return {
    id: String(value.id),
    artifactId: String(value.artifact_id),
    teamId: String(value.team_id),
    inputPath: String(value.input_path),
    mimeType: String(value.mime_type),
    attempts: Number(value.attempts),
    status,
    leasedUntil: nullableNumber(value.leased_until),
    errorCode: nullableString(value.error_code),
    width: nullableNumber(value.width),
    height: nullableNumber(value.height),
    durationMs: nullableNumber(value.duration_ms),
    updatedAt: Number(value.updated_at),
  };
}

function nullableNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

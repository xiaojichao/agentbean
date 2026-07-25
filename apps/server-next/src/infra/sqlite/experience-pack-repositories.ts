import type {
  ChannelExperienceAttachmentRecord,
  ExperiencePackRecord,
  ExperiencePackRepositories,
  ExperiencePackSourceRecord,
} from '../../application/experience-pack-repositories.js';
import type { SqliteDatabase } from './repositories.js';

/**
 * Experience Pack SQLite 持久化（issue #722）。
 *
 * 三表：experience_packs、experience_pack_sources、channel_experience_attachments。
 * 遵循 `memory-repositories.ts` 模式：prepare → run/get/all → map(unknown) → 返回。
 */

// ── 映射辅助（与 memory-repositories.ts 同签名： (value: unknown, key: string)） ──

function text(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) throw new Error(`Expected object for key "${key}"`);
  const v = (value as Record<string, unknown>)[key];
  if (typeof v !== 'string') throw new Error(`Expected string for key "${key}", got ${typeof v}`);
  return v;
}

function optionalText(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`Expected string for key "${key}", got ${typeof v}`);
  return v;
}

function number(value: unknown, key: string): number {
  if (typeof value !== 'object' || value === null) throw new Error(`Expected object for key "${key}"`);
  const v = (value as Record<string, unknown>)[key];
  if (typeof v !== 'number') throw new Error(`Expected number for key "${key}", got ${typeof v}`);
  return v;
}

// ── 行映射（value: unknown 签名，与 memory-repositories.ts 一致）────────────────

function mapPackRow(value: unknown): ExperiencePackRecord | null {
  if (!value) return null;
  return {
    id: text(value, 'id'),
    teamId: text(value, 'team_id'),
    status: text(value, 'status') as ExperiencePackRecord['status'],
    title: text(value, 'title'),
    summary: optionalText(value, 'summary'),
    sourceChannelId: text(value, 'source_channel_id'),
    applicabilityConditions: optionalText(value, 'applicability_conditions'),
    exclusionConditions: optionalText(value, 'exclusion_conditions'),
    conclusions: optionalText(value, 'conclusions'),
    limitations: optionalText(value, 'limitations'),
    approvedByUserId: optionalText(value, 'approved_by_user_id'),
    createdByUserId: optionalText(value, 'created_by_user_id'),
    sourceInvalidReason: optionalText(value, 'source_invalid_reason'),
    createdAt: number(value, 'created_at'),
    updatedAt: number(value, 'updated_at'),
  };
}

function mapPackRowRequired(value: unknown): ExperiencePackRecord {
  const result = mapPackRow(value);
  if (!result) throw new Error('Expected experience_pack row');
  return result;
}

function mapSourceRow(value: unknown): ExperiencePackSourceRecord | null {
  if (!value) return null;
  return {
    packId: text(value, 'pack_id'),
    teamId: text(value, 'team_id'),
    sourceKind: text(value, 'source_kind') as ExperiencePackSourceRecord['sourceKind'],
    sourceId: text(value, 'source_id'),
    snapshotHash: text(value, 'snapshot_hash'),
    sourceScopeType: text(value, 'source_scope_type'),
    sourceScopeRef: text(value, 'source_scope_ref'),
    createdAt: number(value, 'created_at'),
  };
}

function mapSourceRowRequired(value: unknown): ExperiencePackSourceRecord {
  const result = mapSourceRow(value);
  if (!result) throw new Error('Expected experience_pack_source row');
  return result;
}

function mapAttachmentRow(value: unknown): ChannelExperienceAttachmentRecord | null {
  if (!value) return null;
  return {
    id: text(value, 'id'),
    packId: text(value, 'pack_id'),
    channelId: text(value, 'channel_id'),
    teamId: text(value, 'team_id'),
    attachedByUserId: text(value, 'attached_by_user_id'),
    attachedAt: number(value, 'attached_at'),
  };
}

function mapAttachmentRowRequired(value: unknown): ChannelExperienceAttachmentRecord {
  const result = mapAttachmentRow(value);
  if (!result) throw new Error('Expected channel_experience_attachment row');
  return result;
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────────

export function createSqliteExperiencePackRepositories(db: SqliteDatabase): ExperiencePackRepositories {
  return {
    packs: {
      async create(record) {
        db.prepare(`INSERT INTO experience_packs
          (id, team_id, status, title, summary, source_channel_id,
           applicability_conditions, exclusion_conditions, conclusions, limitations,
           approved_by_user_id, created_by_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            record.id, record.teamId, record.status, record.title,
            record.summary ?? null, record.sourceChannelId,
            record.applicabilityConditions ?? null, record.exclusionConditions ?? null,
            record.conclusions ?? null, record.limitations ?? null,
            record.approvedByUserId ?? null, record.createdByUserId ?? null,
            record.createdAt, record.updatedAt,
          );
        return record;
      },
      async getById(input) {
        return mapPackRow(
          db.prepare('SELECT * FROM experience_packs WHERE team_id = ? AND id = ?')
            .get(input.teamId, input.id),
        );
      },
      async listByTeam(input) {
        if (input.status) {
          return db.prepare(
            'SELECT * FROM experience_packs WHERE team_id = ? AND status = ? ORDER BY updated_at DESC, id',
          ).all(input.teamId, input.status).map(mapPackRowRequired);
        }
        return db.prepare(
          'SELECT * FROM experience_packs WHERE team_id = ? ORDER BY updated_at DESC, id',
        ).all(input.teamId).map(mapPackRowRequired);
      },
      async listBySourceChannel(input) {
        return db.prepare(
          'SELECT * FROM experience_packs WHERE team_id = ? AND source_channel_id = ? ORDER BY updated_at DESC, id',
        ).all(input.teamId, input.sourceChannelId).map(mapPackRowRequired);
      },
      async updateStatus(input) {
        const current = mapPackRow(
          db.prepare('SELECT * FROM experience_packs WHERE team_id = ? AND id = ?')
            .get(input.teamId, input.id),
        );
        if (!current || current.updatedAt !== input.expectedUpdatedAt) return null;
        const changes = (result: unknown): number =>
          typeof result === 'object' && result !== null ? (result as Record<string, unknown>).changes as number ?? 0 : 0;
        const result = db.prepare(
          'UPDATE experience_packs SET status = ?, approved_by_user_id = ?, source_invalid_reason = ?, updated_at = ? WHERE id = ? AND team_id = ? AND updated_at = ?',
        ).run(
          input.status,
          input.approvedByUserId ?? null,
          input.sourceInvalidReason ?? null,
          input.updatedAt,
          input.id,
          input.teamId,
          input.expectedUpdatedAt,
        );
        return changes(result) === 0 ? null : {
          ...current,
          status: input.status,
          approvedByUserId: input.approvedByUserId ?? current.approvedByUserId,
          sourceInvalidReason: input.sourceInvalidReason ?? current.sourceInvalidReason,
          updatedAt: input.updatedAt,
        };
      },
    },

    sources: {
      async create(record) {
        db.prepare(`INSERT INTO experience_pack_sources
          (pack_id, team_id, source_kind, source_id, snapshot_hash, source_scope_type, source_scope_ref, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            record.packId, record.teamId, record.sourceKind, record.sourceId,
            record.snapshotHash, record.sourceScopeType, record.sourceScopeRef, record.createdAt,
          );
        return record;
      },
      async listByPack(input) {
        return db.prepare(
          'SELECT * FROM experience_pack_sources WHERE team_id = ? AND pack_id = ? ORDER BY created_at, source_kind, source_id',
        ).all(input.teamId, input.packId).map(mapSourceRowRequired);
      },
    },

    attachments: {
      async create(record) {
        db.prepare(`INSERT INTO channel_experience_attachments
          (id, pack_id, channel_id, team_id, attached_by_user_id, attached_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.packId, record.channelId, record.teamId,
            record.attachedByUserId, record.attachedAt);
        return record;
      },
      async getByPackAndChannel(input) {
        return mapAttachmentRow(
          db.prepare(
            'SELECT * FROM channel_experience_attachments WHERE team_id = ? AND pack_id = ? AND channel_id = ?',
          ).get(input.teamId, input.packId, input.channelId),
        );
      },
      async listByChannel(input) {
        return db.prepare(
          'SELECT * FROM channel_experience_attachments WHERE team_id = ? AND channel_id = ? ORDER BY attached_at DESC',
        ).all(input.teamId, input.channelId).map(mapAttachmentRowRequired);
      },
      async listByPack(input) {
        return db.prepare(
          'SELECT * FROM channel_experience_attachments WHERE team_id = ? AND pack_id = ? ORDER BY attached_at DESC',
        ).all(input.teamId, input.packId).map(mapAttachmentRowRequired);
      },
      async delete(input) {
        db.prepare(
          'DELETE FROM channel_experience_attachments WHERE team_id = ? AND id = ?',
        ).run(input.teamId, input.id);
      },
    },
  };
}

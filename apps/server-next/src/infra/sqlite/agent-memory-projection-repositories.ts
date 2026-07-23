import type {
  AgentMemoryProjectionStatus,
  FormalMemoryKind,
  MemorySourceRefDto,
} from '../../../../../packages/contracts/src/index.js';
import type {
  AgentMemoryProjectionContentUpdateInput,
  AgentMemoryProjectionCreateInput,
  AgentMemoryProjectionRecord,
  AgentMemoryProjectionRepositories,
  AgentMemoryProjectionUnitOfWork,
  TeamAgentMemoryOptInRecord,
} from '../../application/agent-memory-projection-repositories.js';
import { serializeTransactions } from '../../application/transaction-serialization.js';
import type { SqliteDatabase } from './repositories.js';

function sqliteText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}
function sqliteInt(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'number' ? value : Number(value ?? 0);
}
function sqliteNullableInt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}
function sqliteNullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

function parseJsonArray<T = unknown>(text: string | null): readonly T[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as readonly T[]) : [];
  } catch {
    return [];
  }
}

function parseStringArray(text: string | null): readonly string[] {
  return parseJsonArray<string>(text).filter((item): item is string => typeof item === 'string');
}

function parseSourceRefs(text: string | null): readonly MemorySourceRefDto[] {
  return parseJsonArray<MemorySourceRefDto>(text).filter(
    (item): item is MemorySourceRefDto =>
      !!item
      && typeof item === 'object'
      && typeof (item as MemorySourceRefDto).sourceKind === 'string'
      && typeof (item as MemorySourceRefDto).sourceId === 'string'
      && typeof (item as MemorySourceRefDto).snapshotHash === 'string',
  );
}

function mapProjection(row: Record<string, unknown> | undefined): AgentMemoryProjectionRecord | null {
  if (!row) return null;
  const record: AgentMemoryProjectionRecord = {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    agentId: sqliteText(row, 'agent_id'),
    revision: sqliteInt(row, 'revision'),
    status: sqliteText(row, 'status') as AgentMemoryProjectionStatus,
    kind: sqliteText(row, 'kind') as FormalMemoryKind,
    content: sqliteText(row, 'content'),
    summary: sqliteNullableText(row, 'summary') ?? undefined,
    tags: parseStringArray(sqliteNullableText(row, 'tags_json')),
    sourceRefs: parseSourceRefs(sqliteNullableText(row, 'source_refs_json')),
    validFrom: sqliteInt(row, 'valid_from'),
    validUntil: sqliteNullableInt(row, 'valid_until'),
    publishedBy: sqliteNullableText(row, 'published_by'),
    publishedAt: sqliteNullableInt(row, 'published_at'),
    supersededById: sqliteNullableText(row, 'superseded_by_id'),
    withdrawnBy: sqliteNullableText(row, 'withdrawn_by') ?? undefined,
    withdrawnAt: sqliteNullableInt(row, 'withdrawn_at') ?? undefined,
    createdBy: sqliteText(row, 'created_by'),
    createdAt: sqliteInt(row, 'created_at'),
    updatedAt: sqliteInt(row, 'updated_at'),
  };
  return record;
}

function mapOptIn(row: Record<string, unknown> | undefined): TeamAgentMemoryOptInRecord | null {
  if (!row) return null;
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    agentId: sqliteText(row, 'agent_id'),
    projectionId: sqliteText(row, 'projection_id'),
    enabled: sqliteInt(row, 'enabled') === 1,
    updatedBy: sqliteText(row, 'updated_by'),
    updatedAt: sqliteInt(row, 'updated_at'),
  };
}

const PROJECTION_COLUMNS = `id, team_id, agent_id, revision, status, kind, content, summary, tags_json,
  source_refs_json, valid_from, valid_until, published_by, published_at, superseded_by_id,
  withdrawn_by, withdrawn_at, created_by, created_at, updated_at`;

export function createSqliteAgentMemoryProjectionRepositories(db: SqliteDatabase): AgentMemoryProjectionRepositories {
  return {
    projections: {
      async create(input) {
        db.prepare(`INSERT INTO agent_memory_projections (
            id, team_id, agent_id, revision, status, kind, content, summary, tags_json,
            source_refs_json, valid_from, valid_until, published_by, published_at, superseded_by_id,
            withdrawn_by, withdrawn_at, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`)
          .run(
            input.id, input.teamId, input.agentId, input.revision, input.status, input.kind,
            input.content, input.summary ?? null, JSON.stringify(input.tags),
            JSON.stringify(input.sourceRefs), input.validFrom, input.validUntil ?? null,
            input.createdBy, input.now, input.now,
          );
        return mapProjection(db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections WHERE id = ?`).get(input.id) as Record<string, unknown>)!;
      },
      async getById(id) {
        return mapProjection(db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections WHERE id = ?`).get(id) as Record<string, unknown> | undefined);
      },
      async getActiveByTeamAgent(teamId, agentId) {
        return mapProjection(db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections
          WHERE team_id = ? AND agent_id = ? AND status = 'active'`).get(teamId, agentId) as Record<string, unknown> | undefined);
      },
      async listByTeamAgent(teamId, agentId) {
        const rows = db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections
          WHERE team_id = ? AND agent_id = ? ORDER BY revision DESC`).all(teamId, agentId) as Record<string, unknown>[];
        return rows.map((row) => mapProjection(row)!).filter(Boolean);
      },
      async listActiveByTeam(teamId) {
        const rows = db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections
          WHERE team_id = ? AND status = 'active' ORDER BY agent_id, revision`).all(teamId) as Record<string, unknown>[];
        return rows.map((row) => mapProjection(row)!).filter(Boolean);
      },
      async updateContent(input) {
        db.prepare(`UPDATE agent_memory_projections SET
            kind = ?, content = ?, summary = ?, tags_json = ?, source_refs_json = ?,
            valid_until = ?, updated_at = ?
          WHERE id = ? AND status = 'draft'`)
          .run(
            input.kind, input.content, input.summary ?? null,
            JSON.stringify(input.tags), JSON.stringify(input.sourceRefs),
            input.validUntil ?? null, input.now, input.id,
          );
        return mapProjection(db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections WHERE id = ?`).get(input.id) as Record<string, unknown> | undefined);
      },
      async supersedeActive(input) {
        const prior = mapProjection(db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections
          WHERE team_id = ? AND agent_id = ? AND status = 'active'`).get(input.teamId, input.agentId) as Record<string, unknown> | undefined);
        if (!prior) return null;
        db.prepare(`UPDATE agent_memory_projections SET status = 'superseded', superseded_by_id = ?, updated_at = ?
          WHERE id = ?`).run(input.newProjectionId, input.now, prior.id);
        return { ...prior, status: 'superseded', supersededById: input.newProjectionId, updatedAt: input.now };
      },
      async activate(input) {
        db.prepare(`UPDATE agent_memory_projections SET status = 'active', published_by = ?, published_at = ?, updated_at = ?
          WHERE id = ?`).run(input.actorId, input.now, input.now, input.id);
        return mapProjection(db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections WHERE id = ?`).get(input.id) as Record<string, unknown> | undefined);
      },
      async setStatus(input) {
        if (input.status === 'withdrawn') {
          db.prepare(`UPDATE agent_memory_projections SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = ?, updated_at = ?
            WHERE id = ? AND status = 'active'`).run(input.actorId ?? null, input.now, input.now, input.id);
        } else {
          db.prepare(`UPDATE agent_memory_projections SET status = ?, updated_at = ? WHERE id = ?`)
            .run(input.status, input.now, input.id);
        }
        return mapProjection(db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM agent_memory_projections WHERE id = ?`).get(input.id) as Record<string, unknown> | undefined);
      },
    },
    optIns: {
      async upsert(input) {
        db.prepare(`INSERT INTO team_agent_memory_opt_ins (
            id, team_id, agent_id, projection_id, enabled, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(team_id, agent_id) DO UPDATE SET
            projection_id = excluded.projection_id,
            enabled = excluded.enabled,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`)
          .run(
            input.id, input.teamId, input.agentId, input.projectionId,
            input.enabled ? 1 : 0, input.updatedBy, input.now,
          );
        return mapOptIn(db.prepare(`SELECT * FROM team_agent_memory_opt_ins WHERE team_id = ? AND agent_id = ?`).get(input.teamId, input.agentId) as Record<string, unknown> | undefined)!;
      },
      async getByTeamAgent(teamId, agentId) {
        return mapOptIn(db.prepare(`SELECT * FROM team_agent_memory_opt_ins WHERE team_id = ? AND agent_id = ?`).get(teamId, agentId) as Record<string, unknown> | undefined);
      },
      async listByTeam(teamId) {
        const rows = db.prepare(`SELECT * FROM team_agent_memory_opt_ins WHERE team_id = ?`).all(teamId) as Record<string, unknown>[];
        return rows.map((row) => mapOptIn(row)!).filter(Boolean);
      },
    },
  };
}

export function createSqliteAgentMemoryProjectionPersistence(db: SqliteDatabase): {
  repositories: AgentMemoryProjectionRepositories;
  unitOfWork: AgentMemoryProjectionUnitOfWork;
} {
  const repositories = createSqliteAgentMemoryProjectionRepositories(db);
  const runTransaction = serializeTransactions<AgentMemoryProjectionRepositories>(async (operation) => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = await operation(repositories);
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  });
  return {
    repositories,
    unitOfWork: { run: runTransaction },
  };
}

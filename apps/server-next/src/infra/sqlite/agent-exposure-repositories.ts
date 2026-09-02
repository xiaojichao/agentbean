import type {
  AgentAutoAcceptPolicyDto,
  AgentExposureAvailabilityDto,
  AgentExposureCapabilityDto,
  AgentExposureConstraintDto,
  AgentExposureManifestStatus,
  AgentExposureSkillDto,
} from '../../../../../packages/contracts/src/index.js';
import type {
  AgentAutoAcceptPolicyRecord,
  AgentExposureManifestRecord,
  AgentExposureRepositories,
  AgentExposureRestrictionRecord,
  AgentExposureUnitOfWork,
} from '../../application/agent-exposure-repositories.js';
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

function parseCapabilities(text: string | null): readonly AgentExposureCapabilityDto[] {
  return parseJsonArray<AgentExposureCapabilityDto>(text).filter(
    (item): item is AgentExposureCapabilityDto =>
      !!item && typeof item === 'object' && typeof item.name === 'string' && typeof item.description === 'string',
  );
}

function parseSkills(text: string | null): readonly AgentExposureSkillDto[] {
  return parseJsonArray<AgentExposureSkillDto>(text).filter(
    (item): item is AgentExposureSkillDto =>
      !!item && typeof item === 'object' && typeof item.name === 'string' && typeof item.description === 'string',
  );
}

function parseConstraints(text: string | null): readonly AgentExposureConstraintDto[] {
  return parseJsonArray<AgentExposureConstraintDto>(text).filter(
    (item): item is AgentExposureConstraintDto =>
      !!item && typeof item === 'object' && typeof item.kind === 'string' && typeof item.description === 'string',
  );
}

function parseAvailability(text: string | null): AgentExposureAvailabilityDto {
  if (!text) return { status: 'available' };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { status?: unknown; reason?: unknown };
      if (obj.status === 'available') return { status: 'available' };
      if (obj.status === 'unavailable') {
        return typeof obj.reason === 'string' ? { status: 'unavailable', reason: obj.reason } : { status: 'unavailable' };
      }
    }
  } catch {
    /* fall through */
  }
  return { status: 'available' };
}

function parseStringArray(text: string | null): readonly string[] {
  return parseJsonArray<string>(text).filter((item): item is string => typeof item === 'string');
}

function mapManifest(row: Record<string, unknown> | undefined): AgentExposureManifestRecord | null {
  if (!row) return null;
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    agentId: sqliteText(row, 'agent_id'),
    revision: sqliteInt(row, 'revision'),
    status: sqliteText(row, 'status') as AgentExposureManifestStatus,
    capabilities: parseCapabilities(sqliteNullableText(row, 'capabilities_json')),
    skills: parseSkills(sqliteNullableText(row, 'skills_json')),
    constraints: parseConstraints(sqliteNullableText(row, 'constraints_json')),
    availability: parseAvailability(sqliteNullableText(row, 'availability_json')),
    validFrom: sqliteInt(row, 'valid_from'),
    validUntil: sqliteNullableInt(row, 'valid_until'),
    publishedBy: sqliteNullableText(row, 'published_by'),
    publishedAt: sqliteNullableInt(row, 'published_at'),
    supersededById: sqliteNullableText(row, 'superseded_by_id'),
    createdBy: sqliteText(row, 'created_by'),
    createdAt: sqliteInt(row, 'created_at'),
    updatedAt: sqliteInt(row, 'updated_at'),
  };
}

function mapRestriction(row: Record<string, unknown> | undefined): AgentExposureRestrictionRecord | null {
  if (!row) return null;
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    agentId: sqliteText(row, 'agent_id'),
    manifestId: sqliteText(row, 'manifest_id'),
    disabledCapabilities: parseStringArray(sqliteNullableText(row, 'disabled_capabilities_json')),
    disabledSkills: parseStringArray(sqliteNullableText(row, 'disabled_skills_json')),
    updatedBy: sqliteText(row, 'updated_by'),
    updatedAt: sqliteInt(row, 'updated_at'),
  };
}

function mapAutoAcceptPolicy(row: Record<string, unknown> | undefined): AgentAutoAcceptPolicyRecord | null {
  if (!row) return null;
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    agentId: sqliteText(row, 'agent_id'),
    manifestId: sqliteText(row, 'manifest_id'),
    manifestRevision: sqliteInt(row, 'manifest_revision'),
    revision: sqliteInt(row, 'revision'),
    enabled: sqliteInt(row, 'enabled') === 1,
    allowedCapabilityIds: parseStringArray(sqliteNullableText(row, 'allowed_capability_ids_json')),
    allowUnspecifiedCapabilities: sqliteInt(row, 'allow_unspecified_capabilities') === 1,
    allowedRiskLevels: parseStringArray(sqliteNullableText(row, 'allowed_risk_levels_json'))
      .filter((value): value is AgentAutoAcceptPolicyDto['allowedRiskLevels'][number] =>
        value === 'low' || value === 'high'),
    allowFrozenProjectInputs: sqliteInt(row, 'allow_frozen_project_inputs') === 1,
    requireCompletePreview: sqliteInt(row, 'require_complete_preview') === 1,
    maxActiveClaims: sqliteInt(row, 'max_active_claims'),
    validUntil: sqliteNullableInt(row, 'valid_until'),
    updatedBy: sqliteText(row, 'updated_by'),
    createdAt: sqliteInt(row, 'created_at'),
    updatedAt: sqliteInt(row, 'updated_at'),
  };
}

const MANIFEST_COLUMNS = `id, team_id, agent_id, revision, status, capabilities_json, skills_json,
  constraints_json, availability_json, valid_from, valid_until, published_by, published_at,
  superseded_by_id, created_by, created_at, updated_at`;

export function createSqliteAgentExposureRepositories(db: SqliteDatabase): AgentExposureRepositories {
  return {
    manifests: {
      async create(input) {
        db.prepare(`INSERT INTO agent_exposure_manifests (
            id, team_id, agent_id, revision, status, capabilities_json, skills_json,
            constraints_json, availability_json, valid_from, valid_until, published_by, published_at,
            superseded_by_id, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`)
          .run(
            input.id, input.teamId, input.agentId, input.revision, input.status,
            JSON.stringify(input.capabilities), JSON.stringify(input.skills),
            JSON.stringify(input.constraints), JSON.stringify(input.availability),
            input.validFrom, input.validUntil ?? null,
            input.createdBy, input.now, input.now,
          );
        return mapManifest(db.prepare(`SELECT ${MANIFEST_COLUMNS} FROM agent_exposure_manifests WHERE id = ?`).get(input.id) as Record<string, unknown>)!;
      },
      async getById(id) {
        return mapManifest(db.prepare(`SELECT ${MANIFEST_COLUMNS} FROM agent_exposure_manifests WHERE id = ?`).get(id) as Record<string, unknown> | undefined);
      },
      async getActiveByTeamAgent(teamId, agentId) {
        return mapManifest(db.prepare(`SELECT ${MANIFEST_COLUMNS} FROM agent_exposure_manifests
          WHERE team_id = ? AND agent_id = ? AND status = 'active'`).get(teamId, agentId) as Record<string, unknown> | undefined);
      },
      async listByTeamAgent(teamId, agentId) {
        const rows = db.prepare(`SELECT ${MANIFEST_COLUMNS} FROM agent_exposure_manifests
          WHERE team_id = ? AND agent_id = ? ORDER BY revision DESC`).all(teamId, agentId) as Record<string, unknown>[];
        return rows.map((row) => mapManifest(row)!).filter(Boolean);
      },
      async updateContent(input) {
        db.prepare(`UPDATE agent_exposure_manifests SET
            capabilities_json = ?, skills_json = ?, constraints_json = ?, availability_json = ?,
            valid_until = ?, updated_at = ?
          WHERE id = ? AND status = 'draft'`)
          .run(
            JSON.stringify(input.capabilities), JSON.stringify(input.skills),
            JSON.stringify(input.constraints), JSON.stringify(input.availability),
            input.validUntil ?? null, input.now, input.id,
          );
        return mapManifest(db.prepare(`SELECT ${MANIFEST_COLUMNS} FROM agent_exposure_manifests WHERE id = ?`).get(input.id) as Record<string, unknown> | undefined);
      },
      async supersedeActive(input) {
        const prior = mapManifest(db.prepare(`SELECT ${MANIFEST_COLUMNS} FROM agent_exposure_manifests
          WHERE team_id = ? AND agent_id = ? AND status = 'active'`).get(input.teamId, input.agentId) as Record<string, unknown> | undefined);
        if (!prior) return null;
        db.prepare(`UPDATE agent_exposure_manifests SET status = 'superseded', superseded_by_id = ?, updated_at = ?
          WHERE id = ?`).run(input.newManifestId, input.now, prior.id);
        return { ...prior, status: 'superseded', supersededById: input.newManifestId, updatedAt: input.now };
      },
      async activate(input) {
        db.prepare(`UPDATE agent_exposure_manifests SET status = 'active', published_by = ?, published_at = ?, updated_at = ?
          WHERE id = ?`).run(input.actorId, input.now, input.now, input.id);
        return mapManifest(db.prepare(`SELECT ${MANIFEST_COLUMNS} FROM agent_exposure_manifests WHERE id = ?`).get(input.id) as Record<string, unknown> | undefined);
      },
      async setStatus(input) {
        db.prepare(`UPDATE agent_exposure_manifests SET status = ?, updated_at = ? WHERE id = ?`)
          .run(input.status, input.now, input.id);
        return mapManifest(db.prepare(`SELECT ${MANIFEST_COLUMNS} FROM agent_exposure_manifests WHERE id = ?`).get(input.id) as Record<string, unknown> | undefined);
      },
    },
    restrictions: {
      async upsert(input) {
        db.prepare(`INSERT INTO team_agent_exposure_restrictions (
            id, team_id, agent_id, manifest_id, disabled_capabilities_json, disabled_skills_json, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(team_id, agent_id) DO UPDATE SET
            manifest_id = excluded.manifest_id,
            disabled_capabilities_json = excluded.disabled_capabilities_json,
            disabled_skills_json = excluded.disabled_skills_json,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`)
          .run(
            input.id, input.teamId, input.agentId, input.manifestId,
            JSON.stringify(input.disabledCapabilities), JSON.stringify(input.disabledSkills),
            input.updatedBy, input.now,
          );
        return mapRestriction(db.prepare(`SELECT * FROM team_agent_exposure_restrictions WHERE team_id = ? AND agent_id = ?`).get(input.teamId, input.agentId) as Record<string, unknown> | undefined)!;
      },
      async getByTeamAgent(teamId, agentId) {
        return mapRestriction(db.prepare(`SELECT * FROM team_agent_exposure_restrictions WHERE team_id = ? AND agent_id = ?`).get(teamId, agentId) as Record<string, unknown> | undefined);
      },
    },
    autoAcceptPolicies: {
      async upsert(input) {
        db.prepare(`INSERT INTO agent_auto_accept_policies (
            id, team_id, agent_id, manifest_id, manifest_revision, revision, enabled,
            allowed_capability_ids_json, allow_unspecified_capabilities,
            allowed_risk_levels_json, allow_frozen_project_inputs, require_complete_preview, max_active_claims,
            valid_until, updated_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(team_id, agent_id) DO UPDATE SET
            manifest_id = excluded.manifest_id,
            manifest_revision = excluded.manifest_revision,
            revision = agent_auto_accept_policies.revision + 1,
            enabled = excluded.enabled,
            allowed_capability_ids_json = excluded.allowed_capability_ids_json,
            allow_unspecified_capabilities = excluded.allow_unspecified_capabilities,
            allowed_risk_levels_json = excluded.allowed_risk_levels_json,
            allow_frozen_project_inputs = excluded.allow_frozen_project_inputs,
            require_complete_preview = excluded.require_complete_preview,
            max_active_claims = excluded.max_active_claims,
            valid_until = excluded.valid_until,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`)
          .run(
            input.id, input.teamId, input.agentId, input.manifestId, input.manifestRevision,
            input.enabled ? 1 : 0, JSON.stringify(input.allowedCapabilityIds),
            input.allowUnspecifiedCapabilities ? 1 : 0, JSON.stringify(input.allowedRiskLevels),
            input.allowFrozenProjectInputs ? 1 : 0, input.requireCompletePreview ? 1 : 0,
            input.maxActiveClaims,
            input.validUntil ?? null, input.updatedBy, input.now, input.now,
          );
        return mapAutoAcceptPolicy(db.prepare(
          'SELECT * FROM agent_auto_accept_policies WHERE team_id = ? AND agent_id = ?',
        ).get(input.teamId, input.agentId) as Record<string, unknown> | undefined)!;
      },
      async getByTeamAgent(teamId, agentId) {
        return mapAutoAcceptPolicy(db.prepare(
          'SELECT * FROM agent_auto_accept_policies WHERE team_id = ? AND agent_id = ?',
        ).get(teamId, agentId) as Record<string, unknown> | undefined);
      },
    },
  };
}

export function createSqliteAgentExposurePersistence(db: SqliteDatabase): {
  repositories: AgentExposureRepositories;
  unitOfWork: AgentExposureUnitOfWork;
} {
  const repositories = createSqliteAgentExposureRepositories(db);
  const runTransaction = serializeTransactions<AgentExposureRepositories>(async (operation) => {
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

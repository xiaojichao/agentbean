import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createSqliteAgentExposureRepositories } from '../src/infra/sqlite/agent-exposure-repositories.js';
import { applyTeamMigrations, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe('Agent auto-accept SQLite persistence (#1270)', () => {
  test('首次 upsert 写入全部策略字段并可读回', async () => {
    const db = new Database(':memory:');
    applyTeamMigrations(db);
    const repositories = createSqliteAgentExposureRepositories(db);
    await repositories.manifests.create({
      id: 'manifest-1', teamId: 'team-1', agentId: 'agent-1', revision: 1, status: 'active',
      capabilities: [], skills: [], constraints: [], availability: { status: 'available' },
      validFrom: 1, validUntil: null, createdBy: 'user-1', now: 1,
    });

    await expect(repositories.autoAcceptPolicies.upsert({
      id: 'policy-1', teamId: 'team-1', agentId: 'agent-1', manifestId: 'manifest-1',
      manifestRevision: 1, enabled: true, allowedCapabilityIds: [],
      allowUnspecifiedCapabilities: true, allowedRiskLevels: ['low'],
      allowFrozenProjectInputs: false, requireCompletePreview: true,
      maxActiveClaims: 1, validUntil: null, updatedBy: 'user-1', now: 2,
    })).resolves.toMatchObject({
      id: 'policy-1', revision: 1, enabled: true, allowUnspecifiedCapabilities: true,
      allowedRiskLevels: ['low'], maxActiveClaims: 1,
    });
    db.close();
  });
});

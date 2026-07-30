import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  here,
  '../src/infra/sqlite/migrations/team/0073_pi_authority_cutover.sql',
);

describe('0073_pi_authority_cutover migration', () => {
  test('creates epoch / drain / retirement tables and blocks dual-write state regression via CHECKs', () => {
    const db = new Database(':memory:');
    const sql = readFileSync(migrationPath, 'utf8');
    db.exec(sql);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('team_pi_authority_migrations');
    expect(names).toContain('legacy_drain_lineages');
    expect(names).toContain('message_authority_epoch_bindings');
    expect(names).toContain('pi_authority_retirement_counters');
    expect(names).toContain('pi_cutover_readiness_tokens');

    db.prepare(`
      INSERT INTO team_pi_authority_migrations (
        team_id, authority_epoch, migration_revision, state,
        legacy_writer_fenced, emergency_stop, created_at, updated_at
      ) VALUES ('t1', 1, 2, 'new_authority', 1, 0, 1, 1)
    `).run();

    expect(() => db.prepare(`
      INSERT INTO team_pi_authority_migrations (
        team_id, authority_epoch, migration_revision, state,
        legacy_writer_fenced, emergency_stop, created_at, updated_at
      ) VALUES ('t2', 0, 0, 'dual_write', 0, 0, 1, 1)
    `).run()).toThrow();

    // 唯一 token hash
    db.prepare(`
      INSERT INTO pi_cutover_readiness_tokens (
        token_id, team_id, token_hash, target_epoch, migration_revision,
        readiness_snapshot_id, issued_to, issued_at, expires_at
      ) VALUES ('tok1', 't1', 'hash-a', 1, 0, 'snap1', 'u1', 1, 100)
    `).run();
    expect(() => db.prepare(`
      INSERT INTO pi_cutover_readiness_tokens (
        token_id, team_id, token_hash, target_epoch, migration_revision,
        readiness_snapshot_id, issued_to, issued_at, expires_at
      ) VALUES ('tok2', 't1', 'hash-a', 1, 0, 'snap1', 'u1', 1, 100)
    `).run()).toThrow();

    db.close();
  });
});

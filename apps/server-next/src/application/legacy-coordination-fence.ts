/**
 * #930 legacy coordination write fence。
 *
 * cutover 后禁止新建/调度 Channel Coordination Job；Message 投递本身仍允许。
 * 与 cutover handler 共用 domain 判定，避免 transport 静默转译。
 */
import { isLegacyWriterFenced } from '../../../../packages/domain/src/pi-authority-cutover-policy.js';
import type { TeamPiAuthorityMigrationRecord } from './pi-authority-cutover-repositories.js';

export interface TeamPiAuthorityMigrationLookup {
  get(teamId: string): Promise<TeamPiAuthorityMigrationRecord | null>;
}

/**
 * 无迁移记录时视为 legacy（未 cutover），不 fence。
 * 有记录则按 state / legacyWriterFenced 判定。
 */
export function isLegacyCoordinationWriteFenced(
  migration: TeamPiAuthorityMigrationRecord | null | undefined,
): boolean {
  if (!migration) return false;
  return isLegacyWriterFenced(migration.state, migration.legacyWriterFenced);
}

export async function lookupLegacyCoordinationWriteFenced(
  lookup: TeamPiAuthorityMigrationLookup | undefined,
  teamId: string,
): Promise<boolean> {
  if (!lookup) return false;
  const migration = await lookup.get(teamId);
  return isLegacyCoordinationWriteFenced(migration);
}

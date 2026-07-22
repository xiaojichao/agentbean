import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type {
  AgentRecord,
  ArtifactRecord,
  ChannelRecord,
  DeviceInviteRecord,
  DeviceRecord,
  DispatchRecord,
  AgentExecutionConfig,
  JoinLinkRecord,
  MessageRecord,
  RuntimeRecord,
  ServerNextRepositories,
  TaskRecord,
  TeamMemberRecord,
  TeamRecord,
  UserRecord,
  WorkspaceRunRecord,
} from '../../application/repositories.js';
import { DEFAULT_CHANNEL_NAME, rankMessageSearch, splitSearchTerms } from '../../../../../packages/domain/src/index.js';
import type { SkillDto } from '../../../../../packages/contracts/src/index.js';
import { createSqliteManagementPersistence } from './management-repositories.js';
import { createSqliteTaskCoordinationRepositories } from './task-coordination-repositories.js';
import { createTaskCoordinationUnitOfWork } from '../../application/task-coordination-unit-of-work.js';
import { createMemoryUnitOfWork } from '../../application/memory-unit-of-work.js';
import {
  createManagementMemoryUnitOfWork,
  type ManagementMemoryTransactionRepositories,
} from '../../application/management-memory-unit-of-work.js';
import { createSqliteMemoryRepositories } from './memory-repositories.js';
import { createSqlitePiProviderPersistence } from './pi-provider-repositories.js';

export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}

export interface CreateSqliteRepositoriesInput {
  globalDb: SqliteDatabase;
  teamDb: SqliteDatabase;
}

export function applyGlobalMigrations(db: SqliteDatabase): void {
  applyMigration(db, 'global/0001_first_slice.sql');
  applyMigration(db, 'global/0002_device_invites.sql');
  applyMigration(db, 'global/0003_agent_deleted_at.sql');
  applyMigration(db, 'global/0004_join_links.sql');
  applyMigration(db, 'global/0005_device_connect_command.sql');
  applyMigration(db, 'global/0006_agent_gateway_instance_key.sql');
  applyMigration(db, 'global/0007_device_canonical_alias.sql');
  applyMigration(db, 'global/0008_device_canonical_backfill.sql');
  applyMigration(db, 'global/0009_agent_visibility.sql');
  applyMigration(db, 'global/0010_agent_skills.sql');
  applyMigration(db, 'global/0011_device_revocations.sql');
  applyMigration(db, 'global/0012_device_name_columns.sql');
  applyMigration(db, 'global/0013_device_name_backfill.sql');
  applyMigration(db, 'global/0014_device_revocations_team_columns.sql');
  applyMigration(db, 'global/0015_agent_name_source.sql');
  applyMigration(db, 'global/0016_device_capabilities.sql');
  applyMigration(db, 'global/0017_pi_provider_supply.sql');
  applyMigration(db, 'global/0018_pi_provider_test_publish.sql');
  applyMigration(db, 'global/0019_active_pi_model.sql');
}

export function applyTeamMigrations(db: SqliteDatabase): void {
  applyMigration(db, 'team/0001_first_slice.sql');
  applyMigration(db, 'team/0002_artifacts_workspace_runs.sql');
  applyMigration(db, 'team/0003_tasks.sql');
  applyMigration(db, 'team/0004_reactions_saved.sql');
  applyMigration(db, 'team/0005_workspace_run_command.sql');
  applyMigration(db, 'team/0006_workspace_run_log_excerpt.sql');
  applyMigration(db, 'team/0007_workspace_run_pagination_index.sql');
  applyMigration(db, 'team/0008_artifact_workspace_boundary_index.sql');
  applyMigration(db, 'team/0009_pinned_messages.sql');
  applyMigration(db, 'team/0010_management_phase_1.sql');
  applyMigration(db, 'team/0011_management_shadow_namespace.sql');
  applyMigration(db, 'team/0012_management_frozen_target.sql');
  applyMigration(db, 'team/0013_management_phase_2_task_dag.sql');
  applyMigration(db, 'team/0014_management_phase_2_rollout.sql');
  applyMigration(db, 'team/0015_management_phase_3_memory.sql');
  applyMigration(db, 'team/0016_management_phase_3_capsule_refs.sql');
  applyMigration(db, 'team/0017_management_phase_3_candidates.sql');
  applyMigration(db, 'team/0018_management_handoff.sql');
  applyMigration(db, 'team/0019_management_phase_3_candidate_lifecycle.sql');
  applyMigration(db, 'team/0020_management_phase_3_capsule_item_manifests.sql');
  applyMigration(db, 'team/0021_management_phase_3_rollout.sql', { disableForeignKeys: true });
  if (sqliteTableExists(db, 'manager_leases')) {
    applyMigration(db, 'team/0022_management_phase_4_worker_host.sql', { disableForeignKeys: true });
    applyMigration(db, 'team/0023_management_user_proxy_audit.sql');
    applyMigration(db, 'team/0024_management_budget_overrides.sql');
  }
}

function sqliteTableExists(db: SqliteDatabase, tableName: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

// 清理 channel_agent_members 中指向已删 agent 的孤儿行（PRD §6）。
//
// 背景：global migration 0009 删除了所有 category='executor-hosted' 且 source IN
// ('scanned','self-register') 的 agent，但 channel_agent_members 位于 team db，
// 两者无外键、无跨库级联，被删 agent 会在频道成员表里留下幽灵行——这些 agent_id 会
// 出现在 listChannelMembers 的结果里（repositories.ts:1808-1810），导致频道成员列表
// 含指向已删 agent 的无效 ID。
//
// 实现：team db 是单一共享库（非每团队一库），channel_agent_members.agent_id 是裸
// TEXT、无 FK；team db 内部也没有 agents/category/source 信息无法自我判断孤儿。因此
// 在两个 db 都打开的协调点（createInfrastructure）里，用 ATTACH 把 global db 挂到
// team db，按 "agent_id 不在 global.agents 中" 删除孤儿行——这恰好覆盖 0009 删除的
// 集合，且对未来任何 agent 删除都安全。
//
// 路径：better-sqlite3 的 ATTACH 相对路径按进程 cwd 解析（非主库目录），而 dataDir
// 可被 --data-dir 自定义，故必须用 globalDbPath 绝对路径；调用方在 createInfrastructure
// 已持有该路径，传入即可。
//
// 幂等：通过 team db 的 schema_migrations 表用稳定 key 跟踪，仅执行一次。
// 失败安全：DELETE 包在事务里，任意一步失败则整体回滚；ATTACH/DETACH 用 try 包裹，
// 失败时不掩盖原始错误。
export function cleanupOrphanedChannelMembers(
  globalDbPath: string,
  teamDb: SqliteDatabase,
): void {
  const CLEANUP_KEY = 'post-migration:cleanup-orphaned-channel-members';
  teamDb.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );`);
  if (teamDb.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(CLEANUP_KEY)) {
    return;
  }
  const escaped = `'${globalDbPath.replace(/'/g, "''")}'`;
  teamDb.exec(`ATTACH DATABASE ${escaped} AS __global_agents;`);
  try {
    teamDb.exec('BEGIN;');
    teamDb.exec(
      `DELETE FROM channel_agent_members
       WHERE agent_id NOT IN (SELECT id FROM __global_agents.agents);`,
    );
    teamDb.exec('COMMIT;');
    teamDb.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(CLEANUP_KEY, Date.now());
  } catch (err) {
    try {
      teamDb.exec('ROLLBACK;');
    } catch {
      // 事务可能已回滚或不存在，忽略二次错误，抛出原始错误。
    }
    throw err;
  } finally {
    try {
      teamDb.exec('DETACH DATABASE __global_agents;');
    } catch {
      // ATTACH 未成功或已分离时忽略，不掩盖原始错误。
    }
  }
}

export function createSqliteRepositories(input: CreateSqliteRepositoriesInput): ServerNextRepositories {
  const { globalDb, teamDb } = input;
  const management = createSqliteManagementPersistence(teamDb);
  const taskCoordination = createSqliteTaskCoordinationRepositories(teamDb);
  const memory = createSqliteMemoryRepositories(teamDb);
  const piProvider = createSqlitePiProviderPersistence(globalDb);
  const managementMemoryContext = new AsyncLocalStorage<ManagementMemoryTransactionRepositories>();

  let repositories!: ServerNextRepositories;
  const managementMemoryUnitOfWork = createManagementMemoryUnitOfWork(async (operation) => {
    const active = managementMemoryContext.getStore();
    if (active) return operation(active);
    return management.unitOfWork.run((managementRepositories) =>
      managementMemoryContext.run(
        { management: managementRepositories, memory },
        () => operation({ management: managementRepositories, memory }),
      ));
  });
  repositories = {
    management: management.repositories,
    managementUnitOfWork: management.unitOfWork,
    managementDispatchUnitOfWork: {
      run(operation) {
        return management.unitOfWork.run((managementRepositories) =>
          operation({ management: managementRepositories, dispatches: repositories.dispatches,
            tasks: repositories.tasks, coordination: taskCoordination }));
      },
    },
    piProvider: piProvider.repositories,
    piProviderUnitOfWork: piProvider.unitOfWork,
    taskCoordination,
    taskCoordinationUnitOfWork: createTaskCoordinationUnitOfWork((operation) =>
      management.unitOfWork.run((managementRepositories) =>
        operation({
          tasks: repositories.tasks,
          messages: repositories.messages,
          artifacts: repositories.artifacts,
          workspaceRuns: repositories.workspaceRuns,
          dispatches: repositories.dispatches,
          coordination: taskCoordination,
          management: managementRepositories,
        })),
    ),
    memory,
    memoryUnitOfWork: createMemoryUnitOfWork((operation) =>
      managementMemoryUnitOfWork.run(({ memory: transactionMemory }) => operation(transactionMemory))),
    managementMemoryUnitOfWork,
    users: {
      async create(user) {
        globalDb
          .prepare(
            `INSERT INTO users (
              id, username, email, display_name, password_hash, role, current_team_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            user.id,
            user.username,
            null,
            user.displayName ?? null,
            user.passwordHash,
            user.role,
            user.currentTeamId ?? null,
            user.createdAt,
            user.updatedAt,
          );
        return user;
      },
      async getById(id) {
        return mapUser(globalDb.prepare('SELECT * FROM users WHERE id = ?').get(id));
      },
      async getByUsername(username) {
        return mapUser(globalDb.prepare('SELECT * FROM users WHERE username = ?').get(username));
      },
      async listAll() {
        return globalDb
          .prepare('SELECT * FROM users ORDER BY created_at, id')
          .all()
          .map((row) => {
            const user = mapUser(row);
            if (!user) {
              throw new Error('SQLite user row could not be mapped');
            }
            return user;
          });
      },
      async setCurrentTeam(userId, teamId) {
        globalDb.prepare('UPDATE users SET current_team_id = ?, updated_at = updated_at WHERE id = ?').run(teamId, userId);
      },
      async updateDescription(input) {
        globalDb
          .prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
          .run(input.description, input.updatedAt, input.userId);
        return mapUser(globalDb.prepare('SELECT * FROM users WHERE id = ?').get(input.userId));
      },
      async updatePassword(input) {
        globalDb
          .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
          .run(input.passwordHash, input.updatedAt, input.userId);
        return mapUser(globalDb.prepare('SELECT * FROM users WHERE id = ?').get(input.userId));
      },
      async delete(userId) {
        globalDb.prepare('DELETE FROM team_members WHERE user_id = ?').run(userId);
        globalDb.prepare('DELETE FROM users WHERE id = ?').run(userId);
      },
    },
    teams: {
      async create(team) {
        globalDb
          .prepare(
            `INSERT INTO teams (
              id, owner_id, name, path, description, visibility, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            team.id,
            team.ownerId,
            team.name,
            team.path,
            null,
            team.visibility,
            team.createdAt,
          );
        return team;
      },
      async getById(id) {
        return mapTeam(globalDb.prepare('SELECT * FROM teams WHERE id = ?').get(id));
      },
      async listAll() {
        return globalDb
          .prepare('SELECT * FROM teams ORDER BY created_at, id')
          .all()
          .map((row) => {
            const team = mapTeam(row);
            if (!team) {
              throw new Error('SQLite team row could not be mapped');
            }
            return team;
          });
      },
      async listForUser(userId) {
        return globalDb
          .prepare(
            `SELECT
              teams.*,
              team_members.role AS current_user_role
            FROM team_members
            JOIN teams ON teams.id = team_members.team_id
            WHERE team_members.user_id = ?
            ORDER BY teams.created_at`,
          )
          .all(userId)
          .map((row) => {
            const team = mapTeam(row);
            if (!team) {
              throw new Error('SQLite team row could not be mapped');
            }
            return { ...team, currentUserRole: sqliteText(row, 'current_user_role') as TeamMemberRecord['role'] };
          });
      },
      async addMember(member) {
        globalDb
          .prepare(
            `INSERT INTO team_members (team_id, user_id, role, joined_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(member.teamId, member.userId, member.role, member.joinedAt);
      },
      async isMember(teamId, userId) {
        return Boolean(globalDb.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId));
      },
      async getMemberRole(teamId, userId) {
        const row = globalDb
          .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
          .get(teamId, userId);
        return row ? (sqliteText(row, 'role') as TeamMemberRecord['role']) : null;
      },
      async listMembersByIds(teamId, userIds) {
        const members: Array<{
          teamId: string;
          userId: string;
          username: string;
          role: TeamMemberRecord['role'];
          displayName?: string;
        }> = [];
        for (const userId of userIds) {
          const row = globalDb
            .prepare(
              `SELECT
                team_members.team_id,
                team_members.user_id,
                users.username,
                users.display_name,
                team_members.role,
                team_members.joined_at
              FROM team_members
              JOIN users ON users.id = team_members.user_id
              WHERE team_members.team_id = ?
              AND team_members.user_id = ?`,
            )
            .get(teamId, userId);
          if (row) {
            members.push({
              teamId: sqliteText(row, 'team_id'),
              userId: sqliteText(row, 'user_id'),
              username: sqliteText(row, 'username'),
              role: sqliteText(row, 'role') as TeamMemberRecord['role'],
              ...(sqliteNullableText(row, 'display_name') ? { displayName: sqliteNullableText(row, 'display_name') } : {}),
            });
          }
        }
        return members.map((member) => ({
          id: `${member.teamId}:${member.userId}`,
          teamId: member.teamId,
          userId: member.userId,
          username: member.username,
          role: member.role,
          displayName: member.displayName,
        }));
      },
      async getMember(input) {
        const row = globalDb
          .prepare(
            `SELECT team_members.*, users.username
             FROM team_members
             JOIN users ON users.id = team_members.user_id
             WHERE team_members.team_id = ? AND team_members.user_id = ?`,
          )
          .get(input.teamId, input.userId);
        if (!row) return null;
        return {
          teamId: sqliteText(row, 'team_id'),
          userId: sqliteText(row, 'user_id'),
          username: sqliteText(row, 'username'),
          role: sqliteText(row, 'role') as TeamMemberRecord['role'],
          joinedAt: sqliteNumber(row, 'joined_at'),
        };
      },
      async updateMemberRole(input) {
        globalDb
          .prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?')
          .run(input.role, input.teamId, input.userId);
        const row = globalDb
          .prepare(
            `SELECT team_members.*, users.username
             FROM team_members
             JOIN users ON users.id = team_members.user_id
             WHERE team_members.team_id = ? AND team_members.user_id = ?`,
          )
          .get(input.teamId, input.userId);
        if (!row) return null;
        return {
          teamId: sqliteText(row, 'team_id'),
          userId: sqliteText(row, 'user_id'),
          username: sqliteText(row, 'username'),
          role: sqliteText(row, 'role') as TeamMemberRecord['role'],
          joinedAt: sqliteNumber(row, 'joined_at'),
        };
      },
      async removeMember(input) {
        globalDb
          .prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?')
          .run(input.teamId, input.userId);
      },
      async updateOwner(input) {
        globalDb
          .prepare('UPDATE teams SET owner_id = ? WHERE id = ?')
          .run(input.ownerId, input.teamId);
        return mapTeam(globalDb.prepare('SELECT * FROM teams WHERE id = ?').get(input.teamId));
      },
      async listAllMembers(teamId) {
        const rows = globalDb
          .prepare(
            `SELECT tm.user_id, tm.role, tm.joined_at, u.username, u.display_name
             FROM team_members tm
             JOIN users u ON u.id = tm.user_id
             WHERE tm.team_id = ?
             ORDER BY tm.joined_at`,
          )
          .all(teamId);
        return rows.map((row: any) => ({
          id: `${teamId}:${sqliteText(row, 'user_id')}`,
          teamId,
          userId: sqliteText(row, 'user_id'),
          username: sqliteText(row, 'username'),
          role: sqliteText(row, 'role') as 'owner' | 'admin' | 'member',
          displayName: sqliteNullableText(row, 'display_name') ?? undefined,
          joinedAt: sqliteNumber(row, 'joined_at'),
        }));
      },
      async update(input) {
        const sets: string[] = [];
        const values: unknown[] = [];
        if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
        if (input.path !== undefined) { sets.push('path = ?'); values.push(input.path); }
        if (input.description !== undefined) { sets.push('description = ?'); values.push(input.description); }
        if (input.visibility !== undefined) { sets.push('visibility = ?'); values.push(input.visibility); }
        if (sets.length === 0) return mapTeam(globalDb.prepare('SELECT * FROM teams WHERE id = ?').get(input.teamId));
        values.push(input.teamId);
        globalDb.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...values);
        return mapTeam(globalDb.prepare('SELECT * FROM teams WHERE id = ?').get(input.teamId));
      },
      async delete(teamId) {
        teamDb.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE team_id = ?)').run(teamId);
        teamDb.prepare('DELETE FROM saved_messages WHERE message_id IN (SELECT id FROM messages WHERE team_id = ?)').run(teamId);
        teamDb.prepare('DELETE FROM pinned_messages WHERE message_id IN (SELECT id FROM messages WHERE team_id = ?)').run(teamId);
        teamDb.prepare('DELETE FROM tasks WHERE team_id = ?').run(teamId);
        teamDb.prepare('DELETE FROM artifacts WHERE team_id = ?').run(teamId);
        teamDb.prepare('DELETE FROM workspace_runs WHERE team_id = ?').run(teamId);
        teamDb.prepare('DELETE FROM dispatches WHERE channel_id IN (SELECT id FROM channels WHERE team_id = ?)').run(teamId);
        teamDb.prepare('DELETE FROM messages WHERE team_id = ?').run(teamId);
        teamDb.prepare('DELETE FROM channel_human_members WHERE channel_id IN (SELECT id FROM channels WHERE team_id = ?)').run(teamId);
        teamDb.prepare('DELETE FROM channel_agent_members WHERE channel_id IN (SELECT id FROM channels WHERE team_id = ?)').run(teamId);
        teamDb.prepare('DELETE FROM channels WHERE team_id = ?').run(teamId);
        globalDb.prepare('DELETE FROM agent_publications WHERE team_id = ? OR agent_id IN (SELECT id FROM agents WHERE primary_team_id = ?)').run(teamId, teamId);
        globalDb.prepare('DELETE FROM agents WHERE primary_team_id = ?').run(teamId);
        globalDb.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
        globalDb.prepare('DELETE FROM join_links WHERE team_id = ?').run(teamId);
        globalDb.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      },
    },
    joinLinks: {
      async create(link) {
        globalDb
          .prepare(
            `INSERT INTO join_links (
              id, code, team_id, created_by, created_at, expires_at, max_uses, uses_count, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            link.id,
            link.code,
            link.teamId,
            link.createdBy,
            link.createdAt,
            link.expiresAt ?? null,
            link.maxUses ?? null,
            link.usesCount,
            link.revokedAt ?? null,
          );
        return link;
      },
      async getByCode(code) {
        return mapJoinLink(globalDb.prepare('SELECT * FROM join_links WHERE code = ?').get(code));
      },
      async incrementUses(code) {
        const result = globalDb
          .prepare(
            `UPDATE join_links
             SET uses_count = uses_count + 1
             WHERE code = ?
             AND (max_uses IS NULL OR uses_count < max_uses)`,
          )
          .run(code);
        if (sqliteChanges(result) === 0) {
          return null;
        }
        return mapJoinLink(globalDb.prepare('SELECT * FROM join_links WHERE code = ?').get(code));
      },
      async listByTeam(teamId) {
        return globalDb
          .prepare('SELECT * FROM join_links WHERE team_id = ? ORDER BY created_at DESC')
          .all(teamId)
          .map((row) => {
            const link = mapJoinLink(row);
            if (!link) {
              throw new Error('SQLite join link row could not be mapped');
            }
            return link;
          });
      },
      async revoke(input) {
        const result = globalDb
          .prepare('UPDATE join_links SET revoked_at = ? WHERE team_id = ? AND code = ? AND revoked_at IS NULL')
          .run(input.revokedAt, input.teamId, input.code);
        if (sqliteChanges(result) === 0) {
          return null;
        }
        return mapJoinLink(globalDb.prepare('SELECT * FROM join_links WHERE code = ?').get(input.code));
      },
    },
    deviceInvites: {
      async create(invite) {
        globalDb
          .prepare(
            `INSERT INTO device_invites (
              id, code, team_id, created_by, created_at, expires_at, completed_at, machine_id, profile_id, hostname, server_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            invite.id,
            invite.code,
            invite.teamId,
            invite.createdBy,
            invite.createdAt,
            invite.expiresAt ?? null,
            invite.completedAt ?? null,
            invite.machineId ?? null,
            invite.profileId ?? null,
            invite.hostname ?? null,
            invite.serverUrl ?? null,
          );
        return invite;
      },
      async getByCode(code) {
        return mapDeviceInvite(globalDb.prepare('SELECT * FROM device_invites WHERE code = ?').get(code));
      },
      async updateWaiter(input) {
        globalDb
          .prepare(
            `UPDATE device_invites
             SET machine_id = ?, profile_id = COALESCE(?, profile_id), hostname = ?, server_url = COALESCE(?, server_url)
             WHERE code = ?
             AND completed_at IS NULL`,
          )
          .run(input.machineId ?? null, input.profileId ?? null, input.hostname ?? null, input.serverUrl ?? null, input.code);
        return mapDeviceInvite(globalDb.prepare('SELECT * FROM device_invites WHERE code = ?').get(input.code));
      },
      async complete(input) {
        const result = globalDb
          .prepare(
            `UPDATE device_invites
              SET completed_at = ?, server_url = COALESCE(?, server_url)
              WHERE code = ?
              AND completed_at IS NULL`,
          )
          .run(input.completedAt, input.serverUrl ?? null, input.code);
        if (sqliteChanges(result) === 0) {
          return null;
        }
        return mapDeviceInvite(globalDb.prepare('SELECT * FROM device_invites WHERE code = ?').get(input.code));
      },
    },
    channels: {
      async create(channel) {
        teamDb
          .prepare(
            `INSERT INTO channels (
              id, team_id, kind, name, description, visibility, created_by, created_at, archived_at, dm_target_agent_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            channel.id,
            channel.teamId,
            channel.kind,
            channel.name,
            channel.title ?? null,
            channel.visibility,
            channel.createdBy ?? null,
            channel.createdAt,
            null,
            channel.dmTargetAgentId ?? null,
          );
        for (const userId of channel.humanMemberIds) {
          teamDb
            .prepare(
              `INSERT INTO channel_human_members (channel_id, user_id, role, joined_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(channel.id, userId, 'member', channel.createdAt);
        }
        for (const agentId of channel.agentMemberIds) {
          teamDb
            .prepare(
              `INSERT INTO channel_agent_members (channel_id, agent_id, joined_at)
               VALUES (?, ?, ?)`,
            )
            .run(channel.id, agentId, channel.createdAt);
        }
        return channel;
      },
      async getById(channelId) {
        return mapChannel(teamDb, teamDb.prepare('SELECT * FROM channels WHERE id = ?').get(channelId));
      },
      async getDefaultChannel(teamId) {
        return mapChannel(
          teamDb,
          teamDb
            .prepare(
              `SELECT * FROM channels
               WHERE team_id = ?
               AND kind = 'channel'
               AND name = ?
               AND archived_at IS NULL
               LIMIT 1`,
            )
            .get(teamId, DEFAULT_CHANNEL_NAME),
        );
      },
      async getDirectByAgent(input) {
        return mapChannel(
          teamDb,
          teamDb
            .prepare(
              `SELECT channels.* FROM channels
               JOIN channel_human_members hm ON hm.channel_id = channels.id
               WHERE channels.team_id = ?
               AND channels.kind = 'direct'
               AND hm.user_id = ?
               AND (
                 channels.dm_target_agent_id = ?
                 OR channels.id IN (SELECT channel_id FROM channel_agent_members WHERE agent_id = ?)
               )
               ORDER BY channels.created_at
               LIMIT 1`,
            )
            .get(input.teamId, input.userId, input.agentId, input.agentId),
        );
      },
      async listByTeam(teamId) {
        return teamDb
          .prepare(
            `SELECT * FROM channels
             WHERE team_id = ?
             AND kind = 'channel'
             AND archived_at IS NULL
             ORDER BY created_at`,
          )
          .all(teamId)
          .map((row) => {
            const channel = mapChannel(teamDb, row);
            if (!channel) {
              throw new Error('SQLite channel row could not be mapped');
            }
            return channel;
          });
      },
      async listForUser(teamId, userId) {
        return teamDb
          .prepare(
            `SELECT * FROM channels
             WHERE team_id = ?
             AND kind = 'channel'
             AND archived_at IS NULL
             AND (
               visibility = 'public'
               OR id IN (SELECT channel_id FROM channel_human_members WHERE user_id = ?)
             )
             ORDER BY created_at`,
          )
          .all(teamId, userId)
          .map((row) => {
            const channel = mapChannel(teamDb, row);
            if (!channel) {
              throw new Error('SQLite channel row could not be mapped');
            }
            return channel;
        });
      },
      async listDirectForUser(teamId, userId) {
        return teamDb
          .prepare(
            `SELECT channels.* FROM channels
             JOIN channel_human_members hm ON hm.channel_id = channels.id
             WHERE channels.team_id = ?
             AND channels.kind = 'direct'
             AND hm.user_id = ?
             ORDER BY channels.created_at`,
          )
          .all(teamId, userId)
          .map((row) => {
            const channel = mapChannel(teamDb, row);
            if (!channel) {
              throw new Error('SQLite direct channel row could not be mapped');
            }
            return channel;
          });
      },
      async addDefaultChannelMembers(input) {
        const defaultChannel = await this.getDefaultChannel(input.teamId);
        if (!defaultChannel) {
          return null;
        }
        for (const userId of input.humanMemberIds ?? []) {
          teamDb
            .prepare(
              `INSERT OR IGNORE INTO channel_human_members (channel_id, user_id, role, joined_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(defaultChannel.id, userId, 'member', input.timestamp);
        }
        for (const agentId of input.agentMemberIds ?? []) {
          teamDb
            .prepare(
              `INSERT OR IGNORE INTO channel_agent_members (channel_id, agent_id, joined_at)
               VALUES (?, ?, ?)`,
            )
            .run(defaultChannel.id, agentId, input.timestamp);
        }
        return mapChannel(teamDb, teamDb.prepare('SELECT * FROM channels WHERE id = ?').get(defaultChannel.id));
      },
      async update(input) {
        const existing = mapChannel(teamDb, teamDb.prepare('SELECT * FROM channels WHERE id = ?').get(input.channelId));
        if (!existing) {
          return null;
        }
        const updated: ChannelRecord = {
          ...existing,
          ...input.changes,
        };
        teamDb
          .prepare(
            `UPDATE channels
             SET name = ?, description = ?, visibility = ?
             WHERE id = ?`,
          )
          .run(updated.name, updated.title ?? null, updated.visibility, updated.id);
        if (input.changes.humanMemberIds) {
          teamDb.prepare('DELETE FROM channel_human_members WHERE channel_id = ?').run(updated.id);
          for (const userId of updated.humanMemberIds) {
            teamDb
              .prepare(
                `INSERT INTO channel_human_members (channel_id, user_id, role, joined_at)
                 VALUES (?, ?, ?, ?)`,
              )
              .run(updated.id, userId, 'member', updated.updatedAt ?? updated.createdAt);
          }
        }
        if (input.changes.agentMemberIds) {
          teamDb.prepare('DELETE FROM channel_agent_members WHERE channel_id = ?').run(updated.id);
          for (const agentId of updated.agentMemberIds) {
            teamDb
              .prepare(
                `INSERT INTO channel_agent_members (channel_id, agent_id, joined_at)
                 VALUES (?, ?, ?)`,
              )
              .run(updated.id, agentId, updated.updatedAt ?? updated.createdAt);
          }
        }
        return mapChannel(teamDb, teamDb.prepare('SELECT * FROM channels WHERE id = ?').get(updated.id));
      },
      async removeAgentFromTeamChannels(input) {
        teamDb
          .prepare(
            `DELETE FROM channel_agent_members
             WHERE agent_id = ?
             AND channel_id IN (SELECT id FROM channels WHERE team_id = ?)`,
          )
          .run(input.agentId, input.teamId);
      },
      async removeHumanFromTeamChannels(input) {
        teamDb
          .prepare(
            `DELETE FROM channel_human_members
             WHERE user_id = ?
             AND channel_id IN (SELECT id FROM channels WHERE team_id = ?)`,
          )
          .run(input.userId, input.teamId);
      },
      async archive(input) {
        const existing = mapChannel(teamDb, teamDb.prepare('SELECT * FROM channels WHERE id = ?').get(input.channelId));
        if (!existing) {
          return null;
        }
        teamDb.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(input.timestamp, input.channelId);
        return { ...existing, archivedAt: input.timestamp };
      },
      async delete(input) {
        const existing = mapChannel(teamDb, teamDb.prepare('SELECT * FROM channels WHERE id = ?').get(input.channelId));
        if (!existing) {
          return null;
        }
        teamDb.prepare('DELETE FROM channel_human_members WHERE channel_id = ?').run(input.channelId);
        teamDb.prepare('DELETE FROM channel_agent_members WHERE channel_id = ?').run(input.channelId);
        teamDb.prepare('DELETE FROM channels WHERE id = ?').run(input.channelId);
        return existing;
      },
    },
    devices: {
      async upsertHello(device) {
        globalDb
          .prepare(
            `INSERT INTO devices (
              id, team_id, owner_id, machine_id, profile_id, hostname, name, name_source, status, daemon_version,
              system_info, capabilities, canonical_device_id, last_seen_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              team_id = excluded.team_id,
              owner_id = excluded.owner_id,
              machine_id = excluded.machine_id,
              profile_id = excluded.profile_id,
              hostname = excluded.hostname,
              status = excluded.status,
              daemon_version = excluded.daemon_version,
              system_info = excluded.system_info,
              capabilities = excluded.capabilities,
              canonical_device_id = excluded.canonical_device_id,
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at`,
          )
          .run(
            device.id,
            device.teamId,
            device.ownerId,
            device.machineId ?? null,
            device.profileId ?? null,
            device.hostname ?? device.systemInfo?.hostname ?? null,
            device.name ?? null,
            device.nameSource ?? null,
            device.status,
            device.daemonVersion ?? null,
            device.systemInfo ? JSON.stringify(device.systemInfo) : null,
            device.capabilities ? JSON.stringify(device.capabilities) : null,
            device.canonicalDeviceId ?? null,
            device.lastSeenAt ?? device.updatedAt,
            device.createdAt,
            device.updatedAt,
          );
        return device;
      },
      async getById(id) {
        return mapDevice(globalDb.prepare('SELECT * FROM devices WHERE id = ?').get(id));
      },
      async findByMachineProfile(input) {
        return mapDevice(
          globalDb
            .prepare('SELECT * FROM devices WHERE team_id = ? AND machine_id = ? AND profile_id = ? ORDER BY updated_at DESC LIMIT 1')
            .get(input.teamId, input.machineId, input.profileId),
        );
      },
      async findCanonicalByDisplay(input) {
        return mapDevice(
          globalDb
            .prepare(
              `SELECT canonical.* FROM devices AS matched
               JOIN devices AS canonical
                 ON canonical.id = COALESCE(matched.canonical_device_id, matched.id)
                AND canonical.team_id = matched.team_id
                AND canonical.owner_id = matched.owner_id
               WHERE matched.team_id = ? AND matched.owner_id = ?
                 AND LOWER(TRIM(COALESCE(NULLIF(matched.hostname, ''), NULLIF(matched.name, ''), json_extract(matched.system_info, '$.hostname')))) = LOWER(TRIM(?))
               ORDER BY canonical.updated_at DESC, canonical.id DESC LIMIT 1`,
            )
            .get(input.teamId, input.ownerId, input.name),
        );
      },
      async listByTeam(teamId) {
        return globalDb
          .prepare('SELECT * FROM devices WHERE team_id = ? ORDER BY updated_at, id')
          .all(teamId)
          .map((row) => {
            const device = mapDevice(row);
            if (!device) {
              throw new Error('SQLite device row could not be mapped');
            }
            return device;
          });
      },
      async listAll() {
        return globalDb
          .prepare('SELECT * FROM devices ORDER BY updated_at, id')
          .all()
          .map((row) => {
            const device = mapDevice(row);
            if (!device) {
              throw new Error('SQLite device row could not be mapped');
            }
            return device;
          });
      },
      async listConnected() {
        return globalDb
          .prepare("SELECT * FROM devices WHERE status != 'offline' ORDER BY updated_at, id")
          .all()
          .map((row) => {
            const device = mapDevice(row);
            if (!device) {
              throw new Error('SQLite device row could not be mapped');
            }
            return device;
          });
      },
      async markOffline(input) {
        const row = globalDb
          .prepare('SELECT * FROM devices WHERE id = ?')
          .get(input.deviceId);
        const device = mapDevice(row);
        if (!device) {
          return null;
        }
        globalDb
          .prepare(
            `UPDATE devices
             SET status = 'offline', last_seen_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(device.lastSeenAt ?? input.timestamp, input.timestamp, input.deviceId);
        return {
          ...device,
          status: 'offline',
          lastSeenAt: device.lastSeenAt ?? input.timestamp,
          updatedAt: input.timestamp,
        };
      },
      async updateName(input) {
        const result = globalDb
          .prepare("UPDATE devices SET name = ?, name_source = 'user', updated_at = ? WHERE id = ?")
          .run(input.name, input.updatedAt, input.deviceId);
        if (sqliteChanges(result) === 0) {
          return null;
        }
        return mapDevice(globalDb.prepare('SELECT * FROM devices WHERE id = ?').get(input.deviceId));
      },
      async transferOwner(input) {
        const result = globalDb
          .prepare('UPDATE devices SET owner_id = ?, updated_at = ? WHERE id = ?')
          .run(input.ownerId, input.updatedAt, input.deviceId);
        if (sqliteChanges(result) === 0) {
          return null;
        }
        return mapDevice(globalDb.prepare('SELECT * FROM devices WHERE id = ?').get(input.deviceId));
      },
      async delete(input) {
        globalDb.prepare('DELETE FROM device_runtimes WHERE device_id = ?').run(input.deviceId);
        globalDb
          .prepare('DELETE FROM agent_publications WHERE agent_id IN (SELECT id FROM agents WHERE device_id = ? AND deleted_at IS NULL)')
          .run(input.deviceId);
        globalDb
          .prepare(
            `UPDATE agents
             SET status = 'offline', env_json = NULL, deleted_at = ?, updated_at = ?, last_seen_at = ?
             WHERE device_id = ? AND deleted_at IS NULL`,
          )
          .run(input.timestamp, input.timestamp, input.timestamp, input.deviceId);
        globalDb.prepare('DELETE FROM devices WHERE id = ?').run(input.deviceId);
      },
    },
    runtimes: {
      async replaceForDevice(input) {
        globalDb.prepare('DELETE FROM device_runtimes WHERE device_id = ?').run(input.deviceId);
        for (const runtime of input.runtimes) {
          globalDb
            .prepare(
              `INSERT INTO device_runtimes (
                id, device_id, team_id, adapter_kind, name, installed, command,
                normalized_command_key, cwd, normalized_cwd_key, version, last_seen_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              runtime.id,
              runtime.deviceId,
              runtime.teamId,
              runtime.adapterKind,
              runtime.name,
              runtime.installed ? 1 : 0,
              runtime.command ?? null,
              runtime.normalizedCommandKey ?? null,
              runtime.cwd ?? null,
              runtime.normalizedCwdKey ?? null,
              runtime.version ?? null,
              runtime.lastSeenAt ?? 0,
            );
        }
        return input.runtimes;
      },
      async getById(runtimeId) {
        return mapRuntime(globalDb.prepare('SELECT * FROM device_runtimes WHERE id = ?').get(runtimeId));
      },
      async listByDevice(deviceId) {
        return globalDb
          .prepare('SELECT * FROM device_runtimes WHERE device_id = ? ORDER BY last_seen_at, id')
          .all(deviceId)
          .map((row) => {
            const runtime = mapRuntime(row);
            if (!runtime) {
              throw new Error('SQLite runtime row could not be mapped');
            }
            return runtime;
          });
      },
    },
    agents: {
      async upsert(agent) {
        globalDb
          .prepare(
            `INSERT INTO agents (
              id, primary_team_id, name, normalized_name, role, description, adapter_kind, category, source,
              status, owner_id, device_id, command, args_json, cwd, gateway_instance_key, env_json, last_seen_at, last_error, created_at, updated_at,
              deleted_at, skills_json, name_source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              primary_team_id = excluded.primary_team_id,
              name = CASE WHEN name_source = 'custom' THEN agents.name ELSE excluded.name END,
              normalized_name = CASE WHEN name_source = 'custom' THEN agents.normalized_name ELSE excluded.normalized_name END,
              adapter_kind = excluded.adapter_kind,
              category = excluded.category,
              source = excluded.source,
              status = excluded.status,
              device_id = excluded.device_id,
              command = excluded.command,
              args_json = excluded.args_json,
              cwd = excluded.cwd,
              skills_json = excluded.skills_json,
              gateway_instance_key = excluded.gateway_instance_key,
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at`,
          )
          .run(
            agent.id,
            agent.primaryTeamId,
            agent.name,
            normalizeName(agent.name),
            null,
            agent.description ?? null,
            agent.adapterKind,
            agent.category,
            agent.source,
            agent.status,
            agent.ownerId ?? null,
            agent.deviceId ?? null,
            agent.command ?? null,
            agent.args ? JSON.stringify(agent.args) : null,
            agent.cwd ?? null,
            agent.gatewayInstanceKey ?? null,
            agent.env ? JSON.stringify(agent.env) : null,
            agent.lastSeenAt ?? 0,
            agent.lastError ?? null,
            agent.lastSeenAt ?? 0,
            agent.lastSeenAt ?? 0,
            agent.deletedAt ?? null,
            agent.skills ? JSON.stringify(agent.skills) : null,
            agent.nameSource ?? 'scanned',
          );
        for (const teamId of agent.visibleTeamIds) {
          if (teamId === agent.primaryTeamId) {
            continue;
          }
          globalDb
            .prepare(
              `INSERT OR IGNORE INTO agent_publications (agent_id, team_id, published_by, published_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(agent.id, teamId, agent.id, agent.lastSeenAt ?? 0);
        }
        // 回读 DB name：ON CONFLICT 的 CASE WHEN 在 name_source='custom' 时会保护
        // existing.name（不取 excluded.name）。直接返回 input agent 会让调用方（如
        // registerDiscoveredAgents → 前端）看到 discovered.name 而非受保护的用户自定义名。
        const stored = mapAgent(globalDb, globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id));
        return stored ?? agent;
      },
      async getByIdentityKey(identityKey) {
        return mapAgent(
          globalDb,
          globalDb
            .prepare(
              `SELECT agents.* FROM agent_identity_links
               JOIN agents ON agents.id = agent_identity_links.agent_id
               WHERE agent_identity_links.identity_key = ?`,
            )
            .get(identityKey),
        );
      },
      async getById(agentId) {
        return mapAgent(globalDb, globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(agentId));
      },
      async getExecutionConfig(agentId) {
        const row = globalDb
          .prepare('SELECT adapter_kind, command, args_json, cwd, env_json FROM agents WHERE id = ? AND deleted_at IS NULL')
          .get(agentId);
        return mapAgentExecutionConfig(row);
      },
      async setPrimaryTeamVisibility(input) {
        // 与 updateConfig/softDelete 一致：先取 agent，软删或不存在则直接返回 null，
        // 避免末尾 SELECT 把未更新的软删 agent 当作成功结果返回。
        const existing = mapAgent(globalDb, globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId));
        if (!existing || existing.deletedAt !== undefined) {
          return null;
        }
        // hidden_from_primary_team=1 时，mapAgent 会把 primaryTeamId 从 visibleTeamIds 移除。
        globalDb
          .prepare(
            'UPDATE agents SET hidden_from_primary_team = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
          )
          .run(input.visible ? 0 : 1, input.timestamp, input.agentId);
        if (!input.visible) {
          // 隐藏时同步清空额外发布，保证 agent 只剩 primary team 归属（且 primary 不可见）。
          globalDb.prepare('DELETE FROM agent_publications WHERE agent_id = ?').run(input.agentId);
        }
        return mapAgent(globalDb, globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId));
      },
      async updateConfig(input) {
        const existing = mapAgent(globalDb, globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId));
        if (!existing || existing.deletedAt !== undefined) {
          return null;
        }
        const changes = input.changes;
        const nextName = hasOwn(changes, 'name') ? changes.name ?? existing.name : existing.name;
        const nextArgs = hasOwn(changes, 'args') ? changes.args : existing.args;
        const envJson = hasOwn(changes, 'env') ? JSON.stringify(changes.env ?? {}) : undefined;
        globalDb
          .prepare(
            `UPDATE agents SET
               name = ?,
               normalized_name = ?,
               name_source = ?,
               description = ?,
               adapter_kind = ?,
               device_id = ?,
               command = ?,
               args_json = ?,
               cwd = ?,
               env_json = COALESCE(?, env_json),
               status = ?,
               last_seen_at = ?,
               updated_at = ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(
            nextName,
            normalizeName(nextName),
            hasOwn(changes, 'name') && nextName !== existing.name ? 'custom' : (existing.nameSource ?? 'scanned'),
            hasOwn(changes, 'description') ? changes.description ?? null : existing.description ?? null,
            hasOwn(changes, 'adapterKind') ? changes.adapterKind ?? existing.adapterKind : existing.adapterKind,
            hasOwn(changes, 'deviceId') ? changes.deviceId ?? null : existing.deviceId ?? null,
            hasOwn(changes, 'command') ? changes.command ?? null : existing.command ?? null,
            nextArgs ? JSON.stringify(nextArgs) : null,
            hasOwn(changes, 'cwd') ? changes.cwd ?? null : existing.cwd ?? null,
            envJson ?? null,
            hasOwn(changes, 'status') ? changes.status ?? existing.status : existing.status,
            hasOwn(changes, 'lastSeenAt') ? changes.lastSeenAt ?? existing.lastSeenAt ?? input.timestamp : existing.lastSeenAt ?? input.timestamp,
            input.timestamp,
            input.agentId,
          );
        return mapAgent(globalDb, globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId));
      },
      async softDelete(input) {
        const existing = mapAgent(globalDb, globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId));
        if (!existing || existing.deletedAt !== undefined) {
          return null;
        }
        globalDb.prepare('DELETE FROM agent_publications WHERE agent_id = ?').run(input.agentId);
        globalDb
          .prepare(
            `UPDATE agents
             SET status = 'offline', env_json = NULL, deleted_at = ?, updated_at = ?, last_seen_at = ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(input.timestamp, input.timestamp, input.timestamp, input.agentId);
        return mapAgent(globalDb, globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId));
      },
      async linkIdentity(input) {
        globalDb
          .prepare(
            `INSERT INTO agent_identity_links (identity_key, agent_id, kind, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(identity_key) DO UPDATE SET
               agent_id = excluded.agent_id,
               kind = excluded.kind,
               updated_at = excluded.updated_at`,
          )
          .run(input.identityKey, input.agentId, input.kind, input.timestamp, input.timestamp);
      },
      async markMissingScannedOffline(input) {
        const rows = globalDb
          .prepare(
            `SELECT agents.id, agent_identity_links.identity_key AS identity_key
             FROM agent_identity_links
             JOIN agents ON agents.id = agent_identity_links.agent_id
             WHERE agents.primary_team_id = ?
             AND agents.device_id = ?
             AND agents.source = 'scanned'
             AND agents.deleted_at IS NULL`,
          )
          .all(input.teamId, input.deviceId);
        const seen = new Set(input.seenIdentityKeys);
        const missingIds = rows
          .filter((row) => !seen.has(sqliteText(row, 'identity_key')))
          .map((row) => sqliteText(row, 'id'));
        for (const agentId of missingIds) {
          globalDb
            .prepare('UPDATE agents SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
            .run('offline', input.timestamp, input.timestamp, agentId);
        }
        return missingIds;
      },
      async updateStatus(input) {
        globalDb
          .prepare('UPDATE agents SET status = ?, last_seen_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
          .run(input.status, input.lastSeenAt, input.lastError ?? null, input.lastSeenAt, input.agentId);
      },
      async updateSkills(input) {
        globalDb
          .prepare('UPDATE agents SET skills_json = ?, updated_at = ? WHERE id = ?')
          .run(input.skills ? JSON.stringify(input.skills) : null, input.timestamp, input.agentId);
        const row = globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId);
        return mapAgent(globalDb, row);
      },
      async listVisibleInTeam(teamId) {
        return globalDb
          .prepare(
            `SELECT * FROM (
               SELECT agents.* FROM agents
               WHERE agents.primary_team_id = ?
                 AND agents.deleted_at IS NULL
                 AND agents.hidden_from_primary_team = 0
               UNION
               SELECT agents.* FROM agent_publications
               JOIN agents ON agents.id = agent_publications.agent_id
               WHERE agent_publications.team_id = ?
                 AND agents.deleted_at IS NULL
             ) AS visible
             WHERE NOT (visible.category = 'executor-hosted' AND visible.source != 'custom')`,
          )
          .all(teamId, teamId)
          .map((row) => {
            const agent = mapAgent(globalDb, row);
            if (!agent) {
              throw new Error('SQLite agent row could not be mapped');
            }
            return agent;
          });
      },
      async listByDevice(deviceId) {
        return globalDb
          .prepare('SELECT * FROM agents WHERE device_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
          .all(deviceId)
          .map((row) => {
            const agent = mapAgent(globalDb, row);
            if (!agent) {
              throw new Error('SQLite agent row could not be mapped');
            }
            return agent;
          });
      },
      async listAll() {
        return globalDb
          .prepare('SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY created_at, id')
          .all()
          .map((row) => {
            const agent = mapAgent(globalDb, row);
            if (!agent) {
              throw new Error('SQLite agent row could not be mapped');
            }
            return agent;
          });
      },
      async updateOwnerByDevice(input) {
        globalDb
          .prepare('UPDATE agents SET owner_id = ?, updated_at = ?, last_seen_at = COALESCE(last_seen_at, ?) WHERE device_id = ? AND deleted_at IS NULL')
          .run(input.ownerId, input.timestamp, input.timestamp, input.deviceId);
        return globalDb
          .prepare('SELECT * FROM agents WHERE device_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
          .all(input.deviceId)
          .map((row) => {
            const agent = mapAgent(globalDb, row);
            if (!agent) {
              throw new Error('SQLite agent row could not be mapped');
            }
            return agent;
          });
      },
    },
    messages: {
      async append(message) {
        teamDb
          .prepare(
            `INSERT INTO messages (
              id, team_id, channel_id, thread_id, sender_kind, sender_id, sender_name, body,
              client_message_id, meta_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            message.id,
            message.teamId,
            message.channelId,
            message.threadId ?? null,
            message.senderKind,
            message.senderId,
            null,
            message.body,
            message.meta?.clientMessageId ?? null,
            message.meta ? JSON.stringify(message.meta) : null,
            message.createdAt,
          );
        return message;
      },
      async getById(messageId) {
        return mapMessage(teamDb.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
      },
      async updateMeta(input) {
        const existing = mapMessage(teamDb.prepare('SELECT * FROM messages WHERE id = ?').get(input.messageId));
        if (!existing) {
          return null;
        }
        teamDb
          .prepare('UPDATE messages SET meta_json = ? WHERE id = ?')
          .run(input.meta ? JSON.stringify(input.meta) : null, input.messageId);
        return { ...existing, meta: input.meta };
      },
      async edit(input) {
        const existing = mapMessage(teamDb.prepare('SELECT * FROM messages WHERE id = ?').get(input.messageId));
        if (!existing) {
          return null;
        }
        teamDb
          .prepare('UPDATE messages SET body = ?, meta_json = ? WHERE id = ?')
          .run(input.body, input.meta ? JSON.stringify(input.meta) : null, input.messageId);
        return { ...existing, body: input.body, meta: input.meta };
      },
      async softDelete(input) {
        const existing = mapMessage(teamDb.prepare('SELECT * FROM messages WHERE id = ?').get(input.messageId));
        if (!existing) {
          return null;
        }
        teamDb
          .prepare('UPDATE messages SET body = ?, meta_json = ? WHERE id = ?')
          .run(input.body, input.meta ? JSON.stringify(input.meta) : null, input.messageId);
        return { ...existing, body: input.body, meta: input.meta };
      },
      async setTaskIdIfAbsent(input) {
        const existing = mapMessage(teamDb.prepare('SELECT * FROM messages WHERE id = ?').get(input.messageId));
        if (!existing) {
          return null;
        }
        const existingTaskId = typeof existing.meta?.taskId === 'string' ? existing.meta.taskId : null;
        if (existingTaskId) {
          return { message: existing, taskId: existingTaskId, inserted: false };
        }
        const meta = {
          ...(existing.meta ?? {}),
          taskId: input.taskId,
        };
        teamDb
          .prepare('UPDATE messages SET meta_json = ? WHERE id = ?')
          .run(JSON.stringify(meta), input.messageId);
        return { message: { ...existing, meta }, taskId: input.taskId, inserted: true };
      },
      async listByChannel(channelId, limit) {
        return teamDb
          .prepare(`
            SELECT * FROM (
              SELECT *, rowid AS _message_rowid FROM messages
              WHERE channel_id = ?
              ORDER BY created_at DESC, _message_rowid DESC
              LIMIT ?
            )
            ORDER BY created_at ASC, _message_rowid ASC
          `)
          .all(channelId, limit)
          .map((row) => {
            const message = mapMessage(row);
            if (!message) {
              throw new Error('SQLite message row could not be mapped');
            }
            return message;
          });
      },
      async listByThread(input) {
        return teamDb
          .prepare(`
            SELECT * FROM (
              SELECT *, rowid AS _message_rowid FROM messages
              WHERE channel_id = ? AND (id = ? OR thread_id = ?)
              ORDER BY created_at DESC, _message_rowid DESC
              LIMIT ?
            )
            ORDER BY created_at ASC, _message_rowid ASC
          `)
          .all(input.channelId, input.threadId, input.threadId, input.limit)
          .map((row) => {
            const message = mapMessage(row);
            if (!message) {
              throw new Error('SQLite message row could not be mapped');
            }
            return message;
          });
      },
      async search(input) {
        if (input.channelIds.length === 0) {
          return [];
        }
        const terms = splitSearchTerms(input.query);
        if (terms.length === 0) {
          return [];
        }
        const placeholders = input.channelIds.map(() => '?').join(', ');
        const likeClauses = terms.map(() => `lower(body) LIKE ? ESCAPE '\\'`).join(' AND ');
        const pool = teamDb
          .prepare(
            `SELECT * FROM messages
             WHERE channel_id IN (${placeholders})
             AND ${likeClauses}`,
          )
          .all(...input.channelIds, ...terms.map((term) => `%${escapeSqlLike(term)}%`))
          .map((row) => mapMessage(row))
          .filter((message): message is NonNullable<typeof message> => message !== null);
        return rankMessageSearch(pool, input.query, input.limit);
      },
      async listThreadBefore(input) {
        const before = mapMessage(teamDb.prepare('SELECT * FROM messages WHERE id = ?').get(input.beforeMessageId));
        if (!before) {
          return [];
        }
        return teamDb
          .prepare(
            `SELECT * FROM messages
             WHERE channel_id = ?
             AND thread_id = ?
             AND id != ?
             AND created_at <= ?
             ORDER BY created_at DESC
             LIMIT ?`,
          )
          .all(input.channelId, input.threadId, input.beforeMessageId, before.createdAt, input.limit)
          .map((row) => {
            const message = mapMessage(row);
            if (!message) {
              throw new Error('SQLite thread message row could not be mapped');
            }
            return message;
          })
          .reverse();
      },
      async deleteByChannel(channelId) {
        teamDb.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
      },
    },
    dispatches: {
      async create(dispatch) {
        teamDb
          .prepare(
            `INSERT INTO dispatches (
              id, team_id, channel_id, message_id, agent_id, device_id, status, request_id, prompt,
              history_json, error_code, error_message, created_at, updated_at, accepted_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dispatch.id,
            dispatch.teamId,
            dispatch.channelId,
            dispatch.messageId,
            dispatch.agentId,
            null,
            dispatch.status,
            dispatch.requestId,
            dispatch.prompt,
            '[]',
            null,
            dispatch.error ?? null,
            dispatch.createdAt,
            dispatch.updatedAt,
            dispatch.acceptedAt ?? null,
            dispatch.completedAt ?? null,
          );
        return dispatch;
      },
      async getById(id) {
        return mapDispatch(teamDb.prepare('SELECT * FROM dispatches WHERE id = ?').get(id));
      },
      async touchPending(input) {
        const result = teamDb
          .prepare(
            `UPDATE dispatches
             SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
             WHERE id = ?
             AND status IN ('queued', 'sent')`,
          )
          .run(input.updatedAt, input.updatedAt, input.dispatchId);
        const dispatch = mapDispatch(teamDb.prepare('SELECT * FROM dispatches WHERE id = ?').get(input.dispatchId));
        return dispatch ? { dispatch, changed: sqliteChanges(result) > 0 } : null;
      },
      async markAccepted(input) {
        const result = teamDb
          .prepare(
            `UPDATE dispatches
             SET status = ?, prompt = ?, updated_at = ?, accepted_at = ?
             WHERE id = ?
             AND agent_id = ?
             AND updated_at = ?
             AND status IN ('queued', 'sent')`,
          )
          .run(
            'accepted',
            input.prompt,
            input.acceptedAt,
            input.acceptedAt,
            input.dispatchId,
            input.agentId,
            input.expectedUpdatedAt,
          );
        const dispatch = mapDispatch(teamDb.prepare('SELECT * FROM dispatches WHERE id = ?').get(input.dispatchId));
        return dispatch ? { dispatch, changed: sqliteChanges(result) > 0 } : null;
      },
      async markSucceeded(input) {
        const result = teamDb
          .prepare(
            `UPDATE dispatches
             SET status = ?, updated_at = ?, completed_at = ?, error_code = NULL, error_message = NULL
             WHERE id = ?
             AND status IN ('queued', 'sent', 'accepted', 'running', 'timed_out')`,
          )
          .run('succeeded', input.completedAt, input.completedAt, input.dispatchId);
        const dispatch = mapDispatch(teamDb.prepare('SELECT * FROM dispatches WHERE id = ?').get(input.dispatchId));
        return dispatch ? { dispatch, changed: sqliteChanges(result) > 0 } : null;
      },
      async markTimedOut(input) {
        const result = teamDb
          .prepare(
            `UPDATE dispatches
             SET status = ?, updated_at = ?, completed_at = ?, error_message = ?
             WHERE id = ?
             AND status IN ('queued', 'sent', 'accepted', 'running')`,
          )
          .run('timed_out', input.completedAt, input.completedAt, input.error, input.dispatchId);
        const dispatch = mapDispatch(teamDb.prepare('SELECT * FROM dispatches WHERE id = ?').get(input.dispatchId));
        return dispatch ? { dispatch, changed: sqliteChanges(result) > 0 } : null;
      },
      async markFailed(input) {
        const result = teamDb
          .prepare(
            `UPDATE dispatches
             SET status = ?, updated_at = ?, completed_at = ?, error_message = ?
             WHERE id = ?
             AND status IN ('queued', 'sent', 'accepted', 'running', 'timed_out')`,
          )
          .run('failed', input.completedAt, input.completedAt, input.error, input.dispatchId);
        const dispatch = mapDispatch(teamDb.prepare('SELECT * FROM dispatches WHERE id = ?').get(input.dispatchId));
        return dispatch ? { dispatch, changed: sqliteChanges(result) > 0 } : null;
      },
      async markCancelled(input) {
        const result = teamDb
          .prepare(
            `UPDATE dispatches
             SET status = ?, updated_at = ?, completed_at = ?, error_code = NULL, error_message = NULL
             WHERE id = ?
             AND status IN ('queued', 'sent', 'accepted', 'running')`,
          )
          .run('cancelled', input.completedAt, input.completedAt, input.dispatchId);
        const dispatch = mapDispatch(teamDb.prepare('SELECT * FROM dispatches WHERE id = ?').get(input.dispatchId));
        return dispatch ? { dispatch, changed: sqliteChanges(result) > 0 } : null;
      },
      async listPendingOlderThan(timestamp) {
        return teamDb
          .prepare(
            `SELECT * FROM dispatches
             WHERE status IN ('queued', 'sent', 'accepted', 'running')
             AND updated_at < ?
             ORDER BY updated_at`,
          )
          .all(timestamp)
          .map((row) => {
            const dispatch = mapDispatch(row);
            if (!dispatch) {
              throw new Error('SQLite dispatch row could not be mapped');
            }
            return dispatch;
          });
      },
      async listByMessage(messageId) {
        return teamDb
          .prepare('SELECT * FROM dispatches WHERE message_id = ? ORDER BY created_at')
          .all(messageId)
          .map((row) => {
            const dispatch = mapDispatch(row);
            if (!dispatch) {
              throw new Error('SQLite dispatch row could not be mapped');
            }
            return dispatch;
          });
      },
      async listByTeam(teamId) {
        return teamDb
          .prepare('SELECT * FROM dispatches WHERE team_id = ? ORDER BY created_at')
          .all(teamId)
          .map((row) => {
            const dispatch = mapDispatch(row);
            if (!dispatch) {
              throw new Error('SQLite dispatch row could not be mapped');
            }
            return dispatch;
          });
      },
    },
    artifacts: {
      async create(artifact) {
        teamDb
          .prepare(
            `INSERT INTO artifacts (
              id, team_id, channel_id, message_id, dispatch_id, workspace_run_id, uploader_id,
              filename, mime_type, size_bytes, storage_path, relative_path, path_kind, sha256, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              message_id = excluded.message_id,
              dispatch_id = excluded.dispatch_id,
              workspace_run_id = excluded.workspace_run_id,
              filename = excluded.filename,
              mime_type = excluded.mime_type,
              size_bytes = excluded.size_bytes,
              storage_path = excluded.storage_path,
              relative_path = excluded.relative_path,
              path_kind = excluded.path_kind,
              sha256 = excluded.sha256,
              created_at = excluded.created_at
            WHERE team_id = excluded.team_id AND channel_id = excluded.channel_id`,
          )
          .run(
            artifact.id,
            artifact.teamId,
            artifact.channelId,
            artifact.messageId ?? null,
            artifact.dispatchId ?? null,
            artifact.workspaceRunId ?? null,
            artifact.uploaderId,
            artifact.filename,
            artifact.mimeType,
            artifact.sizeBytes,
            artifact.storagePath ?? null,
            artifact.relativePath ?? null,
            artifact.pathKind ?? null,
            artifact.sha256 ?? null,
            artifact.createdAt,
          );
        const stored = mapArtifact(teamDb.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifact.id));
        if (!stored) {
          throw new Error('SQLite artifact row could not be mapped');
        }
        return stored;
      },
      async getForTeam(input) {
        return mapArtifact(teamDb.prepare('SELECT * FROM artifacts WHERE team_id = ? AND id = ?').get(input.teamId, input.artifactId));
      },
      async listByMessage(messageId) {
        return teamDb
          .prepare('SELECT * FROM artifacts WHERE message_id = ? ORDER BY created_at')
          .all(messageId)
          .map((row) => {
            const artifact = mapArtifact(row);
            if (!artifact) {
              throw new Error('SQLite artifact row could not be mapped');
            }
            return artifact;
          });
      },
      async listByWorkspaceRunForChannel(input) {
        return teamDb
          .prepare('SELECT * FROM artifacts WHERE team_id = ? AND channel_id = ? AND workspace_run_id = ? ORDER BY created_at')
          .all(input.teamId, input.channelId, input.runId)
          .map((row) => {
            const artifact = mapArtifact(row);
            if (!artifact) {
              throw new Error('SQLite workspace artifact row could not be mapped');
            }
            return artifact;
          });
      },
      async deleteByChannel(channelId) {
        const deletedIds = teamDb
          .prepare('SELECT id FROM artifacts WHERE channel_id = ? ORDER BY id')
          .all(channelId)
          .map((row) => sqliteText(row, 'id'));
        teamDb.prepare('DELETE FROM artifacts WHERE channel_id = ?').run(channelId);
        return deletedIds;
      },
    },
    workspaceRuns: {
      async create(run) {
        teamDb
          .prepare(
            `INSERT INTO workspace_runs (
              id, team_id, channel_id, message_id, dispatch_id, agent_id, device_id, status,
              cwd, command, log_excerpt, exit_code, started_at, completed_at, created_at, updated_at, artifact_ids_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              team_id = excluded.team_id,
              channel_id = excluded.channel_id,
              message_id = excluded.message_id,
              dispatch_id = excluded.dispatch_id,
              agent_id = excluded.agent_id,
              device_id = excluded.device_id,
              status = excluded.status,
              cwd = excluded.cwd,
              command = excluded.command,
              log_excerpt = excluded.log_excerpt,
              exit_code = excluded.exit_code,
              started_at = excluded.started_at,
              completed_at = excluded.completed_at,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              artifact_ids_json = excluded.artifact_ids_json`,
          )
          .run(
            run.id,
            run.teamId,
            run.channelId,
            run.messageId ?? null,
            run.dispatchId,
            run.agentId,
            run.deviceId ?? null,
            run.status,
            run.cwd ?? null,
            run.command ?? null,
            run.logExcerpt ?? null,
            run.exitCode ?? null,
            run.startedAt ?? null,
            run.completedAt ?? null,
            run.createdAt,
            run.updatedAt,
            JSON.stringify(run.artifactIds),
          );
        return run;
      },
      async getForTeam(input) {
        return mapWorkspaceRun(teamDb.prepare('SELECT * FROM workspace_runs WHERE team_id = ? AND id = ?').get(input.teamId, input.runId));
      },
      async listByTeam(input) {
        const conditions: string[] = ['team_id = ?'];
        const params: unknown[] = [input.teamId];
        if (input.agentId !== undefined) {
          conditions.push('agent_id = ?');
          params.push(input.agentId);
        }
        if (input.deviceId !== undefined) {
          conditions.push('device_id = ?');
          params.push(input.deviceId);
        }
        if (input.status !== undefined) {
          conditions.push('status = ?');
          params.push(input.status);
        }
        if (input.cursor !== undefined) {
          conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
          params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
        }
        params.push(input.limit);
        return teamDb
          .prepare(
            `SELECT * FROM workspace_runs WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
          )
          .all(...params)
          .map((row) => {
            const run = mapWorkspaceRun(row);
            if (!run) {
              throw new Error('SQLite workspace run row could not be mapped');
            }
            return run;
          });
      },
      async listByAgent(input) {
        return teamDb
          .prepare('SELECT * FROM workspace_runs WHERE team_id = ? AND agent_id = ? ORDER BY updated_at DESC LIMIT ?')
          .all(input.teamId, input.agentId, input.limit)
          .map((row) => {
            const run = mapWorkspaceRun(row);
            if (!run) {
              throw new Error('SQLite workspace run row could not be mapped');
            }
            return run;
          });
      },
      async listByDispatch(dispatchId) {
        return teamDb
          .prepare('SELECT * FROM workspace_runs WHERE dispatch_id = ? ORDER BY created_at')
          .all(dispatchId)
          .map((row) => {
            const run = mapWorkspaceRun(row);
            if (!run) {
              throw new Error('SQLite workspace run row could not be mapped');
            }
            return run;
          });
      },
    },
    tasks: {
      async create(task) {
        const revision = task.revision ?? 1;
        teamDb
          .prepare(
            `INSERT INTO tasks (
              id, team_id, title, description, status, creator_id, assignee_id, channel_id,
              tags_json, sort_order, created_at, updated_at, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            task.id,
            task.teamId,
            task.title,
            task.description ?? null,
            task.status,
            task.creatorId,
            task.assigneeId ?? null,
            task.channelId ?? null,
            JSON.stringify(task.tags),
            task.sortOrder,
            task.createdAt,
            task.updatedAt,
            revision,
          );
        return { ...task, revision };
      },
      async getById(taskId) {
        return mapTask(teamDb.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
      },
      async list(input) {
        const clauses = ['team_id = ?'];
        const params: unknown[] = [input.teamId];
        const channelClauses: string[] = [];
        if (input.includeGlobal) {
          channelClauses.push('channel_id IS NULL');
        }
        if (input.channelIds.length > 0) {
          channelClauses.push(`channel_id IN (${input.channelIds.map(() => '?').join(', ')})`);
          params.push(...input.channelIds);
        }
        if (channelClauses.length === 0) {
          return [];
        }
        clauses.push(`(${channelClauses.join(' OR ')})`);
        return teamDb
          .prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY sort_order ASC, created_at DESC`)
          .all(...params)
          .map((row) => {
            const task = mapTask(row);
            if (!task) {
              throw new Error('SQLite task row could not be mapped');
            }
            return task;
          });
      },
      async update(input) {
        const existing = mapTask(teamDb.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId));
        if (!existing) {
          return null;
        }
        const updated = { ...existing, ...input.changes };
        teamDb
          .prepare(
            `UPDATE tasks SET
              title = ?, description = ?, status = ?, assignee_id = ?, channel_id = ?,
              tags_json = ?, sort_order = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            updated.title,
            updated.description ?? null,
            updated.status,
            updated.assigneeId ?? null,
            updated.channelId ?? null,
            JSON.stringify(updated.tags),
            updated.sortOrder,
            updated.updatedAt,
            input.taskId,
          );
        return updated;
      },
      async updateAtRevision(input) {
        const existing = mapTask(teamDb.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId));
        if (!existing || existing.revision !== input.expectedRevision) {
          return null;
        }
        const updated = { ...existing, ...input.changes, revision: input.nextRevision };
        const result = teamDb
          .prepare(
            `UPDATE tasks SET
              title = ?, description = ?, status = ?, assignee_id = ?, channel_id = ?,
              tags_json = ?, sort_order = ?, updated_at = ?, revision = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(
            updated.title,
            updated.description ?? null,
            updated.status,
            updated.assigneeId ?? null,
            updated.channelId ?? null,
            JSON.stringify(updated.tags),
            updated.sortOrder,
            updated.updatedAt,
            input.nextRevision,
            input.taskId,
            input.expectedRevision,
          );
        return sqliteChanges(result) === 1 ? updated : null;
      },
      async delete(input) {
        const existing = mapTask(teamDb.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId));
        if (!existing) {
          return null;
        }
        teamDb.prepare('DELETE FROM tasks WHERE id = ?').run(input.taskId);
        return existing;
      },
    },
    reactions: {
      async toggle(input) {
        if (input.on) {
          teamDb
            .prepare('INSERT OR IGNORE INTO message_reactions (id, message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(input.id, input.messageId, input.userId, input.emoji, input.createdAt);
        } else {
          teamDb
            .prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
            .run(input.messageId, input.userId, input.emoji);
        }
      },
      async countByMessage(messageId) {
        const rows = teamDb
          .prepare('SELECT emoji, COUNT(*) as cnt FROM message_reactions WHERE message_id = ? GROUP BY emoji')
          .all(messageId);
        const counts: Record<string, number> = {};
        for (const row of rows) {
          counts[sqliteText(row, 'emoji')] = sqliteNumber(row, 'cnt');
        }
        return counts;
      },
      async getUserReaction(messageId, userId) {
        const row = teamDb
          .prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ? LIMIT 1')
          .get(messageId, userId);
        return row ? sqliteText(row, 'emoji') : null;
      },
    },
    savedMessages: {
      async toggle(input) {
        if (input.on) {
          teamDb
            .prepare('INSERT OR IGNORE INTO saved_messages (id, message_id, user_id, team_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(input.id, input.messageId, input.userId, input.teamId, input.channelId, input.createdAt);
        } else {
          teamDb
            .prepare('DELETE FROM saved_messages WHERE message_id = ? AND user_id = ?')
            .run(input.messageId, input.userId);
        }
      },
      async listByUser(input) {
        return teamDb
          .prepare('SELECT * FROM saved_messages WHERE user_id = ? AND team_id = ? ORDER BY created_at DESC')
          .all(input.userId, input.teamId)
          .map((row) => ({
            id: sqliteText(row, 'id'),
            messageId: sqliteText(row, 'message_id'),
            userId: sqliteText(row, 'user_id'),
            teamId: sqliteText(row, 'team_id'),
            channelId: sqliteText(row, 'channel_id'),
            createdAt: sqliteNumber(row, 'created_at'),
          }));
      },
      async isSaved(messageId, userId) {
        const row = teamDb
          .prepare('SELECT 1 FROM saved_messages WHERE message_id = ? AND user_id = ?')
          .get(messageId, userId);
        return !!row;
      },
    },
    pinnedMessages: {
      async toggle(input) {
        if (input.on) {
          teamDb
            .prepare('INSERT OR IGNORE INTO pinned_messages (id, message_id, user_id, team_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(input.id, input.messageId, input.userId, input.teamId, input.channelId, input.createdAt);
        } else {
          teamDb
            .prepare('DELETE FROM pinned_messages WHERE message_id = ?')
            .run(input.messageId);
        }
      },
      async listByChannel(input) {
        return teamDb
          .prepare('SELECT * FROM pinned_messages WHERE team_id = ? AND channel_id = ? ORDER BY created_at DESC')
          .all(input.teamId, input.channelId)
          .map((row) => ({
            id: sqliteText(row, 'id'),
            messageId: sqliteText(row, 'message_id'),
            userId: sqliteText(row, 'user_id'),
            teamId: sqliteText(row, 'team_id'),
            channelId: sqliteText(row, 'channel_id'),
            createdAt: sqliteNumber(row, 'created_at'),
          }));
      },
      async isPinned(messageId) {
        const row = teamDb
          .prepare('SELECT 1 FROM pinned_messages WHERE message_id = ?')
          .get(messageId);
        return !!row;
      },
    },
    revocations: {
      async find({ teamId, machineId, profileId }) {
        const row = globalDb
          .prepare(
            `SELECT
               team_id AS teamId,
               machine_id AS machineId,
               profile_id AS profileId,
               profile_key AS profileKey,
               device_id AS deviceId,
               deleted_at AS deletedAt
             FROM device_revocations
             WHERE team_id = ? AND machine_id = ? AND profile_key = ?`,
          )
          .get(teamId, machineId, profileId ?? '') as any;
        return row ? { ...row, profileId: row.profileId ?? null } : null;
      },
      async upsertAll({ revocations }) {
        const stmt = globalDb.prepare(
          `INSERT OR REPLACE INTO device_revocations (team_id, machine_id, profile_id, profile_key, device_id, deleted_at)
           VALUES (@teamId, @machineId, @profileId, @profileKey, @deviceId, @deletedAt)`,
        );
        for (const r of revocations) {
          stmt.run({ ...r, profileId: r.profileId ?? null, profileKey: r.profileId ?? '' });
        }
      },
      async clear({ teamId, machineId }) {
        globalDb
          .prepare(`DELETE FROM device_revocations WHERE team_id = ? AND machine_id = ?`)
          .run(teamId, machineId);
      },
    },
  };
  return repositories;
}

function applyMigration(
  db: SqliteDatabase,
  relativePath: string,
  options: { readonly disableForeignKeys?: boolean } = {},
): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );`,
  );
  const existing = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(relativePath);
  if (existing) {
    return;
  }
  const foreignKeysEnabled = options.disableForeignKeys
    && Number((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: unknown } | undefined)?.foreign_keys) === 1;
  if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(readFileSync(resolveMigrationPath(relativePath), 'utf8'));
    if (options.disableForeignKeys && db.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error(`SQLite migration introduced a foreign key violation: ${relativePath}`);
    }
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(relativePath, Date.now());
    db.exec('COMMIT;');
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // The transaction may already be closed by SQLite after a fatal error.
    }
    throw error;
  } finally {
    if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = ON;');
  }
}

function resolveMigrationPath(relativePath: string): string {
  const candidates = [
    join(fileURLToPath(new URL('migrations', import.meta.url)), relativePath),
    join(process.cwd(), 'apps/server-next/src/infra/sqlite/migrations', relativePath),
    join(process.cwd(), 'src/infra/sqlite/migrations', relativePath),
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error(`SQLite migration not found: ${relativePath}`);
  }
  return candidate;
}

function mapUser(row: unknown): UserRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: sqliteText(row, 'id'),
    username: sqliteText(row, 'username'),
    role: sqliteText(row, 'role') as UserRecord['role'],
    displayName: sqliteNullableText(row, 'display_name'),
    passwordHash: sqliteText(row, 'password_hash'),
    currentTeamId: sqliteNullableText(row, 'current_team_id'),
    primaryTeamId: sqliteNullableText(row, 'current_team_id'),
    email: sqliteNullableText(row, 'email'),
    createdAt: sqliteNumber(row, 'created_at'),
    updatedAt: sqliteNumber(row, 'updated_at'),
  };
}

function mapTeam(row: unknown): TeamRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: sqliteText(row, 'id'),
    ownerId: sqliteText(row, 'owner_id'),
    name: sqliteText(row, 'name'),
    path: sqliteText(row, 'path'),
    visibility: sqliteText(row, 'visibility') as TeamRecord['visibility'],
    createdAt: sqliteNumber(row, 'created_at'),
  };
}

function mapJoinLink(row: unknown): JoinLinkRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: sqliteText(row, 'id'),
    code: sqliteText(row, 'code'),
    teamId: sqliteText(row, 'team_id'),
    createdBy: sqliteText(row, 'created_by'),
    createdAt: sqliteNumber(row, 'created_at'),
    expiresAt: sqliteNullableNumber(row, 'expires_at'),
    maxUses: sqliteNullableNumber(row, 'max_uses'),
    usesCount: sqliteNumber(row, 'uses_count'),
    revokedAt: sqliteNullableNumber(row, 'revoked_at'),
  };
}

function mapDeviceInvite(row: unknown): DeviceInviteRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: sqliteText(row, 'id'),
    code: sqliteText(row, 'code'),
    teamId: sqliteText(row, 'team_id'),
    createdBy: sqliteText(row, 'created_by'),
    createdAt: sqliteNumber(row, 'created_at'),
    expiresAt: sqliteNullableNumber(row, 'expires_at'),
    completedAt: sqliteNullableNumber(row, 'completed_at'),
    machineId: sqliteNullableText(row, 'machine_id'),
    profileId: sqliteNullableText(row, 'profile_id'),
    hostname: sqliteNullableText(row, 'hostname'),
    serverUrl: sqliteNullableText(row, 'server_url'),
  };
}

function mapChannel(db: SqliteDatabase, row: unknown): ChannelRecord | null {
  if (!row) {
    return null;
  }
  const id = sqliteText(row, 'id');
  return {
    id,
    teamId: sqliteText(row, 'team_id'),
    kind: sqliteText(row, 'kind') as ChannelRecord['kind'],
    name: sqliteText(row, 'name'),
    title: sqliteNullableText(row, 'description'),
    dmTargetAgentId: sqliteNullableText(row, 'dm_target_agent_id'),
    visibility: sqliteText(row, 'visibility') as ChannelRecord['visibility'],
    createdBy: sqliteNullableText(row, 'created_by'),
    createdAt: sqliteNumber(row, 'created_at'),
    archivedAt: sqliteNullableNumber(row, 'archived_at'),
    humanMemberIds: db
      .prepare('SELECT user_id FROM channel_human_members WHERE channel_id = ? ORDER BY joined_at')
      .all(id)
      .map((member) => sqliteText(member, 'user_id')),
    agentMemberIds: db
      .prepare('SELECT agent_id FROM channel_agent_members WHERE channel_id = ? ORDER BY joined_at')
      .all(id)
      .map((member) => sqliteText(member, 'agent_id')),
  };
}

function mapDevice(row: unknown): DeviceRecord | null {
  if (!row) {
    return null;
  }
  const systemInfoJson = sqliteNullableText(row, 'system_info');
  const capabilitiesJson = sqliteNullableText(row, 'capabilities');
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    ownerId: sqliteText(row, 'owner_id'),
    status: sqliteText(row, 'status') as DeviceRecord['status'],
    hostname: sqliteNullableText(row, 'hostname'),
    name: sqliteNullableText(row, 'name'),
    nameSource: sqliteNullableText(row, 'name_source') as DeviceRecord['nameSource'],
    machineId: sqliteNullableText(row, 'machine_id'),
    profileId: sqliteNullableText(row, 'profile_id'),
    canonicalDeviceId: sqliteNullableText(row, 'canonical_device_id') ?? null,
    daemonVersion: sqliteNullableText(row, 'daemon_version'),
    systemInfo: systemInfoJson ? JSON.parse(systemInfoJson) as DeviceRecord['systemInfo'] : undefined,
    capabilities: capabilitiesJson ? JSON.parse(capabilitiesJson) as DeviceRecord['capabilities'] : undefined,
    lastSeenAt: sqliteNumber(row, 'last_seen_at'),
    createdAt: sqliteNumber(row, 'created_at'),
    updatedAt: sqliteNumber(row, 'updated_at'),
  };
}

function mapRuntime(row: unknown): RuntimeRecord | null {
  if (!row) {
    return null;
  }
  const installed = sqliteNumber(row, 'installed') === 1;
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    deviceId: sqliteText(row, 'device_id'),
    adapterKind: sqliteText(row, 'adapter_kind') as RuntimeRecord['adapterKind'],
    name: sqliteText(row, 'name'),
    installed,
    command: sqliteNullableText(row, 'command'),
    normalizedCommandKey: sqliteNullableText(row, 'normalized_command_key'),
    cwd: sqliteNullableText(row, 'cwd'),
    normalizedCwdKey: sqliteNullableText(row, 'normalized_cwd_key'),
    version: sqliteNullableText(row, 'version'),
    lastSeenAt: sqliteNumber(row, 'last_seen_at'),
  };
}

function mapAgent(db: SqliteDatabase, row: unknown): AgentRecord | null {
  if (!row) {
    return null;
  }
  const id = sqliteText(row, 'id');
  const primaryTeamId = sqliteText(row, 'primary_team_id');
  const hiddenFromPrimary = sqliteNumber(row, 'hidden_from_primary_team') === 1;
  const publishedTeamIds = db
    .prepare('SELECT team_id FROM agent_publications WHERE agent_id = ? ORDER BY published_at')
    .all(id)
    .map((publication) => sqliteText(publication, 'team_id'));
  const rawEnv = parseJsonObject(sqliteNullableText(row, 'env_json'));
  const deletedAt = sqliteNullableNumber(row, 'deleted_at');
  // visibleTeamIds 派生：未删除时 = primary + 已发布团队；hidden_from_primary_team=1 时把 primary 移除。
  // 注意：0009 迁移已清空 agent_publications，这里仍保留 publishedTeamIds 逻辑以兼容旧数据。
  const fullVisible = deletedAt === undefined ? Array.from(new Set([primaryTeamId, ...publishedTeamIds])) : [];
  const visibleTeamIds = hiddenFromPrimary ? fullVisible.filter((t) => t !== primaryTeamId) : fullVisible;
  return {
    id,
    primaryTeamId,
    visibleTeamIds,
    name: sqliteText(row, 'name'),
    adapterKind: sqliteText(row, 'adapter_kind') as AgentRecord['adapterKind'],
    category: sqliteText(row, 'category') as AgentRecord['category'],
    source: sqliteText(row, 'source') as AgentRecord['source'],
    status: sqliteText(row, 'status') as AgentRecord['status'],
    ownerId: sqliteNullableText(row, 'owner_id'),
    deviceId: sqliteNullableText(row, 'device_id'),
    command: sqliteNullableText(row, 'command'),
    args: parseJsonArray(sqliteNullableText(row, 'args_json')),
    cwd: sqliteNullableText(row, 'cwd'),
    skills: (parseJsonArraySafe(sqliteNullableText(row, 'skills_json')) as SkillDto[] | null) ?? undefined,
    gatewayInstanceKey: sqliteNullableText(row, 'gateway_instance_key'),
    envKeys: rawEnv ? Object.keys(rawEnv).sort() : undefined,
    description: sqliteNullableText(row, 'description'),
    lastSeenAt: sqliteNumber(row, 'last_seen_at'),
    lastError: sqliteNullableText(row, 'last_error'),
    nameSource: sqliteText(row, 'name_source') as AgentRecord['nameSource'],
    deletedAt,
  };
}

function mapAgentExecutionConfig(row: unknown): AgentExecutionConfig | null {
  if (!row) {
    return null;
  }
  return {
    adapterKind: sqliteText(row, 'adapter_kind') as AgentExecutionConfig['adapterKind'],
    command: sqliteNullableText(row, 'command'),
    args: parseJsonArray(sqliteNullableText(row, 'args_json')),
    cwd: sqliteNullableText(row, 'cwd'),
    env: parseJsonObject(sqliteNullableText(row, 'env_json')),
  };
}

function mapMessage(row: unknown): MessageRecord | null {
  if (!row) {
    return null;
  }
  const metaJson = sqliteNullableText(row, 'meta_json');
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    channelId: sqliteText(row, 'channel_id'),
    threadId: sqliteNullableText(row, 'thread_id'),
    senderKind: sqliteText(row, 'sender_kind') as MessageRecord['senderKind'],
    senderId: sqliteText(row, 'sender_id'),
    body: sqliteText(row, 'body'),
    createdAt: sqliteNumber(row, 'created_at'),
    meta: metaJson ? JSON.parse(metaJson) as MessageRecord['meta'] : undefined,
  };
}

function mapDispatch(row: unknown): DispatchRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    channelId: sqliteText(row, 'channel_id'),
    messageId: sqliteText(row, 'message_id'),
    agentId: sqliteText(row, 'agent_id'),
    status: sqliteText(row, 'status') as DispatchRecord['status'],
    requestId: sqliteText(row, 'request_id'),
    prompt: sqliteText(row, 'prompt'),
    createdAt: sqliteNumber(row, 'created_at'),
    updatedAt: sqliteNumber(row, 'updated_at'),
    acceptedAt: sqliteNullableNumber(row, 'accepted_at'),
    completedAt: sqliteNullableNumber(row, 'completed_at'),
    error: sqliteNullableText(row, 'error_message'),
  };
}

function mapArtifact(row: unknown): ArtifactRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    channelId: sqliteText(row, 'channel_id'),
    messageId: sqliteNullableText(row, 'message_id'),
    dispatchId: sqliteNullableText(row, 'dispatch_id'),
    workspaceRunId: sqliteNullableText(row, 'workspace_run_id'),
    uploaderId: sqliteText(row, 'uploader_id'),
    filename: sqliteText(row, 'filename'),
    mimeType: sqliteText(row, 'mime_type'),
    sizeBytes: sqliteNumber(row, 'size_bytes'),
    storagePath: sqliteNullableText(row, 'storage_path'),
    relativePath: sqliteNullableText(row, 'relative_path'),
    pathKind: sqliteNullableText(row, 'path_kind') as ArtifactRecord['pathKind'],
    sha256: sqliteNullableText(row, 'sha256'),
    createdAt: sqliteNumber(row, 'created_at'),
  };
}

function mapWorkspaceRun(row: unknown): WorkspaceRunRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    channelId: sqliteText(row, 'channel_id'),
    messageId: sqliteNullableText(row, 'message_id'),
    dispatchId: sqliteText(row, 'dispatch_id'),
    agentId: sqliteText(row, 'agent_id'),
    deviceId: sqliteNullableText(row, 'device_id'),
    status: sqliteText(row, 'status') as WorkspaceRunRecord['status'],
    cwd: sqliteNullableText(row, 'cwd'),
    command: sqliteNullableText(row, 'command'),
    logExcerpt: sqliteNullableText(row, 'log_excerpt'),
    exitCode: sqliteNullableNumber(row, 'exit_code'),
    startedAt: sqliteNullableNumber(row, 'started_at'),
    completedAt: sqliteNullableNumber(row, 'completed_at'),
    createdAt: sqliteNumber(row, 'created_at'),
    updatedAt: sqliteNumber(row, 'updated_at'),
    artifactIds: parseJsonArray(sqliteNullableText(row, 'artifact_ids_json')) ?? [],
  };
}

function mapTask(row: unknown): TaskRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    title: sqliteText(row, 'title'),
    description: sqliteNullableText(row, 'description'),
    status: sqliteText(row, 'status') as TaskRecord['status'],
    creatorId: sqliteText(row, 'creator_id'),
    assigneeId: sqliteNullableText(row, 'assignee_id'),
    channelId: sqliteNullableText(row, 'channel_id'),
    tags: parseJsonArray(sqliteNullableText(row, 'tags_json')) ?? [],
    sortOrder: sqliteNumber(row, 'sort_order'),
    createdAt: sqliteNumber(row, 'created_at'),
    updatedAt: sqliteNumber(row, 'updated_at'),
    revision: sqliteNumber(row, 'revision'),
  };
}

function sqliteText(row: unknown, key: string): string {
  const value = sqliteValue(row, key);
  if (typeof value !== 'string') {
    throw new Error(`Expected SQLite column ${key} to be text`);
  }
  return value;
}

function sqliteNullableText(row: unknown, key: string): string | undefined {
  const value = sqliteValue(row, key);
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected SQLite column ${key} to be nullable text`);
  }
  return value;
}

function sqliteNumber(row: unknown, key: string): number {
  const value = sqliteValue(row, key);
  if (typeof value !== 'number') {
    throw new Error(`Expected SQLite column ${key} to be number`);
  }
  return value;
}

function sqliteChanges(result: unknown): number {
  if (!result || typeof result !== 'object') {
    return 0;
  }
  const changes = (result as { changes?: unknown }).changes;
  return typeof changes === 'number' ? changes : 0;
}

function sqliteNullableNumber(row: unknown, key: string): number | undefined {
  const value = sqliteValue(row, key);
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number') {
    throw new Error(`Expected SQLite column ${key} to be nullable number`);
  }
  return value;
}

function parseJsonArray(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.filter((item): item is string => typeof item === 'string');
}

// 容错解析：用于 skills_json 这类对象数组列。脏/非法 JSON → null，绝不抛错。
function parseJsonArraySafe(raw: string | null | undefined): unknown[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObject(value: string | undefined): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const entries = Object.entries(parsed).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sqliteValue(row: unknown, key: string): unknown {
  if (!row || typeof row !== 'object') {
    throw new Error(`Expected SQLite row object for column ${key}`);
  }
  return (row as Record<string, unknown>)[key];
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

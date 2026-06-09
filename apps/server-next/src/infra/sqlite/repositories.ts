import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type {
  AgentRecord,
  ChannelRecord,
  DeviceRecord,
  DispatchRecord,
  AgentExecutionConfig,
  JoinLinkRecord,
  MessageRecord,
  RuntimeRecord,
  ServerNextRepositories,
  TeamMemberRecord,
  TeamRecord,
  UserRecord,
} from '../../application/repositories.js';

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
}

export function applyTeamMigrations(db: SqliteDatabase): void {
  applyMigration(db, 'team/0001_first_slice.sql');
}

export function createSqliteRepositories(input: CreateSqliteRepositoriesInput): ServerNextRepositories {
  const { globalDb, teamDb } = input;

  return {
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
      async setCurrentTeam(userId, teamId) {
        globalDb.prepare('UPDATE users SET current_team_id = ?, updated_at = updated_at WHERE id = ?').run(teamId, userId);
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
            null,
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
      async listForUser(teamId, userId) {
        return teamDb
          .prepare(
            `SELECT * FROM channels
             WHERE team_id = ?
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
    },
    devices: {
      async upsertHello(device) {
        globalDb
          .prepare(
            `INSERT INTO devices (
              id, team_id, owner_id, machine_id, profile_id, hostname, status, daemon_version,
              system_info, last_seen_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              team_id = excluded.team_id,
              owner_id = excluded.owner_id,
              machine_id = excluded.machine_id,
              profile_id = excluded.profile_id,
              hostname = excluded.hostname,
              status = excluded.status,
              daemon_version = excluded.daemon_version,
              system_info = excluded.system_info,
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at`,
          )
          .run(
            device.id,
            device.teamId,
            device.ownerId,
            device.machineId ?? null,
            device.profileId ?? null,
            device.name ?? null,
            device.status,
            device.daemonVersion ?? null,
            device.systemInfo ? JSON.stringify(device.systemInfo) : null,
            device.lastSeenAt ?? device.updatedAt,
            device.createdAt,
            device.updatedAt,
          );
        return device;
      },
      async getById(id) {
        return mapDevice(globalDb.prepare('SELECT * FROM devices WHERE id = ?').get(id));
      },
      async findByMachineProfile(machineId, profileId) {
        return mapDevice(
          globalDb
            .prepare('SELECT * FROM devices WHERE machine_id = ? AND profile_id = ? ORDER BY updated_at DESC LIMIT 1')
            .get(machineId, profileId),
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
              status, owner_id, device_id, command, args_json, cwd, env_json, last_seen_at, last_error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              primary_team_id = excluded.primary_team_id,
              name = excluded.name,
              normalized_name = excluded.normalized_name,
              adapter_kind = excluded.adapter_kind,
              category = excluded.category,
              source = excluded.source,
              status = excluded.status,
              device_id = excluded.device_id,
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
            agent.env ? JSON.stringify(agent.env) : null,
            agent.lastSeenAt ?? 0,
            agent.lastError ?? null,
            agent.lastSeenAt ?? 0,
            agent.lastSeenAt ?? 0,
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
        return agent;
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
          .prepare('SELECT adapter_kind, command, args_json, cwd, env_json FROM agents WHERE id = ?')
          .get(agentId);
        return mapAgentExecutionConfig(row);
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
             AND agents.source = 'scanned'`,
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
      async listVisibleInTeam(teamId) {
        return globalDb
          .prepare(
            `SELECT agents.* FROM agents
             WHERE agents.primary_team_id = ?
             UNION
             SELECT agents.* FROM agent_publications
             JOIN agents ON agents.id = agent_publications.agent_id
             WHERE agent_publications.team_id = ?`,
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
            null,
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
      async listByChannel(channelId, limit) {
        return teamDb
          .prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at LIMIT ?')
          .all(channelId, limit)
          .map((row) => {
            const message = mapMessage(row);
            if (!message) {
              throw new Error('SQLite message row could not be mapped');
            }
            return message;
          });
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
      async markSucceeded(input) {
        const result = teamDb
          .prepare(
            `UPDATE dispatches
             SET status = ?, updated_at = ?, completed_at = ?, error_code = NULL, error_message = NULL
             WHERE id = ?
             AND status IN ('queued', 'sent', 'accepted', 'running')`,
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
             AND status IN ('queued', 'sent', 'accepted', 'running')`,
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
    },
  };
}

function applyMigration(db: SqliteDatabase, relativePath: string): void {
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
  db.exec(readFileSync(resolveMigrationPath(relativePath), 'utf8'));
  db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(relativePath, Date.now());
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
    visibility: sqliteText(row, 'visibility') as ChannelRecord['visibility'],
    createdBy: sqliteNullableText(row, 'created_by'),
    createdAt: sqliteNumber(row, 'created_at'),
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
  return {
    id: sqliteText(row, 'id'),
    teamId: sqliteText(row, 'team_id'),
    ownerId: sqliteText(row, 'owner_id'),
    status: sqliteText(row, 'status') as DeviceRecord['status'],
    name: sqliteNullableText(row, 'hostname'),
    machineId: sqliteNullableText(row, 'machine_id'),
    profileId: sqliteNullableText(row, 'profile_id'),
    daemonVersion: sqliteNullableText(row, 'daemon_version'),
    systemInfo: systemInfoJson ? JSON.parse(systemInfoJson) as DeviceRecord['systemInfo'] : undefined,
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
  const publishedTeamIds = db
    .prepare('SELECT team_id FROM agent_publications WHERE agent_id = ? ORDER BY published_at')
    .all(id)
    .map((publication) => sqliteText(publication, 'team_id'));
  const rawEnv = parseJsonObject(sqliteNullableText(row, 'env_json'));
  return {
    id,
    primaryTeamId,
    visibleTeamIds: Array.from(new Set([primaryTeamId, ...publishedTeamIds])),
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
    envKeys: rawEnv ? Object.keys(rawEnv).sort() : undefined,
    lastSeenAt: sqliteNumber(row, 'last_seen_at'),
    lastError: sqliteNullableText(row, 'last_error'),
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

function sqliteValue(row: unknown, key: string): unknown {
  if (!row || typeof row !== 'object') {
    throw new Error(`Expected SQLite row object for column ${key}`);
  }
  return (row as Record<string, unknown>)[key];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

#!/usr/bin/env node
/**
 * 清理生产库中的自动化 smoke / 测试残留数据。
 *
 * 默认 dry-run。真正执行需传 --execute。
 *
 * 用法（生产容器内）:
 *   node scripts/cleanup-production-test-data.mjs
 *   node scripts/cleanup-production-test-data.mjs --execute
 *
 * 环境变量:
 *   GLOBAL_DB  默认 /data/agentbean-next/global.sqlite
 *   TEAM_DB    默认 /data/agentbean-next/team.sqlite
 *   BACKUP_DIR 默认 /data/agentbean-next/backups
 */

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const GLOBAL_DB = process.env.GLOBAL_DB || '/data/agentbean-next/global.sqlite';
const TEAM_DB = process.env.TEAM_DB || '/data/agentbean-next/team.sqlite';
const BACKUP_DIR = process.env.BACKUP_DIR || '/data/agentbean-next/backups';
const EXECUTE = process.argv.includes('--execute');
const JSON_OUT = process.argv.includes('--json');

/** 明确保留的真实/长期账号 */
const KEEP_USERNAMES = new Set(['shaw', 'test01', 'debugtest2026', 'derrick', 'kenlu']);
/** 明确保留的团队 path */
const KEEP_TEAM_PATHS = new Set(['agentbean', 'testsns', 'te-s-t', 'debugtest2026', 'derrick', 'kenlu']);
/** 明确保留的设备名 */
const KEEP_DEVICE_NAMES = new Set(['z-imac', 'xiao-mbp', 'xiao-macmini', 'bogon']);

function isTestUsername(username) {
  const s = String(username || '').toLowerCase();
  if (KEEP_USERNAMES.has(s)) return false;
  return (
    /^(smoke-|webui-|admin-dashboard-|release-a-|p1-device-login-|p108storage|volume-)/.test(s)
    || /webui-channel-member|webui-member|unused/.test(s)
    || /codex-img|browser-smoke|business-smoke/.test(s)
  );
}

function isTestTeam(team) {
  const path = String(team.path || '').toLowerCase();
  if (KEEP_TEAM_PATHS.has(path)) return false;
  const s = `${team.name || ''} ${path}`.toLowerCase();
  return (
    /smoke|webui|unused channel|unused webui|release a|codex image|browser-smoke|business-smoke|volume-|p108storage|p1-device|admin-dashboard/.test(s)
    || /agentbean smoke|agentbean-browser-smoke|agentbean-codex/.test(s)
  );
}

function isTestDevice(device) {
  const name = String(device.name || '').toLowerCase();
  if (KEEP_DEVICE_NAMES.has(name)) return false;
  return /smoke|webui|test-|browser|business-smoke|agentbean-/.test(name);
}

function isTestAgent(agent) {
  const name = String(agent.name || '').toLowerCase();
  // 保留真实 Agent（Hermes / BettaFish / 剧本创作 等）
  if (KEEP_DEVICE_NAMES.has(name)) return false;
  return /smoke|webui|test|browser|codex-img|smokecodex|business|admin-dashboard/.test(name);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupIfExecute() {
  if (!EXECUTE) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const tag = stamp();
  const globalBak = join(BACKUP_DIR, `global.sqlite.before-test-cleanup-${tag}.bak`);
  const teamBak = join(BACKUP_DIR, `team.sqlite.before-test-cleanup-${tag}.bak`);
  copyFileSync(GLOBAL_DB, globalBak);
  copyFileSync(TEAM_DB, teamBak);
  return { globalBak, teamBak, tag };
}

function softDeleteDeviceAgents(globalDb, deviceId, now = Date.now()) {
  globalDb.prepare('DELETE FROM device_runtimes WHERE device_id = ?').run(deviceId);
  globalDb.prepare(
    `UPDATE agents
     SET status = ?, env_json = NULL, deleted_at = ?, updated_at = ?, last_seen_at = ?
     WHERE device_id = ? AND deleted_at IS NULL`,
  ).run('offline', now, now, now, deviceId);
  globalDb.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
}

function deleteTeamCascade(globalDb, teamDb, teamId) {
  // 与 repositories.teams.delete 对齐，并补齐设备侧残留
  const deviceIds = globalDb.prepare('SELECT id FROM devices WHERE team_id = ?').all(teamId).map((r) => r.id);
  const now = Date.now();
  for (const deviceId of deviceIds) {
    softDeleteDeviceAgents(globalDb, deviceId, now);
  }

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

  // 可选表：不存在则跳过
  for (const sql of [
    'DELETE FROM team_pi_policies WHERE team_id = ?',
    'DELETE FROM formal_memories WHERE team_id = ?',
    'DELETE FROM experience_packs WHERE team_id = ?',
  ]) {
    try {
      teamDb.prepare(sql).run(teamId);
    } catch {
      // table may not exist
    }
  }

  const agentIds = globalDb.prepare('SELECT id FROM agents WHERE primary_team_id = ?').all(teamId).map((r) => r.id);
  for (const agentId of agentIds) {
    globalDb.prepare('DELETE FROM agent_publications WHERE agent_id = ?').run(agentId);
    try {
      globalDb.prepare('DELETE FROM agent_identity_links WHERE agent_id = ?').run(agentId);
    } catch {
      // optional
    }
  }
  globalDb.prepare('DELETE FROM agent_publications WHERE team_id = ?').run(teamId);
  globalDb.prepare('DELETE FROM agents WHERE primary_team_id = ?').run(teamId);
  globalDb.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
  globalDb.prepare('DELETE FROM join_links WHERE team_id = ?').run(teamId);
  try {
    globalDb.prepare('DELETE FROM device_invites WHERE team_id = ?').run(teamId);
  } catch {
    // optional schema drift
  }
  try {
    globalDb.prepare('DELETE FROM device_revocations WHERE team_id = ?').run(teamId);
  } catch {
    // optional
  }
  globalDb.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
}

function main() {
  if (!existsSync(GLOBAL_DB) || !existsSync(TEAM_DB)) {
    console.error(`DB not found: GLOBAL_DB=${GLOBAL_DB} TEAM_DB=${TEAM_DB}`);
    process.exit(1);
  }

  const globalDb = new Database(GLOBAL_DB);
  const teamDb = new Database(TEAM_DB);
  globalDb.pragma('journal_mode = WAL');
  teamDb.pragma('journal_mode = WAL');
  globalDb.pragma('busy_timeout = 15000');
  teamDb.pragma('busy_timeout = 15000');

  try {
    const users = globalDb.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
    const teams = globalDb.prepare('SELECT id, name, path, owner_id, created_at FROM teams ORDER BY created_at').all();
    const devices = globalDb.prepare('SELECT id, name, owner_id, team_id, status, created_at FROM devices ORDER BY created_at').all();
    const agents = globalDb.prepare(
      'SELECT id, name, primary_team_id, device_id, owner_id, status, deleted_at, created_at FROM agents ORDER BY created_at',
    ).all();

    const delUsers = users.filter((u) => isTestUsername(u.username));
    const keepUsers = users.filter((u) => !isTestUsername(u.username));
    const delTeams = teams.filter((t) => isTestTeam(t));
    const keepTeams = teams.filter((t) => !isTestTeam(t));
    const delDevices = devices.filter((d) => isTestDevice(d) || delTeams.some((t) => t.id === d.team_id));
    // 仍挂在 keep 团队上的真实设备不删
    const finalDelDevices = delDevices.filter((d) => !KEEP_DEVICE_NAMES.has(String(d.name || '').toLowerCase()));
    const delAgents = agents.filter((a) => {
      if (!isTestAgent(a)) return false;
      // 不删 keep 设备上的非 test 名 agent；test 名 agent 可删
      return true;
    });
    // 再并入：挂在将删团队上的 agent（含已 soft-delete）
    const delTeamIds = new Set(delTeams.map((t) => t.id));
    const delDeviceIds = new Set(finalDelDevices.map((d) => d.id));
    const allDelAgents = agents.filter(
      (a) => delTeamIds.has(a.primary_team_id) || delDeviceIds.has(a.device_id) || isTestAgent(a),
    );
    // 保护 keep 设备上的真实 agent
    const keepAgentIds = new Set(
      agents
        .filter((a) => {
          const name = String(a.name || '');
          if (isTestAgent(a)) return false;
          // 真实 agent 名
          return !/smoke|webui|test|browser|codex-img|smokecodex|business|admin-dashboard/i.test(name);
        })
        .map((a) => a.id),
    );
    const finalDelAgents = allDelAgents.filter((a) => !keepAgentIds.has(a.id));

    const plan = {
      mode: EXECUTE ? 'execute' : 'dry-run',
      before: {
        users: users.length,
        teams: teams.length,
        devices: devices.length,
        agents: agents.length,
        agentsActive: agents.filter((a) => !a.deleted_at).length,
      },
      keep: {
        users: keepUsers.map((u) => u.username),
        teams: keepTeams.map((t) => `${t.path} (${t.name})`),
        devices: devices
          .filter((d) => KEEP_DEVICE_NAMES.has(String(d.name || '').toLowerCase()))
          .map((d) => d.name),
        agents: agents
          .filter((a) => keepAgentIds.has(a.id) && !a.deleted_at)
          .map((a) => a.name),
      },
      delete: {
        users: delUsers.length,
        teams: delTeams.length,
        devices: finalDelDevices.length,
        agents: finalDelAgents.length,
      },
      sample: {
        users: delUsers.slice(0, 8).map((u) => u.username),
        teams: delTeams.slice(0, 8).map((t) => t.name),
        devices: finalDelDevices.slice(0, 8).map((d) => d.name),
        agents: finalDelAgents.slice(0, 8).map((a) => a.name),
      },
    };

    // 安全护栏：keep 列表不能为空，且必须包含 admin
    if (!keepUsers.some((u) => u.role === 'admin' && u.username === 'shaw')) {
      console.error('ABORT: keep list missing admin user "shaw"');
      process.exit(2);
    }
    if (!keepTeams.some((t) => t.path === 'agentbean')) {
      console.error('ABORT: keep list missing team path "agentbean"');
      process.exit(2);
    }

    if (!EXECUTE) {
      if (JSON_OUT) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log('=== DRY-RUN production test-data cleanup ===');
        console.log(JSON.stringify(plan, null, 2));
        console.log('\nRe-run with --execute to apply (backup will be created first).');
      }
      return;
    }

    const backup = backupIfExecute();
    const now = Date.now();

    const run = globalDb.transaction(() => {
      // 1) 设备
      for (const device of finalDelDevices) {
        softDeleteDeviceAgents(globalDb, device.id, now);
      }

      // 2) 剩余测试 agent（硬删，含已 soft-delete）
      for (const agent of finalDelAgents) {
        globalDb.prepare('DELETE FROM agent_publications WHERE agent_id = ?').run(agent.id);
        try {
          globalDb.prepare('DELETE FROM agent_identity_links WHERE agent_id = ?').run(agent.id);
        } catch {
          // optional
        }
        // team 侧 channel membership
        try {
          teamDb.prepare('DELETE FROM channel_agent_members WHERE agent_id = ?').run(agent.id);
        } catch {
          // optional
        }
        globalDb.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
      }

      // 3) 测试团队
      for (const team of delTeams) {
        deleteTeamCascade(globalDb, teamDb, team.id);
      }

      // 4) 测试用户（不再拥有团队）
      for (const user of delUsers) {
        const owned = globalDb.prepare('SELECT id FROM teams WHERE owner_id = ?').get(user.id);
        if (owned) {
          throw new Error(`User ${user.username} still owns team ${owned.id}`);
        }
        globalDb.prepare('DELETE FROM team_members WHERE user_id = ?').run(user.id);
        try {
          globalDb.prepare('DELETE FROM user_memory_items WHERE user_id = ?').run(user.id);
        } catch {
          // optional
        }
        // 清空其他用户的 current_team_id 指向已删团队已无妨；清本用户
        globalDb.prepare('UPDATE users SET current_team_id = NULL WHERE id = ?').run(user.id);
        globalDb.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      }

      // 5) 清掉指向已删团队的 current_team_id
      globalDb.prepare(
        `UPDATE users SET current_team_id = NULL
         WHERE current_team_id IS NOT NULL
           AND current_team_id NOT IN (SELECT id FROM teams)`,
      ).run();
    });

    run();

    const afterUsers = globalDb.prepare('SELECT count(*) AS n FROM users').get().n;
    const afterTeams = globalDb.prepare('SELECT count(*) AS n FROM teams').get().n;
    const afterDevices = globalDb.prepare('SELECT count(*) AS n FROM devices').get().n;
    const afterAgents = globalDb.prepare('SELECT count(*) AS n FROM agents').get().n;
    const afterAgentsActive = globalDb.prepare('SELECT count(*) AS n FROM agents WHERE deleted_at IS NULL').get().n;
    const remainingUsers = globalDb.prepare('SELECT username, role FROM users ORDER BY created_at').all();
    const remainingTeams = globalDb.prepare('SELECT name, path FROM teams ORDER BY created_at').all();
    const remainingDevices = globalDb.prepare('SELECT name, status FROM devices ORDER BY created_at').all();
    const remainingAgents = globalDb
      .prepare('SELECT name, status FROM agents WHERE deleted_at IS NULL ORDER BY created_at')
      .all();

    const result = {
      ...plan,
      backup,
      after: {
        users: afterUsers,
        teams: afterTeams,
        devices: afterDevices,
        agents: afterAgents,
        agentsActive: afterAgentsActive,
      },
      remaining: {
        users: remainingUsers,
        teams: remainingTeams,
        devices: remainingDevices,
        agents: remainingAgents,
      },
    };

    if (JSON_OUT) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('=== EXECUTED production test-data cleanup ===');
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    globalDb.close();
    teamDb.close();
  }
}

main();

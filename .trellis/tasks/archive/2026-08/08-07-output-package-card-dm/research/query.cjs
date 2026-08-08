// Production read-only triage for 3 channels' publish/formation state.
// Opens global.sqlite + team.sqlite in READ-ONLY mode. Performs ZERO writes.
// Usage: node query.cjs
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = '/data/agentbean-next';
const TEAM_PATH = 'testsns';

const CHANNELS = [
  { label: '频道1 公共 xiao-mbp', id: 'd8d2317e-2870-497a-b57f-a520a27642aa' },
  { label: '频道2 DM xiao-mbp', id: 'fda9a3be-14b9-44d1-b932-b1a7decaec4c' },
  { label: '频道3 DM xiao-mini', id: '12fd3cca-e4ca-4eea-ba8b-6a7c2a7a601d' },
];

function iso(ms) {
  if (ms == null || typeof ms !== 'number') return ms;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return ms;
  return d.toISOString();
}

function openRo(p) {
  return new Database(p, { readonly: true, fileMustExist: true });
}

function listTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
}

function tableExists(db, name) {
  return listTables(db).includes(name);
}

function safeAll(db, sql, ...args) {
  try {
    return db.prepare(sql).all(...args);
  } catch (e) {
    return { __error: e.message };
  }
}

// ---- 1. resolve team id from global.sqlite ----
let teamId = null;
let teamRow = null;
const gPath = path.join(DATA_DIR, 'global.sqlite');
const gdb = openRo(gPath);
console.log('=== global.sqlite tables ===');
console.log(listTables(gdb));
teamRow = gdb.prepare("SELECT id, name, path, created_at FROM teams WHERE path = ?").get(TEAM_PATH);
console.log(`\n=== team '${TEAM_PATH}' ===`);
console.log(teamRow || `(not found by path=${TEAM_PATH})`);
teamId = teamRow ? teamRow.id : null;
gdb.close();

if (!teamId) {
  console.error('\nFATAL: team not found. Aborting.');
  process.exit(2);
}

// ---- 2. open team.sqlite read-only ----
const tPath = path.join(DATA_DIR, 'team.sqlite');
const db = openRo(tPath);
console.log(`\n=== team.sqlite tables ===`);
console.log(listTables(db));

// Sanity: list ALL channels for this team (helps confirm partition + kind labels)
console.log(`\n=== channels for team ${teamId} (${TEAM_PATH}) ===`);
const allChans = db.prepare(
  "SELECT id, kind, name, visibility, dm_target_agent_id, archived_at, created_at FROM channels WHERE team_id = ? ORDER BY created_at DESC LIMIT 30"
).all(teamId);
for (const c of allChans) {
  const match = CHANNELS.find(x => x.id === c.id);
  console.log({ ...c, created_at: iso(c.created_at), _label: match ? match.label : '(not a triage target)' });
}

// helper for one channel
function triage(channelId) {
  const out = { channelId };

  // channel row
  out.channel = db.prepare(
    "SELECT id, team_id, kind, name, visibility, dm_target_agent_id, archived_at, created_at FROM channels WHERE id = ?"
  ).get(channelId) || null;
  if (out.channel) {
    out.channel.created_at = iso(out.channel.created_at);
  }

  // workspace_publish_stagings (last 10)
  if (tableExists(db, 'workspace_publish_stagings')) {
    const st = db.prepare(
      "SELECT publish_id, channel_id, status, baseline_revision_id, committed_revision_id, committed_workspace_id, created_by, created_at, updated_at FROM workspace_publish_stagings WHERE team_id = ? AND channel_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(teamId, channelId);
    out.stagings = st.map(r => ({ ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) }));
    out.stagingsCount = db.prepare(
      "SELECT COUNT(*) n FROM workspace_publish_stagings WHERE team_id = ? AND channel_id = ?"
    ).get(teamId, channelId).n;
  } else {
    out.stagings = { __tableMissing: true };
  }

  // output_packages
  if (tableExists(db, 'output_packages')) {
    const pkgs = db.prepare(
      "SELECT package_id, delivery_id, publish_id, channel_id, workspace_revision_id, agent_id, task_id, task_binding, task_attempt, member_count, status, created_at FROM output_packages WHERE team_id = ? AND channel_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(teamId, channelId);
    out.outputPackages = pkgs.map(r => ({ ...r, created_at: iso(r.created_at) }));
    out.outputPackagesCount = db.prepare(
      "SELECT COUNT(*) n FROM output_packages WHERE team_id = ? AND channel_id = ?"
    ).get(teamId, channelId).n;

    // members for each package
    if (tableExists(db, 'output_package_members') && pkgs.length) {
      out.outputPackageMembers = pkgs.map(p => {
        const mems = db.prepare(
          "SELECT sequence, short_label, collection_id, artifact_version_id, filename, source_path, required_for_final FROM output_package_members WHERE team_id = ? AND package_id = ? ORDER BY sequence"
        ).all(teamId, p.package_id);
        return { packageId: p.package_id, count: mems.length, members: mems };
      });
    }
  } else {
    out.outputPackages = { __tableMissing: true };
  }

  // output-package command receipts (proves the formation command ran at all)
  if (tableExists(db, 'output_package_command_receipts')) {
    const recs = safeAll(db,
      "SELECT receipt_id, idempotency_key, outcome, result_json, commit_time, created_at FROM output_package_command_receipts WHERE team_id = ? AND idempotency_key LIKE ? ORDER BY created_at DESC LIMIT 10",
      teamId, `%:${channelId}:%`
    );
    out.commandReceipts = Array.isArray(recs) ? recs.map(r => ({
      ...r,
      result_json: r.result_json ? (() => { try { return JSON.parse(r.result_json); } catch { return r.result_json; } })() : null,
      commit_time: iso(r.commit_time),
      created_at: iso(r.created_at),
    })) : recs;
  }

  // messages: system output-package + total counts
  const sysOutPkg = db.prepare(
    "SELECT id, channel_id, thread_id, sender_kind, sender_id, sender_name, body, client_message_id, meta_json, created_at FROM messages WHERE channel_id = ? AND sender_kind = 'system' AND (meta_json LIKE '%output-package%' OR client_message_id LIKE 'output-package:%') ORDER BY created_at DESC LIMIT 10"
  ).all(channelId);
  out.systemOutputPackageMessages = sysOutPkg.map(r => ({
    id: r.id,
    thread_id: r.thread_id,
    sender_kind: r.sender_kind,
    sender_name: r.sender_name,
    body: r.body,
    client_message_id: r.client_message_id,
    created_at: iso(r.created_at),
    meta: r.meta_json ? (() => { try { return JSON.parse(r.meta_json); } catch { return r.meta_json; } })() : null,
  }));

  out.messageTotals = {
    all: db.prepare("SELECT COUNT(*) n FROM messages WHERE channel_id = ?").get(channelId).n,
    system: db.prepare("SELECT COUNT(*) n FROM messages WHERE channel_id = ? AND sender_kind = 'system'").get(channelId).n,
    systemOutputPackage: db.prepare(
      "SELECT COUNT(*) n FROM messages WHERE channel_id = ? AND sender_kind = 'system' AND (meta_json LIKE '%output-package%' OR client_message_id LIKE 'output-package:%')"
    ).get(channelId).n,
  };

  // latest messages (any kind) for sanity
  out.latestMessages = db.prepare(
    "SELECT id, sender_kind, sender_name, body, client_message_id, created_at FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 5"
  ).all(channelId).map(r => ({ ...r, created_at: iso(r.created_at) }));

  return out;
}

// ---- 3. run triage per channel ----
for (const c of CHANNELS) {
  console.log(`\n\n========== ${c.label} (${c.id}) ==========`);
  try {
    const result = triage(c.id);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ channelId: c.id, __fatal: e.message, stack: e.stack }, null, 2));
  }
}

db.close();
console.log('\n=== DONE ===');

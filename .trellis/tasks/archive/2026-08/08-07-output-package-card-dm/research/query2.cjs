// Extended triage: workspaces, revisions, device/daemon versions, dispatches.
// READ-ONLY. Zero writes.
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = '/data/agentbean-next';
const TEAM_PATH = 'testsns';
const TEAM_ID = '5272b023-0fb0-4386-9259-d9a81ca0e8fd';

const CHANNELS = [
  { label: '频道1 公共 xiao-mbp', id: 'd8d2317e-2870-497a-b57f-a520a27642aa', agentId: null },
  { label: '频道2 DM xiao-mbp', id: 'fda9a3be-14b9-44d1-b932-b1a7decaec4c', agentId: '0dfe86cd-354c-4273-bd49-6dd54078b53b' },
  { label: '频道3 DM xiao-mini', id: '12fd3cca-e4ca-4eea-ba8b-6a7c2a7a601d', agentId: '8008b58c-c94f-4803-91cb-cafc8bee84c2' },
];

function iso(ms){ if(ms==null)return ms; const d=new Date(ms); return Number.isNaN(d.getTime())?ms:d.toISOString(); }
const tro = p => new Database(p, { readonly: true, fileMustExist: true });

// ---- global.sqlite: device runtimes + agents (daemon versions) ----
const gdb = tro(path.join(DATA_DIR, 'global.sqlite'));
console.log('=== devices (xiao-mbp / xiao-mini) ===');
const devRows = gdb.prepare(
  "SELECT id, name, canonical_device_id, created_at FROM devices WHERE name LIKE '%xiao-mbp%' OR name LIKE '%xiao-mini%' OR name LIKE '%xiao%' ORDER BY created_at DESC LIMIT 20"
).all();
for (const d of devRows) console.log({ ...d, created_at: iso(d.created_at) });

console.log('\n=== device_runtings (daemon version per device) ===');
if (gdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_runtimes'").get()) {
  const rt = gdb.prepare(
    "SELECT * FROM device_runtimes LIMIT 50"
  ).all();
  console.log(JSON.stringify(rt, null, 2));
}

console.log('\n=== agents (Hermes-xiao-*) ===');
const agents = gdb.prepare(
  "SELECT id, name, device_id, created_at FROM agents WHERE name LIKE '%Hermes%xiao%' OR name LIKE '%xiao%' ORDER BY created_at DESC LIMIT 20"
).all();
for (const a of agents) console.log({ ...a, created_at: iso(a.created_at) });

console.log('\n=== agent_identity_links (team visibility for Hermes agents) ===');
const links = gdb.prepare(
  "SELECT * FROM agent_identity_links WHERE agent_id IN (SELECT id FROM agents WHERE name LIKE '%Hermes%xiao%') LIMIT 30"
).all();
console.log(JSON.stringify(links, null, 2));
gdb.close();

// ---- team.sqlite ----
const db = tro(path.join(DATA_DIR, 'team.sqlite'));

console.log('\n=== project_channel_workspaces for triage channels ===');
const ws = db.prepare(
  "SELECT * FROM project_channel_workspaces WHERE channel_id IN ('d8d2317e-2870-497a-b57f-a520a27642aa','fda9a3be-14b9-44d1-b932-b1a7decaec4c','12fd3cca-e4ca-4eea-ba8b-6a7c2a7a601d')"
).all();
console.log(JSON.stringify(ws, null, 2));

console.log('\n=== project_channel_workspace_revisions for triage channels ===');
const rev = db.prepare(
  "SELECT id, channel_id, workspace_id, parent_revision_id, created_at FROM project_channel_workspace_revisions WHERE channel_id IN ('d8d2317e-2870-497a-b57f-a520a27642aa','fda9a3be-14b9-44d1-b932-b1a7decaec4c','12fd3cca-e4ca-4eea-ba8b-6a7c2a7a601d') ORDER BY created_at DESC LIMIT 20"
).all();
for (const r of rev) console.log({ ...r, created_at: iso(r.created_at) });

console.log('\n=== channel_agent_members (agent membership per triage channel) ===');
const cam = db.prepare(
  "SELECT * FROM channel_agent_members WHERE channel_id IN ('d8d2317e-2870-497a-b57f-a520a27642aa','fda9a3be-14b9-44d1-b932-b1a7decaec4c','12fd3cca-e4ca-4eea-ba8b-6a7c2a7a601d')"
).all();
console.log(JSON.stringify(cam, null, 2));

console.log('\n=== ALL workspace_publish_stagings for these 3 channels (any status, ever) ===');
const allSt = db.prepare(
  "SELECT publish_id, channel_id, status, baseline_revision_id, committed_revision_id, created_by, created_at, updated_at FROM workspace_publish_stagings WHERE channel_id IN ('d8d2317e-2870-497a-b57f-a520a27642aa','fda9a3be-14b9-44d1-b932-b1a7decaec4c','12fd3cca-e4ca-4eea-ba8b-6a7c2a7a601d') ORDER BY created_at DESC"
).all();
for (const s of allSt) console.log({ ...s, created_at: iso(s.created_at), updated_at: iso(s.updated_at) });

console.log('\n=== recent dispatches per triage channel (last 5 each) ===');
for (const c of CHANNELS) {
  const ds = db.prepare(
    "SELECT id, channel_id, agent_id, device_id, status, request_id, error_code, error_message, created_at, updated_at, completed_at FROM dispatches WHERE channel_id = ? ORDER BY created_at DESC LIMIT 5"
  ).all(c.id);
  console.log(`\n--- ${c.label} (${c.id}) ---`);
  for (const d of ds) console.log({ ...d, created_at: iso(d.created_at), updated_at: iso(d.updated_at), completed_at: iso(d.completed_at) });
}

console.log('\n=== agent_publications (global.sqlite) sanity for recent dispatch publish ids ===');
// (already closed gdb; reopen for agent_publications which is global per memory)
const gdb2 = tro(path.join(DATA_DIR, 'global.sqlite'));
const pubs = gdb2.prepare(
  "SELECT * FROM agent_publications WHERE channel_id IN ('d8d2317e-2870-497a-b57f-a520a27642aa','fda9a3be-14b9-44d1-b932-b1a7decaec4c','12fd3cca-e4ca-4eea-ba8b-6a7c2a7a601d') ORDER BY created_at DESC LIMIT 20"
).all();
console.log(JSON.stringify(pubs, null, 2));
gdb2.close();

db.close();
console.log('\n=== DONE ===');

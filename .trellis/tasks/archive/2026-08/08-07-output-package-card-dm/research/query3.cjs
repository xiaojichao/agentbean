// query3: workspaces, dispatches, device daemon version. READ-ONLY.
'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const DATA_DIR = '/data/agentbean-next';
const CH = ['d8d2317e-2870-497a-b57f-a520a27642aa','fda9a3be-14b9-44d1-b932-b1a7decaec4c','12fd3cca-e4ca-4eea-ba8b-6a7c2a7a601d'];
const XIAO_MBP_DEV = 'eaeb6e96-6aa9-411e-b14d-2c1325dfd76b';
const XIAO_MINI_DEV = 'd0b2fbc9-52b0-4084-8882-06f433f1036e';
const iso = ms => (ms==null?ms:(()=>{const d=new Date(ms);return Number.isNaN(d.getTime())?ms:d.toISOString();})());
const tro = p => new Database(p, { readonly:true, fileMustExist:true });

// global: device daemon version + agent Publications
const g = tro(path.join(DATA_DIR,'global.sqlite'));
console.log('=== devices (columns + xiao rows) ===');
const dcols = g.prepare("PRAGMA table_info(devices)").all().map(c=>c.name);
console.log('devices columns:', dcols);
const xdevs = g.prepare("SELECT * FROM devices WHERE id IN (?,?)").get(XIAO_MBP_DEV, XIAO_MINI_DEV);
// get all xiao rows
const dr = g.prepare("SELECT * FROM devices WHERE id IN (?,?)").all(XIAO_MBP_DEV, XIAO_MINI_DEV);
console.log(JSON.stringify(dr, null, 2));

console.log('\n=== agent_publications (global, for triage channels) ===');
let pubs = [];
try { pubs = g.prepare("SELECT * FROM agent_publications WHERE channel_id IN (?,?,?) ORDER BY created_at DESC LIMIT 30").all(...CH); }
catch(e){ console.log('agent_publications err:', e.message); }
console.log(JSON.stringify(pubs, null, 2));
g.close();

// team
const db = tro(path.join(DATA_DIR,'team.sqlite'));
console.log('\n=== project_channel_workspaces for 3 channels ===');
let ws = [];
try { ws = db.prepare("SELECT * FROM project_channel_workspaces WHERE channel_id IN (?,?,?)").all(...CH); }
catch(e){ console.log('err:', e.message); }
console.log(JSON.stringify(ws, null, 2));

console.log('\n=== project_channel_workspace_revisions for 3 channels (last 10) ===');
let rev = [];
try { rev = db.prepare("SELECT id, channel_id, workspace_id, parent_revision_id, created_by, created_at FROM project_channel_workspace_revisions WHERE channel_id IN (?,?,?) ORDER BY created_at DESC LIMIT 10").all(...CH); }
catch(e){ console.log('err:', e.message); }
for(const r of rev) console.log({...r, created_at: iso(r.created_at)});

console.log('\n=== dispatches per channel (last 6, full error) ===');
for(const cid of CH){
  const ds = db.prepare("SELECT id, channel_id, agent_id, device_id, status, request_id, error_code, error_message, created_at, updated_at, completed_at FROM dispatches WHERE channel_id = ? ORDER BY created_at DESC LIMIT 6").all(cid);
  console.log(`\n--- channel ${cid} ---`);
  for(const d of ds) console.log({...d, created_at:iso(d.created_at), updated_at:iso(d.updated_at), completed_at:iso(d.completed_at)});
}

console.log('\n=== invocation_dispatch_attempts (recent, for publish failure context) ===');
try {
  const ida = db.prepare("SELECT * FROM invocation_dispatch_attempts WHERE channel_id IN (?,?,?) ORDER BY rowid DESC LIMIT 10").all(...CH);
  console.log(JSON.stringify(ida, null, 2));
} catch(e){ console.log('err:', e.message); }

db.close();
console.log('\n=== DONE ===');

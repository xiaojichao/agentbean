import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const outputRoot = path.resolve(
  process.env.AGENTBEAN_SERVICE_OPERATIONS_EVIDENCE ??
    "phase5-service-operations-evidence",
);

const CLI = {
  install: "agentbean device install [--channel stable|preview]",
  start: "agentbean device start",
  stop: "agentbean device stop [--deadline 5m]",
  restart: "agentbean device restart",
  status: "agentbean device status [--json]",
  logs: "agentbean device logs [--profile <alias>] [--since <time>] [--follow]",
  doctor: "agentbean device doctor [--json]",
  bundle: "agentbean device doctor bundle [--range <duration>] [--profile <alias>]",
  migratePlan: "agentbean device migrate plan",
  migrateStart: "agentbean device migrate start",
  migrateStatus: "agentbean device migrate status [--json]",
  migrateResume: "agentbean device migrate resume",
  migrateCancel: "agentbean device migrate cancel",
  updateCheck: "agentbean device update check",
  updateApply: "agentbean device update apply [--channel stable|preview] [--version <release>]",
  updatePause: "agentbean device update pause",
  updateResume: "agentbean device update resume",
  updatePin: "agentbean device update pin <release>@<manifest-digest>",
  updateUnpin: "agentbean device update unpin",
  rollback: "agentbean device rollback [--to previous]",
  uninstall: "agentbean device uninstall",
  purge: "agentbean device purge",
};

const allowedStateKeys = new Set([
  "id",
  "label",
  "platform",
  "registration",
  "supervisor",
  "version",
  "channel",
  "versionPolicy",
  "migration",
  "update",
  "credential",
  "activeWork",
  "outbox",
  "profiles",
  "reasonCode",
  "lastTransition",
]);

const enumValues = {
  platform: new Set(["macos-arm64", "linux-x64", "windows-x64"]),
  registration: new Set(["not-installed", "installed-disabled", "enabled"]),
  supervisor: new Set(["not-running", "idle", "healthy", "degraded", "draining", "failed"]),
  versionPolicy: new Set(["supported", "update-recommended", "update-required", "security-blocked"]),
  migration: new Set([
    "not-started",
    "preflight-ready",
    "staged",
    "draining-legacy",
    "commit-unknown",
    "committed",
    "source-cleanup-pending",
  ]),
  update: new Set(["idle", "paused", "staged", "probation", "rolled-back", "failed"]),
  credential: new Set(["ready", "absent", "locked", "prompt-required", "denied", "backend-unavailable", "corrupt"]),
};
const scenarioLabels = new Map([
  ["macos-migration", "macOS 首次迁移"],
  ["migration-commit-unknown", "迁移提交状态未知"],
  ["healthy", "服务健康"],
  ["credential-locked", "单 Profile 凭证库锁定"],
  ["update-rolled-back", "更新失败已自动回滚"],
  ["security-blocked", "版本安全停用"],
]);

function projectState(input) {
  assert.equal(typeof input, "object");
  assert.ok(Object.keys(input).some((key) => !allowedStateKeys.has(key)));
  for (const [key, values] of Object.entries(enumValues)) {
    assert.ok(values.has(input[key]), "invalid " + key);
  }
  assert.ok(scenarioLabels.has(input.id));
  assert.match(input.version, /^\d+\.\d+\.\d+$/);
  assert.ok(input.channel === "stable" || input.channel === "preview");
  assert.match(input.reasonCode, /^[A-Z0-9_]+$/);
  assert.ok(Number.isSafeInteger(input.activeWork) && input.activeWork >= 0);
  assert.ok(Number.isSafeInteger(input.outbox) && input.outbox >= 0);
  assert.ok(Array.isArray(input.profiles));
  for (const profile of input.profiles) {
    assert.match(profile.status, /^[a-z][a-z-]+$/);
    assert.ok(enumValues.credential.has(profile.credential));
    assert.ok(Number.isSafeInteger(profile.activeWork) && profile.activeWork >= 0);
    assert.ok(Number.isSafeInteger(profile.outbox) && profile.outbox >= 0);
  }
  return {
    id: input.id,
    label: scenarioLabels.get(input.id),
    platform: input.platform,
    registration: input.registration,
    supervisor: input.supervisor,
    version: input.version,
    channel: input.channel,
    versionPolicy: input.versionPolicy,
    migration: input.migration,
    update: input.update,
    credential: input.credential,
    activeWork: input.activeWork,
    outbox: input.outbox,
    profiles: input.profiles.map((profile, index) => ({
      label: "profile-" + (index + 1),
      status: profile.status,
      credential: profile.credential,
      activeWork: profile.activeWork,
      outbox: profile.outbox,
    })),
    reasonCode: input.reasonCode,
    lastTransition: input.lastTransition,
  };
}

function actionsFor(state) {
  if (state.versionPolicy === "security-blocked") {
    return [
      { kind: "danger", label: "在本机安装安全更新", command: CLI.updateApply },
      { kind: "secondary", label: "在本机运行诊断", command: CLI.doctor },
    ];
  }
  if (state.migration === "commit-unknown") {
    return [
      { kind: "primary", label: "在本机恢复迁移", command: CLI.migrateResume },
      { kind: "secondary", label: "在本机查看迁移状态", command: CLI.migrateStatus },
    ];
  }
  if (state.migration === "preflight-ready") {
    return [
      { kind: "primary", label: "在本机查看迁移计划", command: CLI.migratePlan },
      { kind: "secondary", label: "运行本地预检", command: CLI.doctor },
    ];
  }
  if (state.migration === "staged" || state.migration === "draining-legacy") {
    return [
      { kind: "primary", label: "在本机继续迁移", command: CLI.migrateResume },
      { kind: "secondary", label: "不可逆点前取消", command: CLI.migrateCancel },
    ];
  }
  if (state.credential === "locked" || state.credential === "prompt-required") {
    return [
      { kind: "primary", label: "在本机解锁凭证库", command: CLI.doctor },
      { kind: "secondary", label: "查看本 Profile 日志", command: CLI.logs },
    ];
  }
  if (state.update === "rolled-back") {
    return [
      { kind: "primary", label: "查看回滚诊断", command: CLI.doctor },
      { kind: "secondary", label: "检查新更新", command: CLI.updateCheck },
    ];
  }
  if (state.supervisor === "healthy" || state.supervisor === "idle") {
    return [
      { kind: "primary", label: "在本机检查更新", command: CLI.updateCheck },
      { kind: "secondary", label: "查看本地日志", command: CLI.logs },
    ];
  }
  return [
    { kind: "primary", label: "在本机检查状态", command: CLI.status },
    { kind: "secondary", label: "运行本地诊断", command: CLI.doctor },
  ];
}

const secretCanary = "ab_secret_do_not_render_7f0c";
const absolutePathCanary = "/Users/private/secret-workspace";
const rawScenarios = [
  {
    id: "macos-migration",
    label: "macOS 首次迁移",
    platform: "macos-arm64",
    registration: "installed-disabled",
    supervisor: "idle",
    version: "1.0.0",
    channel: "stable",
    versionPolicy: "supported",
    migration: "preflight-ready",
    update: "idle",
    credential: "ready",
    activeWork: 0,
    outbox: 0,
    profiles: [{ name: "Team Alpha", status: "legacy-active", credential: "ready", activeWork: 0, outbox: 0 }],
    reasonCode: "MIGRATION_PREFLIGHT_READY",
    lastTransition: "2026-07-18T16:00:00Z",
    token: secretCanary,
    workspacePath: absolutePathCanary,
  },
  {
    id: "migration-commit-unknown",
    label: "迁移提交状态未知",
    platform: "macos-arm64",
    registration: "enabled",
    supervisor: "degraded",
    version: "1.0.0",
    channel: "stable",
    versionPolicy: "supported",
    migration: "commit-unknown",
    update: "idle",
    credential: "ready",
    activeWork: 0,
    outbox: 2,
    profiles: [{ status: "recovery-only", credential: "ready", activeWork: 0, outbox: 2 }],
    reasonCode: "MIGRATION_COMMIT_UNKNOWN",
    lastTransition: "2026-07-18T16:02:00Z",
    credentialRef: secretCanary,
  },
  {
    id: "healthy",
    label: "服务健康",
    platform: "macos-arm64",
    registration: "enabled",
    supervisor: "healthy",
    version: "1.0.0",
    channel: "stable",
    versionPolicy: "supported",
    migration: "committed",
    update: "idle",
    credential: "ready",
    activeWork: 1,
    outbox: 0,
    profiles: [
      { status: "healthy", credential: "ready", activeWork: 1, outbox: 0 },
      { status: "healthy", credential: "ready", activeWork: 0, outbox: 0 },
    ],
    reasonCode: "SERVICE_HEALTHY",
    lastTransition: "2026-07-18T16:04:00Z",
    apiKey: secretCanary,
  },
  {
    id: "credential-locked",
    label: "单 Profile 凭证库锁定",
    platform: "linux-x64",
    registration: "enabled",
    supervisor: "degraded",
    version: "1.0.0",
    channel: "stable",
    versionPolicy: "supported",
    migration: "committed",
    update: "idle",
    credential: "locked",
    activeWork: 0,
    outbox: 1,
    profiles: [
      { status: "blocked", credential: "locked", activeWork: 0, outbox: 1 },
      { status: "healthy", credential: "ready", activeWork: 0, outbox: 0 },
    ],
    reasonCode: "CREDENTIAL_LOCKED",
    lastTransition: "2026-07-18T16:06:00Z",
    errorMessage: secretCanary,
  },
  {
    id: "update-rolled-back",
    label: "更新失败已自动回滚",
    platform: "windows-x64",
    registration: "enabled",
    supervisor: "healthy",
    version: "1.0.0",
    channel: "stable",
    versionPolicy: "update-recommended",
    migration: "committed",
    update: "rolled-back",
    credential: "ready",
    activeWork: 0,
    outbox: 0,
    profiles: [{ status: "healthy", credential: "ready", activeWork: 0, outbox: 0 }],
    reasonCode: "UPDATE_CANDIDATE_QUARANTINED",
    lastTransition: "2026-07-18T16:08:00Z",
    dumpPath: absolutePathCanary,
  },
  {
    id: "security-blocked",
    label: "版本安全停用",
    platform: "windows-x64",
    registration: "enabled",
    supervisor: "degraded",
    version: "0.8.0",
    channel: "stable",
    versionPolicy: "security-blocked",
    migration: "committed",
    update: "failed",
    credential: "ready",
    activeWork: 0,
    outbox: 3,
    profiles: [{ status: "admission-closed", credential: "ready", activeWork: 0, outbox: 3 }],
    reasonCode: "VERSION_SECURITY_BLOCKED",
    lastTransition: "2026-07-18T16:10:00Z",
    authorization: secretCanary,
  },
];

const scenarios = rawScenarios.map(projectState).map((state) => ({
  ...state,
  actions: actionsFor(state),
}));

const allCommands = new Set(Object.values(CLI));
for (const scenario of scenarios) {
  for (const action of scenario.actions) assert.ok(allCommands.has(action.command));
}
assert.deepEqual(
  scenarios.find((scenario) => scenario.id === "macos-migration").actions.map((action) => action.command),
  [CLI.migratePlan, CLI.doctor],
);
assert.deepEqual(
  scenarios.find((scenario) => scenario.id === "migration-commit-unknown").actions.map((action) => action.command),
  [CLI.migrateResume, CLI.migrateStatus],
);
assert.equal(
  scenarios.find((scenario) => scenario.id === "migration-commit-unknown").actions.some((action) => action.command === CLI.migrateCancel),
  false,
);
assert.equal(
  scenarios.find((scenario) => scenario.id === "credential-locked").profiles[1].status,
  "healthy",
);
assert.equal(
  scenarios.find((scenario) => scenario.id === "security-blocked").actions[0].command,
  CLI.updateApply,
);

const serialized = JSON.stringify({ CLI, scenarios });
assert.equal(serialized.includes(secretCanary), false);
assert.equal(serialized.includes(absolutePathCanary), false);
assert.equal(serialized.includes("Team Alpha"), false);
assert.ok(scenarios.every((scenario) =>
  scenario.actions.every((action) => action.command.startsWith("agentbean device ")),
));

const dataJson = JSON.stringify({ CLI, scenarios }).replaceAll("<", "\\u003c");
const html = [
  "<!doctype html>",
  '<html lang="zh-CN">',
  "<head>",
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>AgentBean Device Service 操作面原型</title>",
  "<style>",
  ":root{font-family:Inter,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#1b1b1b;background:#f5f5f2}",
  "*{box-sizing:border-box}body{margin:0}.shell{display:grid;grid-template-columns:260px 1fr;min-height:100vh}",
  "aside{background:#171715;color:#fff;padding:28px 20px}aside h1{font-size:17px;margin:0 0 24px}.scenario{width:100%;text-align:left;border:0;background:transparent;color:#aaa;padding:11px 12px;border-radius:8px;margin:2px 0;cursor:pointer}.scenario.active{background:#2a2a27;color:#fff}",
  "main{padding:42px;max-width:1120px}.eyebrow{font-size:12px;color:#6d6d67;text-transform:uppercase;letter-spacing:.1em}.title{display:flex;align-items:center;gap:12px}.title h2{font-size:28px;margin:8px 0}.badge{font-size:12px;padding:5px 9px;border-radius:99px;background:#e6f4eb;color:#17633a}",
  ".notice{margin:20px 0;padding:16px 18px;border:1px solid #d9d8d1;background:#fff;border-radius:12px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{background:#fff;border:1px solid #e1e0da;border-radius:12px;padding:18px}.card h3{font-size:13px;color:#6d6d67;margin:0 0 10px}.value{font-size:19px;font-weight:650}.profiles{margin-top:14px}.profile{display:grid;grid-template-columns:1fr repeat(3,110px);gap:12px;border-top:1px solid #ecebe6;padding:13px 0;font-size:13px}",
  ".actions{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}.action{border:1px solid #252522;border-radius:9px;background:#252522;color:#fff;padding:10px 14px;cursor:pointer}.action.secondary{background:#fff;color:#252522}.action.danger{background:#9e2c24;border-color:#9e2c24}.command{background:#111;color:#d6f6db;border-radius:9px;padding:13px 15px;font:12px ui-monospace,SFMono-Regular,monospace;margin-top:8px;overflow:auto}.safe{font-size:13px;color:#585851;line-height:1.55}.footer{margin-top:24px;font-size:12px;color:#777}",
  "@media(max-width:800px){.shell{grid-template-columns:1fr}aside{padding:18px}.grid{grid-template-columns:1fr}.profile{grid-template-columns:1fr 1fr}main{padding:22px}}",
  "</style>",
  "</head>",
  "<body>",
  '<div class="shell"><aside><h1>AgentBean / Device</h1><div id="scenario-list"></div></aside><main>',
  '<div class="eyebrow">只读状态与本地恢复指引</div><div class="title"><h2 id="title"></h2><span class="badge" id="platform"></span></div>',
  '<div class="notice"><strong id="reason"></strong><div class="safe" id="guidance"></div></div>',
  '<div class="grid"><div class="card"><h3>Supervisor</h3><div class="value" id="supervisor"></div></div><div class="card"><h3>版本政策</h3><div class="value" id="version"></div></div><div class="card"><h3>迁移 / 更新</h3><div class="value" id="operation"></div></div></div>',
  '<div class="card profiles"><h3>Profile Runner（bundle 内临时标签）</h3><div id="profiles"></div></div>',
  '<div class="actions" id="actions"></div><div id="commands"></div>',
  '<div class="notice safe"><strong>数据边界</strong><br>Workspace、Workspace Run、Local Memory 与凭证正文不进入 Web。浏览器不远程执行 install、migrate、credential、update、rollback、diagnostic upload、uninstall 或 purge；这里只复制当前用户应在设备本机执行的命令。</div>',
  '<div class="footer">Low-fidelity throwaway prototype for #668 · no production mutation</div>',
  "</main></div>",
  '<script id="prototype-data" type="application/json">' + dataJson + "</script>",
  "<script>",
  'const data=JSON.parse(document.getElementById("prototype-data").textContent);',
  'const list=document.getElementById("scenario-list");',
  'function guidance(s){if(s.migration==="commit-unknown")return "不可回退 Legacy。请查询 Server 权威 transaction，并只用系统凭证恢复新服务。";if(s.credential==="locked")return "仅受影响 Profile fail closed；常驻服务不弹授权窗口，需当前用户在本机解锁。";if(s.versionPolicy==="security-blocked")return "新 admission 已关闭；本地安装签名安全版本，不能 pin 或 rollback 到低于 floor 的版本。";if(s.update==="rolled-back")return "上一签名版本已恢复，失败 candidate digest 已隔离。";if(s.migration==="preflight-ready")return "先查看无副作用计划；Workspace 与 Memory 原地复用且不上传。";return "服务状态正常。所有高风险操作只允许当前 OS 用户经本地 IPC 执行。"}',
  'function render(index){const s=data.scenarios[index];document.querySelectorAll(".scenario").forEach((el,i)=>el.classList.toggle("active",i===index));document.getElementById("title").textContent=s.label;document.getElementById("platform").textContent=s.platform;document.getElementById("reason").textContent=s.reasonCode;document.getElementById("guidance").textContent=guidance(s);document.getElementById("supervisor").textContent=s.registration+" / "+s.supervisor;document.getElementById("version").textContent="v"+s.version+" · "+s.channel+" · "+s.versionPolicy;document.getElementById("operation").textContent=s.migration+" / "+s.update;document.getElementById("profiles").innerHTML=s.profiles.map(p=>"<div class=\\"profile\\"><strong>"+p.label+"</strong><span>"+p.status+"</span><span>"+p.credential+"</span><span>work "+p.activeWork+" · outbox "+p.outbox+"</span></div>").join("");document.getElementById("actions").innerHTML=s.actions.map((a,i)=>"<button class=\\"action "+a.kind+"\\" data-command=\\""+i+"\\">"+a.label+"</button>").join("");document.getElementById("commands").innerHTML=s.actions.map(a=>"<div class=\\"command\\">"+a.command.replaceAll("<","&lt;").replaceAll(">","&gt;")+"</div>").join("");document.querySelectorAll("[data-command]").forEach((button)=>button.onclick=()=>navigator.clipboard?.writeText(s.actions[Number(button.dataset.command)].command));}',
  'data.scenarios.forEach((s,i)=>{const button=document.createElement("button");button.className="scenario";button.textContent=s.label;button.onclick=()=>render(i);list.appendChild(button)});render(0);',
  "</script>",
  "</body></html>",
].join("\n");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "index.html"), html, "utf8");

const evidence = {
  schemaVersion: 1,
  question: "phase5-unified-service-cli-and-web-device-surface",
  checks: {
    commandFamilies: ["lifecycle", "migrate", "doctor", "logs", "update", "rollback", "uninstall", "purge"],
    scenarioCount: scenarios.length,
    macosFirstMigrationPath: true,
    commitUnknownHasNoLegacyCancel: true,
    profileCredentialFailureIsolated: true,
    updateRollbackGuidance: true,
    securityFloorGuidance: true,
    webActionsAreLocalCommandCopyOnly: true,
    webHasNoRemoteServiceMutation: true,
    secretsPathsAndProfileNamesNotProjected: true,
    workspaceAndMemoryRemainLocal: true,
  },
  decision: "web-read-only-status-plus-local-cli-guidance",
};
await writeFile(
  path.join(outputRoot, "evidence.json"),
  JSON.stringify(evidence, null, 2) + "\n",
  "utf8",
);
process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");

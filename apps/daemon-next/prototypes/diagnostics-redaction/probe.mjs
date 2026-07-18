import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const MAX_CRASH_BYTES = 256 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BUNDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SERVER_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const prototypeDir = path.dirname(fileURLToPath(import.meta.url));
const evidenceRoot = path.resolve(
  process.env.AGENTBEAN_DIAGNOSTICS_EVIDENCE ?? "phase5-diagnostics-evidence",
);
const stateDir = path.join(evidenceRoot, "state");
const rawDir = path.join(evidenceRoot, "raw-material");
const bundleDir = path.join(evidenceRoot, "bundles");
const serverDir = path.join(evidenceRoot, "server-store");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

async function makePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
}

async function writePrivate(file, contents) {
  await writeFile(file, contents, { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(file, 0o600);
  }
}

function projectEvent(record, counters) {
  const allowedTopLevel = new Set([
    "schemaVersion",
    "timestamp",
    "severity",
    "eventCode",
    "component",
    "status",
    "reasonCode",
    "count",
    "durationBucket",
    "profileLabel",
  ]);
  const eventCodes = new Set([
    "service.ready",
    "runner.state",
    "credential.state",
    "bundle.generated",
  ]);
  const severities = new Set(["info", "warn", "error"]);
  const components = new Set(["supervisor", "profile-runner", "updater"]);
  const reasonCodes = new Set(["startup", "credential-locked", "health-failed"]);
  const durationBuckets = new Set(["<100ms", "100-499ms", "500ms-4s", ">=5s"]);
  const statuses = new Set([
    "ready",
    "available",
    "locked",
    "unavailable",
    "success",
    "deferred",
  ]);
  const timestampMs =
    typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  const timestampValid =
    Number.isFinite(timestampMs) &&
    new Date(timestampMs).toISOString() === record.timestamp;

  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).some((key) => !allowedTopLevel.has(key)) ||
    !eventCodes.has(record.eventCode) ||
    !severities.has(record.severity) ||
    !components.has(record.component) ||
    (record.status !== undefined && !statuses.has(record.status)) ||
    (record.reasonCode !== undefined && !reasonCodes.has(record.reasonCode)) ||
    (record.durationBucket !== undefined &&
      !durationBuckets.has(record.durationBucket)) ||
    !timestampValid ||
    (record.profileLabel !== undefined &&
      !/^profile-[1-9][0-9]*$/.test(record.profileLabel)) ||
    (record.count !== undefined &&
      (!Number.isSafeInteger(record.count) || record.count < 0)) ||
    Object.values(record).some(
      (value) => typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value),
    )
  ) {
    counters.quarantined += 1;
    return null;
  }

  const output = {};
  for (const key of allowedTopLevel) {
    if (record[key] !== undefined) {
      output[key] = record[key];
    }
  }
  return output;
}

async function rotateLogs(logDirectory, nowMs) {
  const names = await readdir(logDirectory);
  const files = [];
  for (const name of names) {
    const file = path.join(logDirectory, name);
    const metadata = await stat(file);
    if (!metadata.isFile()) continue;
    if (nowMs - metadata.mtimeMs > RETENTION_MS) {
      await rm(file);
      continue;
    }
    files.push({ file, mtimeMs: metadata.mtimeMs, size: metadata.size });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  while (total > MAX_LOG_BYTES && files.length > 0) {
    const oldest = files.shift();
    await rm(oldest.file);
    total -= oldest.size;
  }
  return { retainedBytes: total, retainedFiles: files.length };
}

function observeNativeFacility() {
  let command;
  let args;
  let source;
  if (process.platform === "darwin") {
    command = "/usr/bin/log";
    args = [
      "show",
      "--last",
      "1m",
      "--predicate",
      'subsystem == "com.agentbean.prototype"',
      "--style",
      "json",
    ];
    source = "macos-unified-log-scoped-query";
  } else if (process.platform === "linux") {
    command = "journalctl";
    args = [
      "--user-unit=agentbean-device-service-prototype",
      "--since=-1min",
      "--output=json",
      "--no-pager",
    ];
    source = "linux-user-unit-journal-scoped-query";
  } else if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-WinEvent -FilterHashtable @{ProviderName='AgentBeanDeviceServicePrototype';StartTime=(Get-Date).AddMinutes(-1)} -ErrorAction SilentlyContinue | Select-Object -First 1 | Out-Null",
    ];
    source = "windows-provider-scoped-query";
  } else {
    return { source: "unsupported-platform", commandAvailable: false };
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  return {
    source,
    commandAvailable: result.error?.code !== "ENOENT",
    scopedQueryCompleted: result.status === 0,
  };
}

async function assertPrivatePermissions(paths) {
  if (process.platform === "win32") {
    const user = process.env.USERNAME;
    assert.ok(user, "Windows username is required only to apply the current-user ACL");
    const applyExistingAcl = spawnSync(
      "icacls.exe",
      [evidenceRoot, "/inheritance:r", "/grant:r", user + ":F", "/T", "/C"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(
      applyExistingAcl.status,
      0,
      "failed to apply current-user ACL to existing prototype files",
    );
    const applyInheritedAcl = spawnSync(
      "icacls.exe",
      [evidenceRoot, "/grant", user + ":(OI)(CI)F"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(
      applyInheritedAcl.status,
      0,
      "failed to apply inheritable current-user prototype ACL",
    );
    return "current-user-acl-applied";
  }
  for (const target of paths) {
    const metadata = await stat(target);
    assert.equal(metadata.mode & 0o077, 0, target + " is accessible by group/other");
  }
  return "mode-0700-0600-confirmed";
}

function assertCanariesAbsent(buffer, canaries, label) {
  for (const canary of canaries) {
    assert.equal(
      buffer.includes(Buffer.from(canary.value)),
      false,
      label + " leaked canary category " + canary.category,
    );
  }
}

async function concatenateTree(directory) {
  const chunks = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) chunks.push(await readFile(absolute));
    }
  }
  await visit(directory);
  return Buffer.concat(chunks);
}

async function main() {
  await rm(evidenceRoot, { recursive: true, force: true });
  for (const directory of [stateDir, rawDir, bundleDir, serverDir]) {
    await makePrivateDirectory(directory);
  }

  const secretId = randomUUID().replaceAll("-", "");
  const canaries = [
    { category: "device-token", value: "ab_device_" + secretId },
    { category: "bearer", value: "Bearer " + secretId },
    {
      category: "jwt",
      value: "eyJhbGciOiJIUzI1NiJ9." + secretId + ".signature",
    },
    { category: "cookie", value: "session_cookie=" + secretId },
    {
      category: "pem",
      value:
        "-----BEGIN PRIVATE KEY-----\n" + secretId + "\n-----END PRIVATE KEY-----",
    },
    {
      category: "url",
      value: "https://user:" + secretId + "@private.invalid/path?token=" + secretId,
    },
    { category: "workspace", value: "/workspace/private-" + secretId + "/file.txt" },
    { category: "memory", value: "local-memory-body-" + secretId },
    { category: "header", value: "X-API-Key: " + secretId },
    { category: "control", value: "error\r\ninjected-" + secretId + "\u0000" },
  ];

  const now = Date.now();
  const counters = { quarantined: 0 };
  const safeEvents = [
    projectEvent(
      {
        schemaVersion: 1,
        timestamp: new Date(now).toISOString(),
        severity: "info",
        eventCode: "service.ready",
        component: "supervisor",
        status: "ready",
        durationBucket: "100-499ms",
      },
      counters,
    ),
    projectEvent(
      {
        schemaVersion: 1,
        timestamp: new Date(now).toISOString(),
        severity: "warn",
        eventCode: "credential.state",
        component: "profile-runner",
        status: "locked",
        profileLabel: "profile-1",
        count: 1,
      },
      counters,
    ),
  ];
  for (const canary of canaries) {
    const projected = projectEvent(
      {
        schemaVersion: 1,
        timestamp: new Date(now).toISOString(),
        severity: "error",
        eventCode: "runner.state",
        component: "profile-runner",
        errorMessage: canary.value,
      },
      counters,
    );
    assert.equal(projected, null);
    assert.equal(
      projectEvent(
        {
          schemaVersion: 1,
          timestamp: new Date(now).toISOString(),
          severity: "error",
          eventCode: "runner.state",
          component: canary.value,
        },
        counters,
      ),
      null,
    );
  }
  assert.equal(projectEvent({ schemaVersion: 2 }, counters), null);
  assert.ok(safeEvents.every(Boolean));

  const logDir = path.join(stateDir, "logs");
  await makePrivateDirectory(logDir);
  const serviceLog = path.join(logDir, "service.ndjson");
  const serviceBytes = Buffer.from(
    safeEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  await writePrivate(serviceLog, serviceBytes);

  const segmentLine = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      severity: "info",
      eventCode: "runner.state",
      component: "profile-runner",
      status: "ready",
      count: 1,
    }) + "\n",
  );
  const segmentBytes = Buffer.from(
    segmentLine.toString("utf8").repeat(Math.floor((1024 * 1024) / segmentLine.length)),
  );
  for (let index = 0; index < 34; index += 1) {
    const file = path.join(logDir, "segment-" + String(index).padStart(2, "0") + ".ndjson");
    await writePrivate(file, segmentBytes);
    const time = new Date(now - (34 - index) * 1000);
    await utimes(file, time, time);
  }
  const expiredLog = path.join(logDir, "expired.ndjson");
  await writePrivate(expiredLog, segmentLine);
  const expiredTime = new Date(now - RETENTION_MS - 60_000);
  await utimes(expiredLog, expiredTime, expiredTime);
  const rotation = await rotateLogs(logDir, now);
  assert.ok(rotation.retainedBytes <= MAX_LOG_BYTES);
  await assert.rejects(access(expiredLog, fsConstants.F_OK), { code: "ENOENT" });

  const rawReport = path.join(rawDir, "node-report.json");
  const child = spawnSync(
    process.execPath,
    [path.join(prototypeDir, "node-report-child.mjs"), canaries[0].value],
    {
      cwd: evidenceRoot,
      env: {
        ...process.env,
        AGENTBEAN_RAW_REPORT_PATH: rawReport,
        AGENTBEAN_CANARY_SECRET: canaries[1].value,
        AGENTBEAN_CANARY_WORKSPACE: canaries[6].value,
      },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(child.status, 0, "Node report child failed");
  const rawReportBytes = await readFile(rawReport);
  assert.ok(
    canaries.some((canary) => rawReportBytes.includes(Buffer.from(canary.value))),
    "raw Node report did not contain injected canary",
  );
  const report = JSON.parse(rawReportBytes.toString("utf8"));
  const crashSummary = {
    schemaVersion: 1,
    eventCode: "runtime.diagnostic-report",
    component: "device-service",
    trigger: String(report.header?.trigger ?? "unknown").slice(0, 32),
    nodeVersion: String(report.header?.nodejsVersion ?? process.version).slice(0, 32),
    architecture: process.arch,
    platform: process.platform,
    rawMaterialIncluded: false,
  };
  const crashBytes = jsonBytes(crashSummary);
  assert.ok(crashBytes.length <= MAX_CRASH_BYTES);
  assertCanariesAbsent(crashBytes, canaries, "crash summary");

  const doctorSnapshot = {
    schemaVersion: 1,
    serviceState: "ready",
    credentialState: "locked",
    profileCount: 2,
    platform: process.platform,
    architecture: process.arch,
    networkUsed: false,
  };
  const doctorBytes = jsonBytes(doctorSnapshot);
  const entries = [
    { path: "service-events.ndjson", contents: serviceBytes, redacted: 0 },
    {
      path: "crash-summary.json",
      contents: crashBytes,
      redacted: canaries.length,
    },
    { path: "doctor.json", contents: doctorBytes, redacted: 0 },
  ];
  for (const entry of entries) {
    assert.ok(entry.contents.length <= MAX_ENTRY_BYTES);
    assertCanariesAbsent(entry.contents, canaries, entry.path);
  }

  const generatedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + BUNDLE_TTL_MS).toISOString();
  const manifest = {
    schemaVersion: 1,
    redactionPolicyVersion: 1,
    bundleId: randomUUID(),
    generatedAt,
    expiresAt,
    scope: { profileLabels: ["profile-1", "profile-2"] },
    entries: entries.map((entry) => ({
      path: entry.path,
      sizeBytes: entry.contents.length,
      sha256: sha256(entry.contents),
      redacted: entry.redacted,
      omitted: counters.quarantined,
      truncated: false,
    })),
    excludedCategories: [
      "workspace-content",
      "local-memory",
      "credentials",
      "raw-crash-material",
      "environment",
      "argv",
    ],
  };
  const archive = gzipSync(
    jsonBytes({
      manifest,
      entries: entries.map((entry) => ({
        path: entry.path,
        contentsBase64: entry.contents.toString("base64"),
      })),
    }),
    { mtime: 0 },
  );
  assert.ok(archive.length <= MAX_BUNDLE_BYTES);
  assertCanariesAbsent(archive, canaries, "compressed bundle");
  const bundleHash = sha256(archive);
  const bundlePath = path.join(bundleDir, "diagnostics.bundle.json.gz");
  await writePrivate(bundlePath, archive);

  const authorizeUpload = (isTty) => ({
    allowed: isTty,
    reason: isTty ? "interactive-confirmation-required" : "no-tty",
  });
  const noTtyAuthorization = authorizeUpload(false);
  assert.equal(noTtyAuthorization.allowed, false);

  const grant = {
    bundleSha256: bundleHash,
    destinationOrigin: "https://diagnostics.invalid",
    scope: ["profile-1", "profile-2"],
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    nonce: randomUUID(),
  };
  const usedNonces = new Set();
  function validateUpload(bytes, candidateGrant) {
    if (
      Date.parse(candidateGrant.expiresAt) <= Date.now() ||
      sha256(bytes) !== candidateGrant.bundleSha256 ||
      usedNonces.has(candidateGrant.nonce)
    ) {
      return false;
    }
    usedNonces.add(candidateGrant.nonce);
    return true;
  }
  assert.equal(validateUpload(archive, grant), true);
  assert.equal(validateUpload(archive, grant), false, "nonce replay must fail");
  const tampered = Buffer.concat([archive, Buffer.from([0])]);
  assert.equal(
    validateUpload(tampered, { ...grant, nonce: randomUUID() }),
    false,
    "bundle mutation must invalidate the grant",
  );

  const serverBundle = path.join(serverDir, bundleHash + ".bundle");
  await writePrivate(serverBundle, archive);
  const serverAudit = jsonBytes({
    schemaVersion: 1,
    bundleSha256: bundleHash,
    sizeBytes: archive.length,
    expiresAt: new Date(now + SERVER_TTL_MS).toISOString(),
    result: "stored",
  });
  await writePrivate(path.join(serverDir, "audit.json"), serverAudit);

  const permissions = await assertPrivatePermissions([
    evidenceRoot,
    stateDir,
    rawDir,
    bundleDir,
    serverDir,
    serviceLog,
    bundlePath,
    serverBundle,
  ]);
  const nativeFacility = observeNativeFacility();

  for (const [label, directory] of [
    ["local state", stateDir],
    ["local bundle", bundleDir],
    ["server storage", serverDir],
  ]) {
    assertCanariesAbsent(await concatenateTree(directory), canaries, label);
  }

  const cancellationProbe = path.join(bundleDir, "cancelled.bundle");
  await writePrivate(cancellationProbe, archive);
  await rm(cancellationProbe);
  await assert.rejects(access(cancellationProbe, fsConstants.F_OK), { code: "ENOENT" });

  await rm(serverBundle);
  await assert.rejects(access(serverBundle, fsConstants.F_OK), { code: "ENOENT" });
  await rm(rawDir, { recursive: true, force: true });
  await assert.rejects(access(rawDir, fsConstants.F_OK), { code: "ENOENT" });

  const evidence = {
    schemaVersion: 1,
    question: "phase5-diagnostics-redaction-bundle-boundary",
    host: { platform: process.platform, architecture: process.arch },
    checks: {
      typedAllowlistAndUnknownSchemaQuarantine: true,
      injectedCanaryCategories: canaries.length,
      canaryAbsentFromOperationalLogBundleUploadAndServerStore: true,
      rawNodeReportExcludedAndDeleted: true,
      crashSummaryAllowlistOnly: true,
      logRetentionSevenDaysAndThirtyTwoMiB: true,
      bundleLimitTwentyFiveMiB: true,
      entryLimitFiveMiB: true,
      localBundleTtlTwentyFourHours: true,
      serverTtlFourteenDays: true,
      noTtyUploadDenied: true,
      bundleMutationDenied: true,
      nonceReplayDenied: true,
      cancellationDeletesLocalBundle: true,
      earlyDeleteRemovesServerObject: true,
      permissions,
      nativeFacility,
    },
    counts: {
      quarantinedRecords: counters.quarantined,
      retainedLogFiles: rotation.retainedFiles,
      retainedLogBytes: rotation.retainedBytes,
      bundleBytes: archive.length,
    },
    verdict: "hosted-platform-partial-needs-real-installed-session-transitions",
  };
  const evidenceBytes = jsonBytes(evidence);
  assertCanariesAbsent(evidenceBytes, canaries, "evidence");
  await writePrivate(path.join(evidenceRoot, "evidence.json"), evidenceBytes);
  process.stdout.write(evidenceBytes);
}

await main();

#!/usr/bin/env node

import { execFile, spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const label = 'com.agentbean.device-service';
const uid = process.getuid?.();

export async function runPhase5ADeviceServiceSmoke(options = {}) {
  const log = options.log ?? console.log;
  const skipBuild = options.skipBuild ?? false;
  if (process.platform !== 'darwin') {
    log('Phase 5A Device Service smoke skipped: macOS is required.');
    return { skipped: true };
  }
  if (!Number.isSafeInteger(uid)) throw new Error('Phase 5A smoke requires a normal user session.');

  await assertProductionServiceIsAbsent();
  if (!skipBuild) run('npm', ['run', 'build:daemon-next']);

  // Darwin limits Unix-domain socket paths to roughly 104 bytes. Keep the
  // isolated root deliberately short so control.sock exercises the real path.
  const tempRoot = await mkdtemp('/tmp/ab-p5a-');
  const home = join(tempRoot, 'home');
  const baseDir = join(home, '.agentbean');
  const fixtureFile = join(tempRoot, 'device-service-fixture.mjs');
  const configFile = join(baseDir, 'service', 'smoke-config.json');
  const bootFile = join(baseDir, 'service', 'smoke-boots.jsonl');
  let adapter;

  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const modules = await loadBuiltModules();
    const {
      DEVICE_CLI_EXIT,
      runDeviceCli,
    } = modules.deviceCli;
    const paths = modules.paths.deviceServicePaths(baseDir);
    const client = modules.controlClient.createDeviceControlClient(paths.controlSocket);
    adapter = modules.launchAgent.createMacOSLaunchAgentAdapter({ uid, home, baseDir });

    await writeFixture(fixtureFile, baseDir);
    await writeSmokeConfig(configFile, {
      profiles: [{ id: 'healthy' }, { id: 'failed', failStart: true }],
      signalDeadlineMs: 500,
    });
    await writeCanaries(baseDir, home);

    const migrated = await modules.migration.startDeviceMigration({
      baseDir,
      listLegacy: async () => [],
      listUnregisteredLegacyPids: async () => [],
      listInstalledLegacyExecutables: async () => [],
      stopLegacy: async () => undefined,
      prepareMigrationService: async () => undefined,
      verifyMigrationService: async () => true,
      activateDeviceService: async () => undefined,
    });
    assert(migrated.owner === 'device-service' && migrated.phase === 'committed', 'migration did not commit');

    const deps = {
      platform: 'darwin',
      uid,
      home,
      baseDir,
      executablePath: fixtureFile,
      nodeExecutablePath: process.execPath,
      createAdapter: () => adapter,
      controlClient: client,
    };
    const cli = async (argv, expected) => {
      const stdout = [];
      const stderr = [];
      const code = await runDeviceCli(argv, {
        ...deps,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });
      assert(code === expected, `${argv.join(' ')} exited ${code}: ${stderr.join('\n')}`);
      return { code, stdout, stderr };
    };

    await cli(['install', '--deadline-ms', '10000'], DEVICE_CLI_EXIT.success);
    log('  ✓ install + degraded sibling isolation');
    let state = await waitForState(client, (value) => value.phase === 'degraded');
    assert(state.profiles.healthy === 1 && state.profiles.failed === 1, 'failed Profile affected its sibling');
    const installedPid = state.pid;
    log(`    initial pid ${installedPid}`);

    await delay(250);
    state = await readState(client);
    assert(state.pid === installedPid, 'service did not survive the installer command returning');
    const initialBoots = await readBootEvents(bootFile);
    assert(initialBoots.length === 1, 'unexpected initial launch count');
    assert(initialBoots[0]?.ppid === 1, 'service is not owned by launchd after the installer returns');

    await cli(['status', '--json'], DEVICE_CLI_EXIT.success);
    await cli(['restart', '--deadline-ms', '10000'], DEVICE_CLI_EXIT.success);
    log('  ✓ status + restart');
    state = await waitForState(client, (value) => value.pid !== installedPid);
    const restartedPid = state.pid;
    log(`    restarted pid ${restartedPid}`);

    process.kill(restartedPid, 'SIGKILL');
    state = await waitForState(client, (value) => value.pid !== restartedPid, 25_000);
    log(`    recovered pid ${state.pid}`);
    assert((await readBootEvents(bootFile)).length >= 3, 'launchd did not recover an abnormal exit');
    log('  ✓ abnormal exit recovery');

    await writeSmokeConfig(configFile, {
      profiles: [{ id: 'healthy-a' }, { id: 'healthy-b' }],
      signalDeadlineMs: 500,
    });
    await adapter.start();
    state = await waitForState(client, (value) => value.phase === 'running' && value.profiles.healthy === 2);
    const sigtermPid = state.pid;
    await adapter.kill();
    await waitForPlatform(adapter, (value) => !value.running);
    await delay(300);
    assert(!(await adapter.status()).running, 'clean SIGTERM unexpectedly triggered KeepAlive');
    assert((await readJson(paths.stateFile)).phase === 'stopped', 'SIGTERM did not use the drain path');
    log('  ✓ SIGTERM drain');

    await cli(['start', '--deadline-ms', '10000'], DEVICE_CLI_EXIT.success);
    state = await waitForState(client, (value) => value.pid !== sigtermPid && value.phase === 'running');
    const socketLossPid = state.pid;
    await rm(paths.controlSocket, { force: true });
    await cli(['stop', '--deadline-ms', '500'], DEVICE_CLI_EXIT.rejected);
    assert((await adapter.status()).running, 'socket loss caused an unsafe forced stop');
    assertProcessAlive(socketLossPid, 'service exited after control socket loss');
    await adapter.start();
    state = await waitForState(client, (value) => value.pid !== socketLossPid && value.phase === 'running');
    log('  ✓ control socket loss is fail-closed');

    await writeSmokeConfig(configFile, {
      profiles: [{ id: 'slow', drainDelayMs: 2_000 }],
      signalDeadlineMs: 100,
    });
    await adapter.start();
    state = await waitForState(client, (value) => value.profiles.total === 1 && value.phase === 'running');
    const timeoutPid = state.pid;
    await cli(['stop', '--deadline-ms', '100'], DEVICE_CLI_EXIT.drain);
    state = await waitForState(client, (value) => value.pid !== timeoutPid, 12_000);
    assert(state.pid !== timeoutPid, 'drain timeout did not exit non-zero for launchd recovery');
    log('  ✓ drain timeout recovery');

    await writeSmokeConfig(configFile, {
      profiles: [{ id: 'healthy-a' }, { id: 'healthy-b' }],
      signalDeadlineMs: 500,
    });
    await adapter.start();
    await waitForState(client, (value) => value.phase === 'running' && value.profiles.healthy === 2);

    const legacy = spawnSync(process.execPath, [builtPath('bin.js')], {
      env: minimalEnvironment(baseDir),
      encoding: 'utf8',
      timeout: 5_000,
    });
    const legacyOutput = `${legacy.stdout ?? ''}${legacy.stderr ?? ''}`;
    assert(legacy.status === 1, 'Legacy entry was not fenced after migration commit');
    assert(legacyOutput.includes('DEVICE_SERVICE_OWNS_RUNTIME'), 'Legacy fence did not return the stable instruction');
    log('  ✓ migration commit fence');

    await cli(['uninstall', '--deadline-ms', '10000'], DEVICE_CLI_EXIT.success);
    assert(!(await adapter.status()).installed, 'uninstall retained the plist');
    await assertMissing(paths.payloadFile, 'uninstall retained the service payload');
    await assertCanaries(baseDir, home);

    log('Phase 5A macOS Device Service smoke passed.');
    return {
      skipped: false,
      lifecycle: ['install', 'status', 'restart', 'stop', 'start', 'uninstall'],
      faults: ['profile-start', 'SIGTERM', 'control-socket-loss', 'drain-timeout', 'SIGKILL'],
      boots: (await readBootEvents(bootFile)).length,
    };
  } finally {
    if (adapter) {
      const status = await adapter.status().catch(() => ({ loaded: false }));
      if (status.loaded) await adapter.bootout().catch(() => undefined);
    }
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true });
    else log(`Phase 5A smoke artifacts kept at ${tempRoot}`);
  }
}

async function loadBuiltModules() {
  const [deviceCli, controlClient, launchAgent, migration, paths] = await Promise.all([
    import(pathToFileURL(builtPath('device-cli.js')).href),
    import(pathToFileURL(builtPath('device-control-client.js')).href),
    import(pathToFileURL(builtPath('macos-launch-agent.js')).href),
    import(pathToFileURL(builtPath('device-migration.js')).href),
    import(pathToFileURL(builtPath('device-service-paths.js')).href),
  ]);
  return { deviceCli, controlClient, launchAgent, migration, paths };
}

async function writeFixture(path, baseDir) {
  const hostUrl = pathToFileURL(builtPath('device-service-host.js')).href;
  const content = `import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDeviceServiceHost, bindDeviceServiceSignals } from ${JSON.stringify(hostUrl)};
const baseDir = ${JSON.stringify(baseDir)};
const config = JSON.parse(await readFile(join(baseDir, 'service', 'smoke-config.json'), 'utf8'));
function createRunner(profile) {
  let phase = 'stopped';
  return {
    profileId: profile.id,
    async start() { phase = 'starting'; if (profile.failStart) { phase = 'failed'; throw new Error('PROFILE_START_FAILED'); } phase = 'healthy'; },
    async beginDrain() { phase = 'draining'; if (profile.drainDelayMs) await new Promise((resolve) => setTimeout(resolve, profile.drainDelayMs)); return { ok: true }; },
    async stop() { phase = 'stopped'; },
    snapshot() { return { phase, activeWorkCount: 0, outboxPendingCount: 0 }; },
  };
}
const host = createDeviceServiceHost({ runners: config.profiles.map(createRunner), version: 'phase5a-smoke', baseDir });
bindDeviceServiceSignals(host, process, config.signalDeadlineMs ?? 500, process);
await host.start();
await appendFile(join(baseDir, 'service', 'smoke-boots.jsonl'), JSON.stringify({ pid: process.pid, ppid: process.ppid, at: Date.now() }) + '\\n');
`;
  await writeFile(path, content, { mode: 0o700 });
}

async function assertProductionServiceIsAbsent() {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  try {
    await access(plist);
    throw new Error(`Refusing to run: ${plist} already exists.`);
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) throw error;
  }
  const result = await exec('/bin/launchctl', ['print', `gui/${uid}/${label}`]);
  if (result.exitCode === 0) throw new Error(`Refusing to run: ${label} is already loaded.`);
}

async function writeSmokeConfig(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function writeCanaries(baseDir, home) {
  const values = canaries(baseDir, home);
  for (const [path, value] of values) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { mode: 0o600 });
  }
}

async function assertCanaries(baseDir, home) {
  for (const [path, expected] of canaries(baseDir, home)) {
    const actual = await readFile(path);
    assert(actual.equals(expected), `uninstall changed retained data: ${path}`);
  }
}

function canaries(baseDir, home) {
  return new Map([
    [join(baseDir, 'teams', 'profile-a', 'auth.json'), Buffer.from('{"token":"retained","serverUrl":"https://agentbean.invalid","teamId":"team-smoke","ownerId":"owner-smoke"}\n')],
    [join(baseDir, 'teams', 'profile-a', 'management', 'outbox.json'), Buffer.from('outbox')],
    [join(baseDir, 'teams', 'profile-a', 'memory', 'capsule.bin'), Buffer.from([9, 8, 7])],
    [join(baseDir, 'machine-id'), Buffer.from('machine-id')],
    [join(home, 'Workspace', 'canary'), Buffer.from('workspace')],
  ]);
}

async function waitForState(client, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await readState(client);
      if (predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error('Timed out waiting for Device Service state.');
}

async function waitForPlatform(adapter, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await adapter.status();
    if (predicate(status)) return status;
    await delay(100);
  }
  throw new Error('Timed out waiting for launchd state.');
}

async function readState(client) {
  const response = await client.request({ schemaVersion: 1, requestId: `smoke-${Date.now()}`, command: 'status' }, 1_000);
  if (!response.ok) throw new Error(response.reasonCode);
  return response.state;
}

async function readBootEvents(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function assertMissing(path, message) {
  try {
    await access(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

function assertProcessAlive(pid, message) {
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(message);
  }
}

function minimalEnvironment(baseDir) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dirname(baseDir),
    AGENTBEAN_HOME: baseDir,
  };
}

function builtPath(file) {
  return join(root, 'apps', 'daemon-next', 'dist', 'apps', 'daemon-next', 'src', file);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
}

function exec(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  return { skipBuild: argv.includes('--skip-build'), keepTemp: argv.includes('--keep-temp') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runPhase5ADeviceServiceSmoke(parseArgs(process.argv.slice(2)));
  if (result.skipped) process.exitCode = 0;
}

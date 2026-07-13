#!/usr/bin/env node

import { builtinModules } from 'node:module';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PI_SEA_NODE_VERSION,
  PI_SEA_VERSION,
  createPendingPiSeaVerdict,
  writeJson,
} from './check-pi-management-sea.mjs';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const SEA_VIRTUAL_ENTRY_URL = 'file:///C:/agentbean-pi-sea/entry.cjs';
const REQUIRED_SMOKE_CHECKS = [
  'runtime-session',
  'effective-tools',
  'tool-loop',
  'prompt-event',
  'steer',
  'followup',
  'active-abort-dispose',
];
const ALLOWED_OPTIONAL_EXTERNALS = new Set(['bufferutil', 'utf-8-validate']);
const SEA_BLOB_RESOURCE = 'NODE_SEA_BLOB';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export function normalizeSeaPlatform(platform) {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  throw new Error('SEA_PLATFORM_UNSUPPORTED');
}

export function assertRunnerPlatform(os, arch, platform = hostPlatform(), runnerArch = hostArch()) {
  if (normalizeSeaPlatform(platform) !== os || runnerArch !== arch) {
    throw new Error('SEA_RUNNER_PLATFORM_MISMATCH');
  }
}

export function createSeaConfig(main, output) {
  return {
    main,
    mainFormat: 'commonjs',
    output,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgv: [],
    execArgvExtension: 'none',
  };
}

export function diagnosticCodeForStage(stage) {
  return {
    platform: 'SEA_RUNNER_PLATFORM_MISMATCH',
    'node-version': 'SEA_NODE_VERSION_MISMATCH',
    'pi-version': 'SEA_PI_VERSION_MISMATCH',
    bundle: 'SEA_BUNDLE_FAILED',
    build: 'SEA_EXECUTABLE_BUILD_FAILED',
    sign: 'SEA_CODESIGN_FAILED',
    run: 'SEA_EXECUTABLE_RUN_FAILED',
    smoke: 'SEA_SMOKE_CONTRACT_FAILED',
  }[stage] ?? 'SEA_UNKNOWN_FAILURE';
}

export function resolvePiRuntimeVersion(runtimeManifest, installedManifests) {
  const declaredVersions = [
    runtimeManifest?.dependencies?.['@earendil-works/pi-ai'],
    runtimeManifest?.dependencies?.['@earendil-works/pi-coding-agent'],
  ];
  const installedVersions = installedManifests.map((manifest) => manifest?.version);
  if ([...declaredVersions, ...installedVersions].some((version) => version !== PI_SEA_VERSION)) {
    throw new Error('SEA_PI_VERSION_MISMATCH');
  }
  return PI_SEA_VERSION;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadPiRuntimeVersion() {
  return resolvePiRuntimeVersion(
    readJson(join(rootDir, 'packages/pi-management-runtime/package.json')),
    [
      readJson(join(rootDir, 'node_modules/@earendil-works/pi-ai/package.json')),
      readJson(join(rootDir, 'node_modules/@earendil-works/pi-coding-agent/package.json')),
      readJson(join(
        rootDir,
        'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/package.json',
      )),
      readJson(join(
        rootDir,
        'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/package.json',
      )),
    ],
  );
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('SEA_ARGUMENTS_INVALID');
    values[key.slice(2)] = value;
  }
  return values;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
  if (result.error || result.status !== 0) throw new Error('SEA_PROCESS_FAILED');
  return result.stdout;
}

function seaNodeExecutable() {
  return process.env.AGENTBEAN_PI_SEA_NODE_EXECUTABLE?.trim() || process.execPath;
}

export function assertBundleIsSelfContained(result) {
  if (result.warnings.length > 0) throw new Error('SEA_BUNDLE_WARNING');
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const externalPackages = Object.values(result.metafile?.outputs ?? {})
    .flatMap((output) => output.imports ?? [])
    .filter((item) => item.external
      && !builtins.has(item.path)
      && !ALLOWED_OPTIONAL_EXTERNALS.has(item.path));
  if (externalPackages.length > 0) throw new Error('SEA_EXTERNAL_PACKAGE_REMAINED');
}

export async function bundleSeaEntry(outfile, piVersion = loadPiRuntimeVersion()) {
  const { build } = await import('esbuild');
  const result = await build({
    absWorkingDir: rootDir,
    entryPoints: ['packages/pi-management-runtime/src/sea-smoke-entry.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'bundle',
    define: {
      'import.meta.url': JSON.stringify(SEA_VIRTUAL_ENTRY_URL),
      __AGENTBEAN_PI_VERSION__: JSON.stringify(piVersion),
    },
    metafile: true,
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  assertBundleIsSelfContained(result);
}

function parseSmoke(stdout) {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error('SEA_SMOKE_OUTPUT_MISSING');
  const result = JSON.parse(line);
  if (!result || result.schemaVersion !== 1 || result.piVersion !== PI_SEA_VERSION
    || !Array.isArray(result.checks)) {
    throw new Error('SEA_SMOKE_SCHEMA_INVALID');
  }
  const checks = new Map(result.checks.map((check) => [check.id, check]));
  if (!REQUIRED_SMOKE_CHECKS.every((id) => checks.get(id)?.ok === true)) {
    throw new Error('SEA_SMOKE_CHECK_FAILED');
  }
}

function minimalRuntimeEnv(home) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
  };
}

async function buildSea({ outDir, verdictPath, os, arch }) {
  mkdirSync(dirname(verdictPath), { recursive: true });
  writeJson(verdictPath, createPendingPiSeaVerdict({ os, arch }));
  const checks = [];
  let stage = 'platform';
  try {
    assertRunnerPlatform(os, arch);
    checks.push({ id: 'runner-platform', ok: true });

    stage = 'node-version';
    if (process.versions.node !== PI_SEA_NODE_VERSION) throw new Error('SEA_NODE_VERSION_MISMATCH');
    const nodeExecutable = seaNodeExecutable();
    if (run(nodeExecutable, ['--version']).trim() !== `v${PI_SEA_NODE_VERSION}`) {
      throw new Error('SEA_NODE_VERSION_MISMATCH');
    }
    checks.push({ id: 'node-version', ok: true });

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const bundlePath = join(outDir, 'sea-smoke-entry.cjs');
    const executableName = os === 'windows' ? 'agentbean-pi-sea.exe' : 'agentbean-pi-sea';
    const executablePath = join(outDir, executableName);
    const blobPath = join(outDir, 'sea-preparation.blob');

    stage = 'pi-version';
    const piVersion = loadPiRuntimeVersion();
    checks.push({ id: 'pi-version', ok: true });

    stage = 'bundle';
    await bundleSeaEntry(bundlePath, piVersion);
    checks.push({ id: 'bundle', ok: true });

    stage = 'build';
    const configPath = join(outDir, 'sea-config.json');
    writeFileSync(configPath, `${JSON.stringify(createSeaConfig(bundlePath, blobPath), null, 2)}\n`);
    run(nodeExecutable, ['--experimental-sea-config', configPath], { cwd: rootDir });
    copyFileSync(nodeExecutable, executablePath);
    if (os !== 'windows') chmodSync(executablePath, 0o755);
    if (os === 'macos') {
      run('codesign', ['--remove-signature', executablePath]);
    }
    const postjectCli = join(rootDir, 'node_modules/postject/dist/cli.js');
    run(process.execPath, [
      postjectCli,
      executablePath,
      SEA_BLOB_RESOURCE,
      blobPath,
      '--sentinel-fuse',
      SEA_FUSE,
      '--macho-segment-name',
      'NODE_SEA',
    ], { cwd: rootDir });
    checks.push({ id: 'executable-build', ok: true });

    stage = 'sign';
    if (os === 'macos') {
      run('codesign', ['--sign', '-', '--force', executablePath]);
      run('codesign', ['--verify', executablePath]);
    }
    checks.push({ id: 'platform-signature', ok: true });

    stage = 'run';
    const cleanRunDir = join(outDir, 'clean-run');
    mkdirSync(cleanRunDir, { recursive: true });
    const cleanExecutable = join(cleanRunDir, basename(executablePath));
    copyFileSync(executablePath, cleanExecutable);
    if (os !== 'windows') chmodSync(cleanExecutable, 0o755);
    const stdout = run(cleanExecutable, [], {
      cwd: cleanRunDir,
      env: minimalRuntimeEnv(cleanRunDir),
    });
    checks.push({ id: 'executable-run', ok: true });

    stage = 'smoke';
    parseSmoke(stdout);
    checks.push({ id: 'sea-smoke', ok: true });
    writeJson(verdictPath, {
      schemaVersion: 1,
      os,
      arch,
      nodeVersion: PI_SEA_NODE_VERSION,
      piVersion: PI_SEA_VERSION,
      status: 'compatible',
      checks,
    });
    return 0;
  } catch {
    checks.push({ id: stage, ok: false, diagnosticCode: diagnosticCodeForStage(stage) });
    writeJson(verdictPath, {
      schemaVersion: 1,
      os,
      arch,
      nodeVersion: PI_SEA_NODE_VERSION,
      piVersion: PI_SEA_VERSION,
      status: 'blocked-for-phase5',
      checks,
    });
    console.error(diagnosticCodeForStage(stage));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const os = args.os ?? normalizeSeaPlatform(hostPlatform());
    const arch = args.arch ?? hostArch();
    if (!args['out-dir'] || !args.verdict) throw new Error('SEA_ARGUMENTS_INVALID');
    process.exitCode = await buildSea({
      outDir: resolve(args['out-dir']),
      verdictPath: resolve(args.verdict),
      os,
      arch,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'SEA_BUILD_FAILED');
    process.exitCode = 1;
  }
}

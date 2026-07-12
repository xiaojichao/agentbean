#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createAgentBeanNextDaemonReleasePackage } from './prepare-agentbean-next-daemon-release.mjs';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function runAgentBeanNextDaemonInstallSmoke({
  root = rootDir,
  keepTemp = false,
  skipBuild = false,
  log = console.log,
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'agentbean-next-daemon-install-'));
  try {
    if (!skipBuild) {
      run('npm', ['run', 'build:contracts'], { cwd: root });
      run('npm', ['run', 'build:pi-management-runtime'], { cwd: root });
      run('npm', ['run', 'build:daemon-next'], { cwd: root });
    }

    const packagesDir = join(tempDir, 'packages');
    const installDir = join(tempDir, 'install');
    const canonicalReleaseDir = join(tempDir, 'canonical-daemon');
    mkdirSync(packagesDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });

    createAgentBeanNextDaemonReleasePackage({
      root,
      outDir: canonicalReleaseDir,
    });

    const contractsTarball = packPackage(join(root, 'packages/contracts'), packagesDir);
    const runtimeTarball = packPackage(
      join(root, 'packages/pi-management-runtime'),
      packagesDir,
      ['dist/index.js', 'dist/index.d.ts'],
    );
    const daemonTarball = packPackage(canonicalReleaseDir, packagesDir);

    writeFileSync(
      join(installDir, 'package.json'),
      `${JSON.stringify({ name: 'agentbean-next-daemon-install-smoke', private: true }, null, 2)}\n`,
    );
    run('npm', ['install', '--ignore-scripts', contractsTarball, runtimeTarball, daemonTarball], { cwd: installDir });

    const packageJson = readJson(join(installDir, 'node_modules/@agentbean/daemon/package.json'));
    if (packageJson.name !== '@agentbean/daemon') {
      throw new Error(`Expected installed package name @agentbean/daemon, got ${packageJson.name}`);
    }
    if (packageJson.version !== readJson(join(root, 'apps/daemon-next/package.json')).version) {
      throw new Error(`Installed @agentbean/daemon version ${packageJson.version} does not match daemon-next version`);
    }
    const expectedRuntimeVersion = readJson(join(root, 'packages/pi-management-runtime/package.json')).version;
    if (packageJson.dependencies?.['@agentbean/pi-management-runtime'] !== expectedRuntimeVersion) {
      throw new Error('Canonical daemon must depend on the exact PI management runtime version');
    }
    const runtimePackageJson = readJson(
      join(installDir, 'node_modules/@agentbean/pi-management-runtime/package.json'),
    );
    if (runtimePackageJson.version !== expectedRuntimeVersion) {
      throw new Error(`Installed PI management runtime ${runtimePackageJson.version} does not match ${expectedRuntimeVersion}`);
    }
    run(process.execPath, [
      '--input-type=module',
      '--eval',
      "const runtime = await import('@agentbean/pi-management-runtime'); if (typeof runtime.createManagementRuntimeFactory !== 'function' || runtime.PHASE_1_MANAGEMENT_TOOL_NAMES?.length !== 11) process.exit(1);",
    ], { cwd: installDir });

    const expectedBins = ['daemon', 'agentbean-daemon', 'agentbean-next-daemon'];
    for (const binName of expectedBins) {
      assertBinRequiresTeamId(join(installDir, 'node_modules/.bin', binName), binName);
    }

    log(`AgentBean Next daemon install smoke passed in ${installDir}`);
    return {
      tempDir,
      installDir,
      contractsTarball,
      runtimeTarball,
      daemonTarball,
      packageJson,
      runtimePackageJson,
      bins: expectedBins,
    };
  } finally {
    if (!keepTemp) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function packPackage(packageDir, destination, requiredFiles = []) {
  const output = run('npm', ['pack', '--json', '--pack-destination', destination, packageDir], {
    cwd: packageDir,
  });
  const [packResult] = JSON.parse(output);
  if (!packResult?.filename) {
    throw new Error(`npm pack did not return a filename for ${packageDir}`);
  }
  const packedFiles = new Set((packResult.files ?? []).map((file) => file.path));
  for (const requiredFile of requiredFiles) {
    if (!packedFiles.has(requiredFile)) {
      throw new Error(`npm pack for ${packageDir} is missing ${requiredFile}`);
    }
  }
  return join(destination, packResult.filename);
}

function assertBinRequiresTeamId(binPath, binName) {
  const result = spawnSync(binPath, [], {
    env: {
      ...process.env,
      AGENTBEAN_NEXT_OWNER_ID: 'owner-smoke',
    },
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 1 || !output.includes('AGENTBEAN_NEXT_TEAM_ID or --team-id is required')) {
    throw new Error(
      `Expected ${binName} to reach daemon-next CLI config validation, got status ${result.status}: ${output}`,
    );
  }
}

function run(command, args, { cwd }) {
  return execFileSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  return {
    keepTemp: argv.includes('--keep-temp'),
    skipBuild: argv.includes('--skip-build'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = runAgentBeanNextDaemonInstallSmoke(args);
  if (args.keepTemp) {
    console.log(`Kept smoke temp dir at ${result.tempDir}`);
  }
}

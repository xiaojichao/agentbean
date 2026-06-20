#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function createAgentBeanNextDaemonReleasePackage({
  root = rootDir,
  outDir,
  packageName = '@agentbean/daemon',
} = {}) {
  if (!outDir) {
    throw new Error('--out is required');
  }
  const daemonNextPackage = readJson(join(root, 'apps/daemon-next/package.json'));
  const contractsPackage = readJson(join(root, 'packages/contracts/package.json'));
  const outputDir = resolve(root, outDir);
  const distSource = join(root, 'apps/daemon-next/dist');
  const distTarget = join(outputDir, 'dist');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(distSource, distTarget, { recursive: true });

  const releasePackage = {
    name: packageName,
    version: daemonNextPackage.version,
    private: false,
    type: 'module',
    main: daemonNextPackage.main,
    types: daemonNextPackage.types,
    bin: {
      daemon: daemonNextPackage.bin['agentbean-next-daemon'],
      'agentbean-daemon': daemonNextPackage.bin['agentbean-next-daemon'],
      'agentbean-next-daemon': daemonNextPackage.bin['agentbean-next-daemon'],
    },
    exports: daemonNextPackage.exports,
    files: daemonNextPackage.files,
    dependencies: {
      '@agentbean/contracts': contractsPackage.version,
      'js-yaml': daemonNextPackage.dependencies['js-yaml'],
      'socket.io-client': daemonNextPackage.dependencies['socket.io-client'],
    },
  };
  writeFileSync(join(outputDir, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`);
  return { outDir: outputDir, packageJson: releasePackage };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = createAgentBeanNextDaemonReleasePackage({
    outDir: args.out,
    packageName: args.name ?? '@agentbean/daemon',
  });
  console.log(`Created ${result.packageJson.name}@${result.packageJson.version} at ${result.outDir}`);
}

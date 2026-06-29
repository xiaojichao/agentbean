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

  // dependencies / optionalDependencies 整体透传自 daemon-next，避免手工列举遗漏字段。
  // 历史 bug：手工列举 dependencies 曾完全漏掉 optionalDependencies.node-pty，导致 canonical
  // @agentbean/daemon 发布包不含 node-pty 声明，npx 安装的用户运行 codex（executor-pty.ts
  // 懒加载 node-pty 的唯一 PTY agent）时报 Cannot find module 'node-pty'。
  // @agentbean/contracts 版本对齐同时发布的 contracts 包（放在 spread 之后覆盖源字面量）。
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
      ...daemonNextPackage.dependencies,
      '@agentbean/contracts': contractsPackage.version,
    },
    ...(daemonNextPackage.optionalDependencies
      ? { optionalDependencies: { ...daemonNextPackage.optionalDependencies } }
      : {}),
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

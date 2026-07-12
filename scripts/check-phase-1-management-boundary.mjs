#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--workspace-root');
const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? '' : defaultRoot);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  } catch {
    return null;
  }
}

const runtime = readJson('packages/pi-management-runtime/package.json');
const daemon = readJson('apps/daemon-next/package.json');
const runtimeTypesPath = resolve(root, 'packages/pi-management-runtime/src/types.ts');
const runtimeTypes = existsSync(runtimeTypesPath) ? readFileSync(runtimeTypesPath, 'utf8') : '';
const violations = [];

if (!runtime
  || runtime.private !== false
  || !runtime.version
  || runtime.version === '0.0.0'
  || !runtime.files?.includes('dist/**/*.js')
  || !runtime.files?.includes('dist/index.d.ts')
  || !runtime.files?.includes('dist/types.d.ts')
  || runtime.scripts?.prepublishOnly !== 'npm run build'
  || runtime.dependencies?.['@earendil-works/pi-ai'] !== '0.80.6'
  || runtime.dependencies?.['@earendil-works/pi-coding-agent'] !== '0.80.6'
  || !runtimeTypes.includes('PHASE_1_MANAGEMENT_TOOL_NAMES')
  || !runtimeTypes.includes('ManagementSessionContextV1')) {
  violations.push('P1_RUNTIME_PACKAGE_INVALID: PI management runtime publish/tool/context contract is incomplete');
}

if (!daemon || daemon.dependencies?.['@agentbean/pi-management-runtime'] !== runtime?.version) {
  violations.push('P1_DAEMON_RUNTIME_VERSION: daemon-next must use the exact PI management runtime version');
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`P1_RUNTIME_PACKAGE_READY: @agentbean/pi-management-runtime@${runtime.version}`);

const futureBoundaries = [
  'packages/contracts/src/management-worker.ts',
  'apps/server-next/src/infra/sqlite/migrations/team/0010_management_phase_1.sql',
  'apps/server-next/src/application/management/management-kernel.ts',
  'apps/daemon-next/src/pi-manager-worker-host.ts',
];
const missing = futureBoundaries.filter((path) => !existsSync(resolve(root, path)));
if (missing.length > 0) {
  console.error(missing.map((path) => `P1_NOT_IMPLEMENTED: ${path}`).join('\n'));
  process.exit(2);
}

console.log('Phase 1 management boundary check passed.');

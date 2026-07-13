#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--workspace-root');
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? '' : fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : '';
const violations = [];

const matrix = read('agentbean-next/docs/phase-2-task-dag-team-claim-verification-matrix.md');
const contract = read('packages/contracts/src/management-worker-v2.ts');
const management = read('packages/contracts/src/management.ts');
const runtimeTypes = read('packages/pi-management-runtime/src/types.ts');
const runtimeAdapter = read('packages/pi-management-runtime/src/pi-session-adapter.ts');
const packageJson = JSON.parse(read('package.json') || '{}');
const workflow = read('.github/workflows/ci-cd.yml');

if (![...Array(18)].every((_, index) => matrix.includes(`| P2-${String(index + 1).padStart(2, '0')} |`))
  || !matrix.includes('当前 verdict：**Not ready**')) {
  violations.push('P2_MATRIX_INVALID: P2-01..P2-18 and fail-closed verdict are required');
}

const contractMarkers = [
  'ManagementRunV2Dto', 'TeamManagementPolicyV2Dto', 'maxManagementPhase', 'managementPhase',
  'ManagementWorkerRegisterV2', 'ManagementWorkerSessionContextV2',
  'PHASE_2_MANAGEMENT_WORKER_TOOL_NAMES', 'Phase2TaskToolRequestV2',
  'parseManagementWorkerRegisterV2', 'parseManagementWorkerSessionContextV2',
  'parsePhase2TaskToolRequestV2',
];
if (!contractMarkers.slice(4).every((marker) => contract.includes(marker))
  || !contractMarkers.slice(0, 4).every((marker) => management.includes(marker))) {
  violations.push('P2_CONTRACT_SURFACE_INVALID: V2 Run, policy, Worker, Session, and Task tool contracts are incomplete');
}

const taskTools = [
  'tasks.create_subtasks', 'tasks.add_dependency', 'tasks.publish_for_claim', 'tasks.assign',
  'tasks.wait', 'tasks.retry', 'tasks.accept_subtask', 'tasks.report_blocked',
];
if (!runtimeTypes.includes('PHASE_2_MANAGEMENT_TOOL_NAMES')
  || !runtimeTypes.includes('ManagementSessionContextV2')
  || !taskTools.every((tool) => runtimeTypes.includes(tool))
  || !runtimeAdapter.includes('input.context.schemaVersion === 2')
  || runtimeTypes.match(/PHASE_2_MANAGEMENT_TOOL_NAMES[\s\S]*?memory\.search/)) {
  violations.push('P2_RUNTIME_BOUNDARY_INVALID: Phase 2 exact runtime tool boundary is incomplete or exposes Memory');
}

const scripts = packageJson.scripts ?? {};
if (scripts['test:phase2-task-dag-boundary'] !== 'node --test scripts/check-phase-2-task-dag-boundary.test.mjs'
  || scripts['check:phase2-task-dag-boundary'] !== 'node scripts/check-phase-2-task-dag-boundary.mjs'
  || !String(scripts['test:phase2-task-dag']).includes('test:phase2-task-dag-boundary')
  || !workflow.includes('npm run test:phase2-task-dag')
  || !workflow.includes('npm run build:phase2-task-dag')
  || !workflow.includes('check-phase-2-task-dag-boundary')) {
  violations.push('P2_ROOT_CI_GATE_INVALID: Phase 2 root scripts and ordered CI gates are required');
}

if (packageJson.engines?.node !== '24.x' || read('.nvmrc').trim() !== 'v24.18.0') {
  violations.push('P2_NODE_VERSION_INVALID: Phase 2 must use Node 24.18.0');
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log('P2_BOUNDARY_READY: matrix, V2 contracts, Phase 2 exact tools, Node 24, and root CI gates are present');

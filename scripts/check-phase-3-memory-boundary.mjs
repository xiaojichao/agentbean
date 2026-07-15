#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--workspace-root');
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? '' : fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : '';
const violations = [];

const matrix = read('agentbean-next/docs/phase-3-cross-agent-memory-verification-matrix.md');
const plan = read('docs/superpowers/plans/2026-07-15-agentbean-phase-3-cross-agent-memory.md');
const contracts = read('packages/contracts/src/management-memory.ts');
const domain = read('packages/domain/src/memory-policy.ts');
const runtimeTypes = read('packages/pi-management-runtime/src/types.ts');
const packageJson = JSON.parse(read('package.json') || '{}');
const workflow = read('.github/workflows/ci-cd.yml');

const hasChecklist = [...Array(18)].every((_, index) =>
  matrix.includes(`| P3-${String(index + 1).padStart(2, '0')} |`));
if (!hasChecklist
  || !/^> 当前 verdict：\*\*Not ready\*\*/m.test(matrix)
  || !matrix.includes('Phase 3 runtime 必须保持关闭')
  || !plan.includes('Phase 3 未完成前')) {
  violations.push('P3_MATRIX_INVALID: P3-01..P3-18, Not ready, and fail-closed rollout are required');
}

const contractMarkers = [
  'MemoryRecordDto', 'MemoryScopeType', 'LocalMemoryScopeType', "'task'",
  'MemoryCapsuleDto', 'MemoryCapsuleAuthorizationDto', 'sourceRefsHash', 'contentHash',
  'MemoryCandidateDto', 'sourceInvocationId', 'projectionHash',
];
const serverMemoryScopes = contracts.match(/export const MEMORY_SCOPE_TYPES\s*=\s*\[([^\]]*)\]/s)?.[1] ?? '';
const hasDeviceLocalServerScope = ['local-workspace', 'local-agent', 'local-profile']
  .some((scope) => new RegExp(`['"]${scope}['"]`).test(serverMemoryScopes));
if (!contractMarkers.every((marker) => contracts.includes(marker))
  || hasDeviceLocalServerScope) {
  violations.push('P3_CONTRACT_BOUNDARY_INVALID: server/local scopes, Capsule authorization, and Candidate contracts are required');
}

const domainMarkers = [
  'evaluateMemoryInjection', 'MEMORY_SCOPE_NOT_VISIBLE', 'MEMORY_SOURCE_UNAVAILABLE',
  'evaluateMemoryCapsuleAuthorization', 'CAPSULE_TARGET_MISMATCH', 'CAPSULE_POLICY_VERSION_STALE',
  'CAPSULE_AUTHORIZATION_NOT_YET_VALID', 'CAPSULE_EXPLICIT_GRANT_REQUIRED',
  'CAPSULE_GRANT_REVOKED', 'CAPSULE_LOCAL_ONLY_SERVER_FORBIDDEN',
];
if (!domainMarkers.every((marker) => domain.includes(marker))) {
  violations.push('P3_DOMAIN_POLICY_INVALID: injection and Capsule authorization must fail closed');
}

const phase1Tools = runtimeTypes.match(
  /export const PHASE_1_MANAGEMENT_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s+as const/,
)?.[1] ?? '';
const phase2Tools = runtimeTypes.match(
  /export const PHASE_2_MANAGEMENT_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s+as const/,
)?.[1] ?? '';
if (/['"]memory\.[^'"]+['"]/.test(`${phase1Tools}\n${phase2Tools}`)) {
  violations.push('P3_PHASE2_ISOLATION_INVALID: Phase 2 exact tool surface must not expose Memory');
}

const scripts = packageJson.scripts ?? {};
if (scripts['test:phase3-memory-boundary'] !== 'node --test scripts/check-phase-3-memory-boundary.test.mjs'
  || scripts['check:phase3-memory-boundary'] !== 'node scripts/check-phase-3-memory-boundary.mjs'
  || !String(scripts['test:phase3-memory']).includes('test:contracts')
  || !String(scripts['test:phase3-memory']).includes('test:domain')
  || !String(scripts['build:phase3-memory']).includes('build:contracts')
  || !String(scripts['build:phase3-memory']).includes('build:domain')
  || !String(scripts['test:retained-boundaries']).includes('test:phase3-memory-boundary')
  || !String(scripts['test:retained-boundaries']).includes('check:phase3-memory-boundary')
  || !workflow.includes('npm run test:ci')
  || !workflow.includes('check-phase-3-memory-boundary')) {
  violations.push('P3_ROOT_CI_GATE_INVALID: Phase 3 root scripts and retained CI boundary are required');
}

if (packageJson.engines?.node !== '24.x' || read('.nvmrc').trim() !== 'v24.18.0') {
  violations.push('P3_NODE_VERSION_INVALID: Phase 3 must use Node 24.18.0');
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log('P3_MEMORY_BOUNDARY_READY: contracts, Domain policies, Phase 2 isolation, Node 24, and CI gates are present');

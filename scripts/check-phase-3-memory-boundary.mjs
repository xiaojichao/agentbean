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
const memoryRepositories = read('apps/server-next/src/application/memory-repositories.ts');
const memoryUnitOfWork = read('apps/server-next/src/application/memory-unit-of-work.ts');
const memoryMigration = read('apps/server-next/src/infra/sqlite/migrations/team/0015_management_phase_3_memory.sql');
const capsuleRefMigration = read('apps/server-next/src/infra/sqlite/migrations/team/0016_management_phase_3_capsule_refs.sql');
const sqliteRepositories = read('apps/server-next/src/infra/sqlite/repositories.ts');
const memoryBackends = [
  read('apps/server-next/src/infra/memory/memory-repositories.ts'),
  read('apps/server-next/src/infra/sqlite/memory-repositories.ts'),
];
const memoryPersistenceTests = read('apps/server-next/tests/memory-unit-of-work.test.ts');
const collaborativeMemoryService = read('apps/server-next/src/application/collaborative-memory-service.ts');
const collaborativeMemoryTests = read('apps/server-next/tests/collaborative-memory-service.test.ts');
const memorySourceInvalidationService = read('apps/server-next/src/application/memory-source-invalidation-service.ts');
const memorySourceInvalidationTests = read('apps/server-next/tests/memory-source-invalidation-service.test.ts');
const serverNextUsecases = read('apps/server-next/src/application/usecases.ts');
const memoryCapsuleService = read('apps/server-next/src/application/memory-capsule-service.ts');
const memoryCapsuleTests = read('apps/server-next/tests/memory-capsule-service.test.ts');
const capsuleInjectionValidator = read('apps/server-next/src/application/capsule-injection-validator.ts');
const capsuleInjectionTests = read('apps/server-next/tests/capsule-injection-validator.test.ts');
const domainMemoryHashing = read('packages/domain/src/memory-hashing.ts');
const memoryCandidateService = read('apps/server-next/src/application/memory-candidate-service.ts');
const memoryCandidateTests = read('apps/server-next/tests/memory-candidate-service.test.ts');
const memoryCandidatePolicy = read('packages/domain/src/memory-candidate-policy.ts');
const memoryCandidateMigration = read('apps/server-next/src/infra/sqlite/migrations/team/0017_management_phase_3_candidates.sql');
const runtimeTypes = read('packages/pi-management-runtime/src/types.ts');
const packageJson = JSON.parse(read('package.json') || '{}');
const workflow = read('.github/workflows/ci-cd.yml');

const hasChecklist = [...Array(18)].every((_, index) =>
  matrix.includes(`| P3-${String(index + 1).padStart(2, '0')} |`));
if (!hasChecklist
  || !/^> 当前 verdict：\*\*Not ready\*\*/m.test(matrix)
  || !matrix.includes('| P3-03 | Green |')
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

const persistenceMarkers = [
  'memory_items', 'memory_sources', 'snapshot_hash', 'memory_tags',
  'memory_grants', 'memory_audit_events', 'DEFERRABLE INITIALLY DEFERRED',
];
const repositoryMarkers = [
  'MemoryRepositories', 'MemoryItemRecord', 'MemorySourceRecord',
  'MemoryGrantRecord', 'MemoryAuditEventRecord',
];
const memoryItemSchema = memoryMigration.match(
  /CREATE TABLE memory_items[\s\S]*?CREATE TABLE memory_sources/,
)?.[0] ?? '';
if (!persistenceMarkers.every((marker) => memoryMigration.includes(marker))
  || memoryItemSchema.includes('local-workspace')
  || !repositoryMarkers.every((marker) => memoryRepositories.includes(marker))
  || !memoryUnitOfWork.includes('MemoryUnitOfWork')
  || !memoryBackends.every((backend) => backend.includes('assertMemorySourceRecord')
    && backend.includes('assertMemoryGrantTransition'))
  || !memoryPersistenceTests.includes('rolls back every Memory table')
  || !memoryPersistenceTests.includes('rolls back all Memory schema')) {
  violations.push('P3_PERSISTENCE_BOUNDARY_INVALID: Team-isolated Memory schema, repositories, and rollback evidence are required');
}

const capsuleRefMigrationMarkers = ['memory_capsule_refs', 'expires_at > issued_at', 'denied_at'];
if (!capsuleRefMigrationMarkers.every((marker) => capsuleRefMigration.includes(marker))
  || !sqliteRepositories.includes("'team/0016_management_phase_3_capsule_refs.sql'")
  || !memoryRepositories.includes('MemoryCapsuleRefRecord')
  || !memoryRepositories.includes('capsuleRefs')
  || !memoryPersistenceTests.includes('Capsule refs with Team isolation')) {
  violations.push('P3_CAPSULE_REF_PERSISTENCE_INVALID: Team-isolated Capsule ref schema (0016), repository, static migration registration and parity tests are required');
}

const usecaseMarkers = [
  'createCollaborativeMemoryService', 'MemoryPermissions', 'createMemory',
  'updateMemory', 'supersedeMemory', 'deleteMemory', 'issueGrant', 'revokeGrant',
];
if (!usecaseMarkers.every((marker) => collaborativeMemoryService.includes(marker))
  || !collaborativeMemoryTests.includes('describe.each')
  || !collaborativeMemoryTests.includes('createInMemoryRepositories')
  || !collaborativeMemoryTests.includes('createSqliteRepositories')
  || !collaborativeMemoryTests.includes('MEMORY_INVALID_TRANSITION')
  || !collaborativeMemoryTests.includes('MEMORY_DUPLICATE_CONTENT')
  || !collaborativeMemoryService.includes('MEMORY_GRANT_INVALID_EXPIRY')
  || !collaborativeMemoryTests.includes('MEMORY_GRANT_INVALID_EXPIRY')) {
  violations.push('P3_COLLABORATIVE_MEMORY_USECASE_INVALID: collaborative Memory service with status machine, grants, dedup and dual-backend parity tests are required');
}

const invalidationMarkers = [
  'createMemorySourceInvalidationService', 'invalidateSources', 'isSourceAvailable',
  'memory-expired', 'ACTOR_SYSTEM',
];
if (!invalidationMarkers.every((marker) => memorySourceInvalidationService.includes(marker))
  || !memorySourceInvalidationTests.includes('describe.each')
  || !memorySourceInvalidationTests.includes('createSqliteRepositories')
  || !memorySourceInvalidationTests.includes('fails closed across Team boundaries')
  // 删除路径必须 best-effort 触发来源失效，且不得阻塞删除主路径。
  || !serverNextUsecases.includes('invalidateSourcesAfterDeletion')
  || !serverNextUsecases.includes('messages.listByChannel')
  || !serverNextUsecases.includes("sourceKind: 'message'")
  || !serverNextUsecases.includes("sourceKind: 'task'")
  || !serverNextUsecases.includes("sourceKind === 'artifact'")
  || !serverNextUsecases.includes("sourceKind === 'workspace-run'")
  || !serverNextUsecases.includes("sourceKind === 'invocation'")
  || !serverNextUsecases.includes("['artifact', deletedArtifactIds]")
  || !serverNextUsecases.includes("['workspace-run', deletedWorkspaceRunIds]")
  || !serverNextUsecases.includes("['invocation', deletedInvocationIds]")
  || !memorySourceInvalidationTests.includes('invalidates artifact, workspace-run, and invocation sources')
  || !memorySourceInvalidationTests.includes('invalidates invocation sources bound to a deleted task')) {
  violations.push('P3_SOURCE_INVALIDATION_INVALID: reactive Memory source invalidation on deletion with dual-backend parity tests is required');
}

const capsuleMarkers = [
  'createMemoryCapsuleService', 'createCapsule', "mode: 'scope-policy'",
  'capsule-created', 'currentPolicyVersion', 'MemoryCapsuleAuthorizationDto',
];
if (!capsuleMarkers.every((marker) => memoryCapsuleService.includes(marker))
  || !memoryCapsuleTests.includes('describe.each')
  || !memoryCapsuleTests.includes('createSqliteRepositories')
  || !memoryCapsuleTests.includes('scope-policy')) {
  violations.push('P3_CAPSULE_CREATION_INVALID: minimal Capsule creation with scope-policy authorization, frozen hashes and dual-backend parity tests are required');
}

const injectionMarkers = [
  'createCapsuleInjectionValidator', 'validateCapsuleForInjection',
  'evaluateMemoryInjection', 'evaluateMemoryCapsuleAuthorization', 'CAPSULE_EXPLICIT_GRANT_REQUIRED',
];
// hash 必须共享 domain 单一源：creation 与复验跨包复制必漂移。
const hashSharedFromDomain = domainMemoryHashing.includes('export function hashMemoryContent')
  && domainMemoryHashing.includes('export function hashSourceRefs')
  && memoryCapsuleService.includes('hashMemoryContent, hashSourceRefs')
  && !memoryCapsuleService.includes('function hashMemoryContent');
if (!injectionMarkers.every((marker) => capsuleInjectionValidator.includes(marker))
  || !hashSharedFromDomain
  || !capsuleInjectionTests.includes('describe.each')
  || !capsuleInjectionTests.includes('createSqliteRepositories')
  || !capsuleInjectionTests.includes('CAPSULE_CONTENT_HASH_MISMATCH')
  || !capsuleInjectionTests.includes('CAPSULE_POLICY_VERSION_STALE')) {
  violations.push('P3_CAPSULE_INJECTION_INVALID: two-check Capsule injection revalidation with shared domain hashing and dual-backend parity tests is required');
}

const candidateServiceMarkers = [
  'createMemoryCandidateService', 'proposeCandidate', 'acceptCandidate',
  'rejectCandidate', 'mergeCandidate', 'MemoryCandidatePermissions',
  'assertDecideAuthority', 'detectConflicts',
];
const candidatePolicyMarkers = ['evaluateCandidateTransition', 'CANDIDATE_INVALID_TRANSITION'];
// projectionHash 必须复用 domain hash 单一源（接 P3-07），service 不得自写一份。
const candidateHashSharedFromDomain = domainMemoryHashing.includes('export function computeProjectionHash')
  && memoryCandidateService.includes('computeProjectionHash')
  && !memoryCandidateService.includes('function computeProjectionHash');
if (!candidateServiceMarkers.every((marker) => memoryCandidateService.includes(marker))
  || !candidatePolicyMarkers.every((marker) => memoryCandidatePolicy.includes(marker))
  || !candidateHashSharedFromDomain
  || !memoryCandidateMigration.includes('memory_candidates')
  || !memoryCandidateMigration.includes('projection_hash')
  || !memoryRepositories.includes('candidates')
  || !memoryBackends.every((backend) => backend.includes('assertMemoryCandidateRecord'))
  || !memoryCandidateTests.includes('describe.each')
  || !memoryCandidateTests.includes('createSqliteRepositories')
  || !memoryCandidateTests.includes('CANDIDATE_NOT_FOUND')
  || !memoryCandidateTests.includes('CANDIDATE_HAS_CONFLICT')) {
  violations.push('P3_CANDIDATE_LIFECYCLE_INVALID: Memory Candidate lifecycle (state machine, projection-hash dedup via shared domain hashing, source conflict, dual-backend assert parity, fail-closed decide boundary) with parity tests is required');
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
  || !String(scripts['test:phase3-memory']).includes('test:phase3-memory-persistence')
  || !String(scripts['test:phase3-memory-persistence']).includes('memory-unit-of-work.test.ts')
  || !String(scripts['test:phase3-memory-persistence']).includes('memory-candidate-repositories.test.ts')
  || !String(scripts['test:phase3-memory-persistence']).includes('memory-candidate-service.test.ts')
  || !String(scripts['build:phase3-memory']).includes('build:contracts')
  || !String(scripts['build:phase3-memory']).includes('build:domain')
  || !String(scripts['build:phase3-memory']).includes('build:server-next')
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

console.log('P3_MEMORY_BOUNDARY_READY: contracts, Domain policies, persistence, Phase 2 isolation, Node 24, and CI gates are present');

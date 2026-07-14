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
const domainPolicies = [
  read('packages/domain/src/task-dag-policy.ts'),
  read('packages/domain/src/task-revision-policy.ts'),
  read('packages/domain/src/task-claim-policy.ts'),
  read('packages/domain/src/subtask-acceptance-policy.ts'),
];
const taskCoordinationMigration = read('apps/server-next/src/infra/sqlite/migrations/team/0013_management_phase_2_task_dag.sql');
const taskCoordinationRepositories = [
  read('apps/server-next/src/infra/memory/task-coordination-repositories.ts'),
  read('apps/server-next/src/infra/sqlite/task-coordination-repositories.ts'),
];
const taskCoordinationUnitOfWork = read('apps/server-next/src/application/task-coordination-unit-of-work.ts');
const taskCoordinationTests = read('apps/server-next/tests/task-coordination-unit-of-work.test.ts');
const taskCoordinationKernel = read('apps/server-next/src/application/management/task-coordination-kernel.ts');
const taskCoordinationKernelTests = read('apps/server-next/tests/task-coordination-kernel.test.ts');
const managementEventValidator = read('apps/server-next/src/application/management/management-event-validator.ts');
const rolloutMigration = read('apps/server-next/src/infra/sqlite/migrations/team/0014_management_phase_2_rollout.sql');
const managementRouter = read('apps/server-next/src/application/management/management-router.ts');
const taskDagContracts = read('packages/contracts/src/task-coordination.ts');
const taskDagPanel = read('apps/web-next/components/TaskDagPanel.tsx');
const taskDagRevisionGuard = read('apps/web-next/lib/task-dag.ts');
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

const domainMarkers = [
  'evaluateTaskDag',
  'evaluateTaskRevisionChange',
  'evaluateTaskClaimAcquire',
  'evaluateSubtaskAcceptance',
];
if (!domainPolicies.every((policy, index) => policy.includes(domainMarkers[index]))) {
  violations.push('P2_DOMAIN_POLICY_INVALID: DAG, revision, claim, and acceptance policies are required');
}

const persistenceMarkers = [
  'ALTER TABLE tasks', 'ADD COLUMN revision', 'task_coordinations',
  'task_acceptance_criteria', 'task_dependencies', 'task_claim_leases',
  'one_active_task_claim_per_attempt', 'lease_token_hash', 'lease_fingerprint',
  'evidence_snapshots', 'subtask_deliveries', 'subtask_acceptances',
  'one_canonical_acceptance_per_delivery', 'DEFERRABLE INITIALLY DEFERRED',
];
if (!persistenceMarkers.every((marker) => taskCoordinationMigration.includes(marker))
  || !taskCoordinationRepositories.every((repository) =>
    repository.includes('TaskCoordinationRepositories')
      && repository.includes('evidence ref has no canonical snapshot in delivery authority'))
  || !taskCoordinationUnitOfWork.includes('TaskCoordinationUnitOfWork')
  || !taskCoordinationTests.includes('rolls back Task and coordination revision together')
  || !taskCoordinationTests.includes('rolls back schema when the 0013 migration ledger write fails')) {
  violations.push('P2_PERSISTENCE_BOUNDARY_INVALID: Phase 2 schema, repositories, atomic UoW, and rollback evidence are required');
}

const coordinationCommandMarkers = [
  'createRootCoordination', 'createSubtasks', 'addDependency', 'reviseTask',
  'invalidateClaim', 'publishForClaim', 'assignTask', 'transitionTaskState',
];
const coordinationTestMarkers = [
  'idempotent typed events',
  'rejects a cycle atomically',
  'invalidates current claim plus matching Invocation in one transaction',
  'rolls back an over-budget batch and a failed Event append',
];
if (!coordinationCommandMarkers.every((marker) => taskCoordinationKernel.includes(marker))
  || !taskCoordinationKernel.includes('evaluateTaskDag')
  || !taskCoordinationKernel.includes('evaluateTaskRevisionChange')
  || !taskCoordinationKernel.includes('appendValidatedManagementEventInTransaction')
  || !managementEventValidator.includes('parseTaskCoordinationManagementEvent')
  || !managementEventValidator.includes('hashManagementCommandInput')
  || !coordinationTestMarkers.every((marker) => taskCoordinationKernelTests.includes(marker))) {
  violations.push('P2_COORDINATION_KERNEL_BOUNDARY_INVALID: Task coordination commands, Domain policies, exact Events, and rollback evidence are required');
}

const rolloutMarkers = [
  'max_management_phase', 'management_phase',
  'preflightPhase2', 'MANAGEMENT_PHASE_2_ROOT_TASK_REQUIRED', 'allowDirectFallbackBeforeBarrier: false',
  'TaskDagViewDto', 'TaskDagPanel', 'acceptTaskDagSnapshot',
];
if (!rolloutMarkers.slice(0, 2).every((marker) => rolloutMigration.includes(marker))
  || !rolloutMarkers.slice(2, 4).every((marker) => managementRouter.includes(marker))
  || !/requestShape: 'multi-agent',[\s\S]*?allowDirectFallbackBeforeBarrier: false/.test(managementRouter)
  || !taskDagContracts.includes(rolloutMarkers[5])
  || !taskDagPanel.includes(rolloutMarkers[6])
  || !taskDagRevisionGuard.includes(rolloutMarkers[7])) {
  violations.push('P2_ROLLOUT_WEB_BOUNDARY_INVALID: Phase 2 rollout policy, fail-closed preflight, DAG contract, Web surface, and revision guard are required');
}

const scripts = packageJson.scripts ?? {};
const expectedPackageTests = 'npm run test:contracts -- --api.host 127.0.0.1 && npm run test:pi-management-runtime && npm run test:domain -- --api.host 127.0.0.1 && npm run test:server-next-ci && npm run test:daemon-next -- --api.host 127.0.0.1 && npm run test:web-next -- --api.host 127.0.0.1';
const expectedPackageBuild = 'npm run build:contracts && npm run build:domain && npm run build:pi-management-runtime && npm run build:server-next && npm run build:daemon-next && npm run build:web-next';
if (scripts['test:phase2-task-dag-boundary'] !== 'node --test scripts/check-phase-2-task-dag-boundary.test.mjs'
  || scripts['check:phase2-task-dag-boundary'] !== 'node scripts/check-phase-2-task-dag-boundary.mjs'
  || !String(scripts['test:phase2-task-dag']).includes('test:phase2-task-dag-boundary')
  || !String(scripts['test:phase2-task-dag']).includes('test:domain')
  || !String(scripts['test:phase2-task-dag']).includes('test:server-next')
  || !String(scripts['build:phase2-task-dag']).includes('build:domain')
  || scripts['test:packages'] !== expectedPackageTests
  || scripts['test:server-next-ci'] !== 'cd apps/server-next && ../../node_modules/.bin/vitest run tests --config vitest.config.ts --api.host 127.0.0.1 --exclude tests/phase-2-managed-team-smoke.test.ts'
  || scripts['build:packages'] !== expectedPackageBuild
  || scripts['test:ci'] !== 'npm run test:packages && npm run test:retained-boundaries'
  || !String(scripts['test:retained-boundaries']).includes('test:phase2-task-dag-boundary')
  || !String(scripts['test:retained-boundaries']).includes('test:phase2-closeout')
  || !workflow.includes('npm run test:ci')
  || !workflow.includes('npm run build:packages')
  || workflow.includes('run: npm run test:phase2-task-dag')
  || workflow.includes('run: npm run test:phase2-closeout')
  || workflow.includes('run: npm run build:phase2-task-dag')
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

console.log('P2_BOUNDARY_READY: matrix, V2 contracts, Domain/persistence boundaries, Node 24, and root CI gates are present');

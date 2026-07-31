import { describe, expect, test } from 'vitest';
import { LEGACY_COORDINATION_RETIRED_CODE } from '../../../packages/contracts/src/pi-authority-cutover.js';
import {
  handleAdvanceMigrationState,
  handleBindMessageAuthorityEpoch,
  handleClearEmergencyStop,
  handleEmergencyStopPi,
  handleEvaluateCutoverReadiness,
  handleExecutePiAuthorityCutover,
  handlePiAuthorityCutoverQuery,
  handleRecordLegacyWriteAttempt,
  handleSubmitLegacyDrainResult,
  negotiateDaemonPiCapabilities,
  type PiAuthorityCutoverHandlerDeps,
} from '../src/application/pi-authority-cutover-handler.js';
import { createMemoryPiAuthorityCutoverUnitOfWork } from '../src/application/pi-authority-cutover-unit-of-work.js';
import {
  clonePiAuthorityCutoverMemoryState,
  createInMemoryPiAuthorityCutoverRepositories,
  createPiAuthorityCutoverMemoryState,
  restorePiAuthorityCutoverMemoryState,
} from '../src/infra/memory/pi-authority-cutover-repositories.js';

function createDeps(role: 'owner' | 'admin' | 'member' = 'owner'): PiAuthorityCutoverHandlerDeps & {
  state: ReturnType<typeof createPiAuthorityCutoverMemoryState>;
} {
  const state = createPiAuthorityCutoverMemoryState();
  const repos = createInMemoryPiAuthorityCutoverRepositories(state);
  let seq = 0;
  return {
    state,
    teamId: 'team-1',
    operatorId: 'user-owner',
    operatorRole: role,
    unitOfWork: createMemoryPiAuthorityCutoverUnitOfWork({
      repos,
      snapshot: () => clonePiAuthorityCutoverMemoryState(state),
      restore: (snap) => restorePiAuthorityCutoverMemoryState(
        state,
        snap as ReturnType<typeof createPiAuthorityCutoverMemoryState>,
      ),
    }),
    ids: { nextId: () => `id-${++seq}` },
    clock: { now: () => 10_000 + seq },
  };
}

function env(commandName: string, key: string) {
  return {
    schemaVersion: 1 as const,
    commandName,
    commandSchemaVersion: 1,
    idempotencyKey: key,
  };
}

async function cutoverReady(deps: ReturnType<typeof createDeps>) {
  const readiness = await handleEvaluateCutoverReadiness(
    deps,
    env('evaluate-cutover-readiness', 'ready-1'),
    {
      expectedMigrationRevision: 0,
      readinessChecks: [
        { checkId: 'promotion-gate', passed: true },
        { checkId: 'pi-runtime', passed: true },
        { checkId: 'message-tracer', passed: true },
      ],
      tokenTtlMs: 60_000,
    },
  );
  expect(readiness.outcome).toBe('applied');
  if (readiness.result?.commandName !== 'evaluate-cutover-readiness') throw new Error('shape');
  expect(readiness.result.snapshot.allPassed).toBe(true);
  expect(readiness.result.readinessToken).toBeTruthy();

  const stateAfter = await handlePiAuthorityCutoverQuery(deps, 'query-migration-state', {
    teamId: 'team-1',
  });
  if (stateAfter.result?.queryName !== 'query-migration-state') throw new Error('shape');
  const rev = stateAfter.result.migration.migrationRevision;

  const cutover = await handleExecutePiAuthorityCutover(
    deps,
    env('execute-pi-authority-cutover', 'cut-1'),
    {
      readinessToken: readiness.result.readinessToken!,
      expectedMigrationRevision: rev,
      expectedTargetEpoch: 1,
      runningLegacyJobs: [{ jobId: 'job-run-1', lineageKey: 'line-run-1' }],
      pendingLegacyJobIds: ['job-pend-1', 'job-pend-2'],
      drainDeadlineMs: 5_000,
    },
  );
  expect(cutover.outcome).toBe('applied');
  if (cutover.result?.commandName !== 'execute-pi-authority-cutover') throw new Error('shape');
  return cutover.result;
}

describe('evaluate + execute cutover', () => {
  test('Owner 原子推进 epoch、fencing、取消 pending、登记 drain', async () => {
    const deps = createDeps('owner');
    const result = await cutoverReady(deps);
    expect(result.migration.state).toBe('new_authority');
    expect(result.migration.authorityEpoch).toBe(1);
    expect(result.migration.legacyWriterFenced).toBe(true);
    expect(result.cancelledJobIds).toEqual(['job-pend-1', 'job-pend-2']);
    expect(result.drainLineages).toHaveLength(1);
    expect(result.drainLineages[0]?.lineageKey).toBe('line-run-1');
    expect(result.drainLineages[0]?.state).toBe('draining');

    // audit + outbox 原子写入
    expect(deps.state.audits.some((a) => a.eventKind === 'pi_authority_cutover_applied')).toBe(true);
    expect([...deps.state.outbox.values()].some((o) => o.eventKind === 'pi_authority_cutover_applied')).toBe(true);
  });

  test('member 不能签发 readiness', async () => {
    const deps = createDeps('member');
    const res = await handleEvaluateCutoverReadiness(
      deps,
      env('evaluate-cutover-readiness', 'm1'),
      {
        expectedMigrationRevision: 0,
        readinessChecks: [{ checkId: 'x', passed: true }],
        tokenTtlMs: 1000,
      },
    );
    expect(res.outcome).toBe('rejected');
    expect(res.stableCode).toBe('PI_AUTHORITY_FORBIDDEN');
  });

  test('readiness 未通过不签发 token', async () => {
    const deps = createDeps();
    const res = await handleEvaluateCutoverReadiness(
      deps,
      env('evaluate-cutover-readiness', 'nr1'),
      {
        expectedMigrationRevision: 0,
        readinessChecks: [
          { checkId: 'a', passed: true },
          { checkId: 'b', passed: false, detail: 'missing' },
        ],
        tokenTtlMs: 1000,
      },
    );
    expect(res.outcome).toBe('applied');
    if (res.result?.commandName !== 'evaluate-cutover-readiness') throw new Error('shape');
    expect(res.result.readinessToken).toBeUndefined();
    expect(res.stableCode).toBe('PI_AUTHORITY_READINESS_NOT_READY');
  });

  test('重复 cutover 幂等（同 key 同 payload 重放）', async () => {
    const deps = createDeps();
    const readiness = await handleEvaluateCutoverReadiness(
      deps,
      env('evaluate-cutover-readiness', 'ready-1'),
      {
        expectedMigrationRevision: 0,
        readinessChecks: [{ checkId: 'a', passed: true }],
        tokenTtlMs: 60_000,
      },
    );
    if (readiness.result?.commandName !== 'evaluate-cutover-readiness') throw new Error('shape');
    const cutoverInput = {
      readinessToken: readiness.result.readinessToken!,
      expectedMigrationRevision: 0,
      expectedTargetEpoch: 1,
      runningLegacyJobs: [{ jobId: 'job-run-1', lineageKey: 'line-run-1' }],
      pendingLegacyJobIds: ['job-pend-1'],
      drainDeadlineMs: 5_000,
    };
    const first = await handleExecutePiAuthorityCutover(
      deps,
      env('execute-pi-authority-cutover', 'cut-idem'),
      cutoverInput,
    );
    expect(first.outcome).toBe('applied');
    const replay = await handleExecutePiAuthorityCutover(
      deps,
      env('execute-pi-authority-cutover', 'cut-idem'),
      cutoverInput,
    );
    expect(replay.outcome).toBe('replayed');
    expect(replay.stableCode).toBe('PI_AUTHORITY_REPLAYED');
  });
});

describe('concurrency linearization', () => {
  test('并发消息与 cutover 按 migration revision 冲突线性化', async () => {
    const deps = createDeps();
    // 先绑定消息占用 revision 0→1
    const bind = await handleBindMessageAuthorityEpoch(
      deps,
      env('bind-message-authority-epoch', 'bind-1'),
      {
        messageId: 'msg-1',
        sourceLineageKey: 'line-msg-1',
        expectedMigrationRevision: 0,
      },
    );
    expect(bind.outcome).toBe('applied');

    // readiness 用过期 revision 0 → conflict
    const stale = await handleEvaluateCutoverReadiness(
      deps,
      env('evaluate-cutover-readiness', 'stale-ready'),
      {
        expectedMigrationRevision: 0,
        readinessChecks: [{ checkId: 'a', passed: true }],
        tokenTtlMs: 1000,
      },
    );
    expect(stale.outcome).toBe('conflict');
    expect(stale.stableCode).toBe('PI_AUTHORITY_REVISION_CONFLICT');

    // 用当前 revision 成功
    const state = await handlePiAuthorityCutoverQuery(deps, 'query-migration-state', { teamId: 'team-1' });
    if (state.result?.queryName !== 'query-migration-state') throw new Error('shape');
    const ready = await handleEvaluateCutoverReadiness(
      deps,
      env('evaluate-cutover-readiness', 'ready-ok'),
      {
        expectedMigrationRevision: state.result.migration.migrationRevision,
        readinessChecks: [{ checkId: 'a', passed: true }],
        tokenTtlMs: 60_000,
      },
    );
    expect(ready.outcome).toBe('applied');
  });

  test('同一 lineage 只有一个 epoch（replay 不换 epoch）', async () => {
    const deps = createDeps();
    await cutoverReady(deps);
    const state = await handlePiAuthorityCutoverQuery(deps, 'query-migration-state', { teamId: 'team-1' });
    if (state.result?.queryName !== 'query-migration-state') throw new Error('shape');
    const rev = state.result.migration.migrationRevision;

    const first = await handleBindMessageAuthorityEpoch(
      deps,
      env('bind-message-authority-epoch', 'b-line-1'),
      {
        messageId: 'msg-a',
        sourceLineageKey: 'shared-line',
        expectedMigrationRevision: rev,
      },
    );
    expect(first.outcome).toBe('applied');
    if (first.result?.commandName !== 'bind-message-authority-epoch') throw new Error('shape');
    expect(first.result.binding.authorityEpoch).toBe(1);

    const second = await handleBindMessageAuthorityEpoch(
      deps,
      env('bind-message-authority-epoch', 'b-line-2'),
      {
        messageId: 'msg-b',
        sourceLineageKey: 'shared-line',
      },
    );
    expect(second.outcome).toBe('replayed');
    if (second.result?.commandName !== 'bind-message-authority-epoch') throw new Error('shape');
    expect(second.result.binding.authorityEpoch).toBe(1);
    expect(second.result.binding.messageId).toBe('msg-a');
  });
});

describe('legacy retired + drain bridge', () => {
  test('cutover 后旧写接口返回 LEGACY_COORDINATION_RETIRED，不静默转译', async () => {
    const deps = createDeps();
    await cutoverReady(deps);
    const res = await handleRecordLegacyWriteAttempt(
      deps,
      env('record-legacy-write-attempt', 'lw-1'),
      { writeKind: 'create_coordination_job' },
    );
    expect(res.outcome).toBe('applied');
    expect(res.stableCode).toBe(LEGACY_COORDINATION_RETIRED_CODE);
    if (res.result?.commandName !== 'record-legacy-write-attempt') throw new Error('shape');
    expect(res.result.retired.code).toBe(LEGACY_COORDINATION_RETIRED_CODE);
    expect(res.result.retired.replacementEntry).toContain('promotion-gate');
  });

  test('合法 drain 结果带 provenance；幂等迟到结果 replay', async () => {
    const deps = createDeps();
    const cut = await cutoverReady(deps);
    const drain = cut.drainLineages[0]!;
    const first = await handleSubmitLegacyDrainResult(
      deps,
      env('submit-legacy-drain-result', 'drain-1'),
      {
        drainId: drain.drainId,
        lineageKey: drain.lineageKey,
        fencingToken: drain.fencingToken,
        drainLeaseId: drain.drainLeaseId,
        idempotencyKey: 'drain-1',
        resultPayload: { text: 'done' },
      },
    );
    expect(first.outcome).toBe('applied');
    if (first.result?.commandName !== 'submit-legacy-drain-result') throw new Error('shape');
    expect(first.result.disposition).toBe('accepted');
    expect(first.result.provenance?.cutoverVersion).toBe(1);
    expect(first.result.resultMessageId).toBeTruthy();

    const second = await handleSubmitLegacyDrainResult(
      deps,
      env('submit-legacy-drain-result', 'drain-1'),
      {
        drainId: drain.drainId,
        lineageKey: drain.lineageKey,
        fencingToken: drain.fencingToken,
        drainLeaseId: drain.drainLeaseId,
        idempotencyKey: 'drain-1',
        resultPayload: { text: 'done' },
      },
    );
    expect(second.outcome).toBe('replayed');
  });

  test('fencing token 错误拒绝；过期进入 recovery_pending', async () => {
    const deps = createDeps();
    const cut = await cutoverReady(deps);
    const drain = cut.drainLineages[0]!;

    const badFence = await handleSubmitLegacyDrainResult(
      deps,
      env('submit-legacy-drain-result', 'drain-bad'),
      {
        drainId: drain.drainId,
        lineageKey: drain.lineageKey,
        fencingToken: 999,
        drainLeaseId: drain.drainLeaseId,
        idempotencyKey: 'drain-bad',
        resultPayload: { text: 'x' },
      },
    );
    expect(badFence.outcome).toBe('rejected');

    // 强制过期：改 state 中的 deadline
    const row = deps.state.drainLineages.get(drain.drainId)!;
    deps.state.drainLineages.set(drain.drainId, { ...row, deadlineAt: 1 });

    const expired = await handleSubmitLegacyDrainResult(
      deps,
      env('submit-legacy-drain-result', 'drain-exp'),
      {
        drainId: drain.drainId,
        lineageKey: drain.lineageKey,
        fencingToken: drain.fencingToken,
        drainLeaseId: drain.drainLeaseId,
        idempotencyKey: 'drain-exp',
        resultPayload: { text: 'late' },
      },
    );
    expect(expired.outcome).toBe('applied');
    expect(expired.stableCode).toBe('PI_AUTHORITY_DRAIN_RECOVERY_PENDING');
    if (expired.result?.commandName !== 'submit-legacy-drain-result') throw new Error('shape');
    expect(expired.result.state).toBe('recovery_pending');
  });
});

describe('emergency-stop', () => {
  test('暂停 promotion/PI，消息仍可用，不重开 legacy writer', async () => {
    const deps = createDeps();
    const cut = await cutoverReady(deps);
    const stop = await handleEmergencyStopPi(
      deps,
      env('emergency-stop-pi', 'es-1'),
      {
        reason: 'incident',
        expectedMigrationRevision: cut.migration.migrationRevision,
      },
    );
    expect(stop.outcome).toBe('applied');
    if (stop.result?.commandName !== 'emergency-stop-pi') throw new Error('shape');
    expect(stop.result.promotionCommandsPaused).toBe(true);
    expect(stop.result.piCommandsPaused).toBe(true);
    expect(stop.result.messageDeliveryAvailable).toBe(true);
    expect(stop.result.legacyWriterReenabled).toBe(false);
    expect(stop.result.migration.emergencyStop).toBe(true);
    expect(stop.result.migration.legacyWriterFenced).toBe(true);

    // 消息绑定仍可用（emergency-stop 不挡 message delivery）
    const bind = await handleBindMessageAuthorityEpoch(
      deps,
      env('bind-message-authority-epoch', 'msg-after-es'),
      {
        messageId: 'msg-es',
        sourceLineageKey: 'line-es',
        expectedMigrationRevision: stop.result.migration.migrationRevision,
      },
    );
    expect(bind.outcome).toBe('applied');

    // clear 从前滚恢复
    const cleared = await handleClearEmergencyStop(
      deps,
      env('clear-emergency-stop', 'es-clear'),
      {
        expectedMigrationRevision: stop.result.migration.migrationRevision + 1, // bind 递增了 revision
        recoveryFromNewFactsOnly: true,
      },
    );
    // bind 后 revision 变化，可能 conflict — 重新读
    if (cleared.outcome === 'conflict') {
      const st = await handlePiAuthorityCutoverQuery(deps, 'query-migration-state', { teamId: 'team-1' });
      if (st.result?.queryName !== 'query-migration-state') throw new Error('shape');
      const cleared2 = await handleClearEmergencyStop(
        deps,
        env('clear-emergency-stop', 'es-clear-2'),
        {
          expectedMigrationRevision: st.result.migration.migrationRevision,
          recoveryFromNewFactsOnly: true,
        },
      );
      expect(cleared2.outcome).toBe('applied');
      if (cleared2.result?.commandName !== 'clear-emergency-stop') throw new Error('shape');
      expect(cleared2.result.legacyWriterReenabled).toBe(false);
      expect(cleared2.result.migration.emergencyStop).toBe(false);
    } else {
      expect(cleared.outcome).toBe('applied');
    }

    // 旧写仍退役
    const legacy = await handleRecordLegacyWriteAttempt(
      deps,
      env('record-legacy-write-attempt', 'lw-after-es'),
      { writeKind: 'retry_job' },
    );
    expect(legacy.stableCode).toBe(LEGACY_COORDINATION_RETIRED_CODE);
  });
});

describe('retirement metrics + advance state', () => {
  test('可查询退役指标；门槛未满足不能 retired', async () => {
    const deps = createDeps();
    await cutoverReady(deps);
    const metricsQ = await handlePiAuthorityCutoverQuery(deps, 'query-retirement-metrics', {
      teamId: 'team-1',
    });
    expect(metricsQ.outcome).toBe('ready');
    if (metricsQ.result?.queryName !== 'query-retirement-metrics') throw new Error('shape');
    expect(metricsQ.result.metrics.storageDeletionBlocked).toBe(true);
    expect(metricsQ.result.metrics.openDrainLineageCount).toBe(1);

    const st = await handlePiAuthorityCutoverQuery(deps, 'query-migration-state', { teamId: 'team-1' });
    if (st.result?.queryName !== 'query-migration-state') throw new Error('shape');

    const blocked = await handleAdvanceMigrationState(
      deps,
      env('advance-migration-state', 'adv-1'),
      {
        expectedMigrationRevision: st.result.migration.migrationRevision,
        targetState: 'retired',
        metricsGate: {
          ...metricsQ.result.metrics,
          readyToRetireRuntime: true,
          openDrainLineageCount: 1,
        },
      },
    );
    expect(blocked.outcome).toBe('rejected');
    expect(blocked.stableCode).toBe('PI_AUTHORITY_RETIREMENT_BLOCKED');
  });

  test('drain 清零且指标满足后可进 legacy_read_only', async () => {
    const deps = createDeps();
    const cut = await cutoverReady(deps);
    const drain = cut.drainLineages[0]!;
    await handleSubmitLegacyDrainResult(
      deps,
      env('submit-legacy-drain-result', 'drain-done'),
      {
        drainId: drain.drainId,
        lineageKey: drain.lineageKey,
        fencingToken: drain.fencingToken,
        drainLeaseId: drain.drainLeaseId,
        idempotencyKey: 'drain-done',
        resultPayload: { ok: true },
      },
    );

    // 重置 writer 计数窗口
    const counters = deps.state.retirementCounters.get('team-1')!;
    deps.state.retirementCounters.set('team-1', {
      ...counters,
      legacyWriterCallCount: 0,
      legacyClientCallCount: 0,
      observationWindowStartedAt: 1,
      observationWindowEndsAt: 2,
      emergencyStopDrillPassed: true,
      forwardRecoveryDrillPassed: true,
      historicalProvenanceExportVerified: true,
      replacementQueryPathReady: true,
    });

    const st = await handlePiAuthorityCutoverQuery(deps, 'query-migration-state', { teamId: 'team-1' });
    if (st.result?.queryName !== 'query-migration-state') throw new Error('shape');
    const metricsQ = await handlePiAuthorityCutoverQuery(deps, 'query-retirement-metrics', {
      teamId: 'team-1',
    });
    if (metricsQ.result?.queryName !== 'query-retirement-metrics') throw new Error('shape');

    const advanced = await handleAdvanceMigrationState(
      deps,
      env('advance-migration-state', 'adv-ro'),
      {
        expectedMigrationRevision: st.result.migration.migrationRevision,
        targetState: 'legacy_read_only',
        metricsGate: metricsQ.result.metrics,
      },
    );
    expect(advanced.outcome).toBe('applied');
    if (advanced.result?.commandName !== 'advance-migration-state') throw new Error('shape');
    expect(advanced.result.migration.state).toBe('legacy_read_only');
  });
});

describe('legacy compatibility projection is read-only', () => {
  test('writable 恒为 false', async () => {
    const deps = createDeps();
    await cutoverReady(deps);
    deps.state.compatibilityProjections.set('coordination_job|job-1', {
      sourceId: 'job-1',
      teamId: 'team-1',
      projectionKind: 'coordination_job',
      payloadJson: JSON.stringify({ status: 'completed' }),
      projectedAt: 1000,
    });
    const q = await handlePiAuthorityCutoverQuery(deps, 'query-legacy-compatibility-projection', {
      teamId: 'team-1',
      projectionKind: 'coordination_job',
      sourceId: 'job-1',
    });
    expect(q.outcome).toBe('ready');
    if (q.result?.queryName !== 'query-legacy-compatibility-projection') throw new Error('shape');
    expect(q.result.writable).toBe(false);
    expect(q.result.projection?.immutable).toBe(true);
  });
});

describe('daemon capability negotiation', () => {
  test('旧 daemon 只保留 drain，不能取得 PI orchestration authority', () => {
    const n = negotiateDaemonPiCapabilities({
      daemonProtocolVersion: 1,
      advertisedCapabilities: ['message.send', 'legacy.drain'],
      teamMigrationState: 'new_authority',
      legacyWriterFenced: true,
      minPiExecutionProtocolVersion: 2,
    });
    expect(n.mayCreateCoordinationJob).toBe(false);
    expect(n.mayObtainPiOrchestrationAuthority).toBe(false);
    expect(n.mayDrainLegacyWork).toBe(true);
    expect(n.maySendMessages).toBe(true);
  });
});

describe('failure injection: transaction rollback', () => {
  test('事务内抛错不留下部分 cutover 事实', async () => {
    const state = createPiAuthorityCutoverMemoryState();
    const repos = createInMemoryPiAuthorityCutoverRepositories(state);
    let seq = 0;
    let failNext = false;
    const unitOfWork = {
      async runInTransaction<T>(work: (r: typeof repos) => Promise<T>): Promise<T> {
        const snap = clonePiAuthorityCutoverMemoryState(state);
        try {
          const result = await work(repos);
          if (failNext) {
            failNext = false;
            throw new Error('injected_failure');
          }
          return result;
        } catch (error) {
          restorePiAuthorityCutoverMemoryState(state, snap);
          throw error;
        }
      },
    };
    const deps: PiAuthorityCutoverHandlerDeps = {
      teamId: 'team-1',
      operatorId: 'op',
      operatorRole: 'owner',
      unitOfWork,
      ids: { nextId: () => `id-${++seq}` },
      clock: { now: () => 1000 + seq },
    };

    const ready = await handleEvaluateCutoverReadiness(
      deps,
      env('evaluate-cutover-readiness', 'inj-ready'),
      {
        expectedMigrationRevision: 0,
        readinessChecks: [{ checkId: 'a', passed: true }],
        tokenTtlMs: 60_000,
      },
    );
    if (ready.result?.commandName !== 'evaluate-cutover-readiness') throw new Error('shape');

    failNext = true;
    await expect(handleExecutePiAuthorityCutover(
      deps,
      env('execute-pi-authority-cutover', 'inj-cut'),
      {
        readinessToken: ready.result.readinessToken!,
        expectedMigrationRevision: 0,
        expectedTargetEpoch: 1,
        runningLegacyJobs: [{ jobId: 'j1', lineageKey: 'l1' }],
        pendingLegacyJobIds: ['p1'],
        drainDeadlineMs: 1000,
      },
    )).rejects.toThrow('injected_failure');

    // 迁移仍未 cutover
    const migration = state.migrations.get('team-1');
    expect(migration?.state === 'new_authority').toBe(false);
    expect(migration?.legacyWriterFenced ?? false).toBe(false);
    expect(state.drainLineages.size).toBe(0);
  });
});

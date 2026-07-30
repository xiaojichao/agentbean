import { describe, expect, test, vi } from 'vitest';
import type { TaskClaimAcquireAckV1 } from '../../../packages/contracts/src/index.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import { createTaskClaimBroker } from '../src/application/management/task-claim-broker.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import { resolveTaskAllocation } from '../src/application/management/task-allocation-service.js';
import { createProjectStageAutoAdvance } from '../src/application/project-stage-auto-advance.js';
import { filterStrictProjectStageAgentIds } from '../src/application/project-stage-advance-service.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Task Claim Broker', () => {
  test('#925 ADR-0063: root Task node rejects Agent execution claim on both acquire and accept paths', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'eligible', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({
      channelId: 'channel-1',
      changes: { agentMemberIds: ['eligible'], updatedAt: harness.clock.value },
    });
    // prepareOffers/publishOffer 不按 nodeKind 门禁；claim 决策（acquire/accept）才是 root 硬防线。
    const [acquireOffer] = await harness.broker.prepareOffers('root-task');
    expect(acquireOffer).toBeDefined();
    await expect(harness.broker.acquire({
      schemaVersion: 1, offerId: acquireOffer!.offerId, agentId: 'eligible',
    })).resolves.toMatchObject({ ok: false, diagnosticCode: 'TASK_CLAIM_ROOT_NOT_CLAIMABLE' });

    const [acceptOffer] = await harness.broker.prepareOffers('root-task');
    await expect(harness.broker.respondToOffer({
      offerId: acceptOffer!.offerId, agentId: 'eligible', kind: 'accepted',
    })).resolves.toMatchObject({ kind: 'not_accepted' });

    // 防线落在 claim 决策：root Task 不产生任何 active claim lease。
    await expect(harness.repositories.taskCoordination.claimLeases.listActive())
      .resolves.toEqual([]);
  });

  test('#925 ADR-0064: successful claim issues an execution context grant; release revokes it', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const claim = await claimFirst(harness);
    expect(typeof claim.execution.grantId).toBe('string');

    const grant = await harness.repositories.taskCoordination.executionGrants
      .getActiveByTaskAttempt({ taskId: 'task-a', taskAttempt: 1 });
    expect(grant).toMatchObject({
      state: 'active', agentId: 'agent-1',
      claimLeaseId: claim.lease.claimLeaseId, taskRevision: claim.lease.taskRevision,
    });

    harness.clock.value = 60;
    await expect(harness.broker.release({ ...claim.lease, reasonCode: 'YIELD' }))
      .resolves.toMatchObject({ ok: true });
    const after = await harness.repositories.taskCoordination.executionGrants.getById(grant!.id);
    expect(after).toMatchObject({ state: 'revoked', revocationReason: 'claim-released' });
  });

  test('#948-E ADR-0064/0065: relinquish after execution start terminates the attempt and requeues', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const claim = await claimFirst(harness);
    // acquire 已把 task-a 置 in_progress（execution start）；grant active，attempt=1。
    await expect(harness.repositories.tasks.getById('task-a')).resolves.toMatchObject({ status: 'in_progress' });

    harness.clock.value = 60;
    const ack = await harness.broker.relinquish({ ...claim.lease, cause: 'agent_unavailable' });
    expect(ack).toMatchObject({ ok: true, executionStarted: true, attempt: 2 });
    // lease released + grant revoked（claim-released）。
    await expect(harness.repositories.taskCoordination.claimLeases.getById(claim.lease.claimLeaseId))
      .resolves.toMatchObject({ status: 'released', releasedAt: 60 });
    expect(await harness.repositories.taskCoordination.executionGrants
      .getActiveByTaskAttempt({ taskId: 'task-a', taskAttempt: 1 })).toBeNull();
    // 开工后 relinquish 终止并消耗 attempt（1→2），task 回 todo（可重新派发新 attempt）。
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId('task-a'))
      .resolves.toMatchObject({ attempt: 2 });
    await expect(harness.repositories.tasks.getById('task-a')).resolves.toMatchObject({ status: 'todo' });
  });

  test('#948-E: relinquish is idempotent (already-relinquished keeps attempt)', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const claim = await claimFirst(harness);
    await harness.broker.relinquish({ ...claim.lease, cause: 'agent_voluntary' });
    // 二次 relinquish：lease 已 released → already_relinquished，幂等，不再消耗 attempt。
    const again = await harness.broker.relinquish({ ...claim.lease, cause: 'agent_voluntary' });
    expect(again).toMatchObject({ ok: true });
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId('task-a'))
      .resolves.toMatchObject({ attempt: 2 });
  });

  test('#948-E: relinquish with stale authority is rejected (proof-gated, claim untouched)', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const claim = await claimFirst(harness);
    // 错误 leaseToken → presentedLeaseTokenHash 不匹配 → rejected（fail-closed，AC#6）。
    await expect(harness.broker.relinquish({ ...claim.lease, leaseToken: 'wrong-token', cause: 'agent_voluntary' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'STALE_AUTHORITY' });
    await expect(harness.repositories.taskCoordination.claimLeases.getById(claim.lease.claimLeaseId))
      .resolves.toMatchObject({ status: 'active' });
  });

  test('#946: claim 签发的 grant 绑定签发时 offer 冻结的 manifestRevision', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    await claimFirst(harness);
    const grant = await harness.repositories.taskCoordination.executionGrants
      .getActiveByTaskAttempt({ taskId: 'task-a', taskAttempt: 1 });
    // seedAgent 建的 active manifest revision=1；publishOffer 冻结 manifestRevision=1 → grant 绑定 1。
    expect(grant).toMatchObject({ manifestRevision: 1, agentId: 'agent-1', state: 'active' });
  });

  test('#925 P1-b: 持久化 offer 在 lease 时间过期未扫时被 accept → 内联过期旧 lease 同事务撤销其 grant', async () => {
    // offerTtlMs(500) > leaseTtlMs(50)：持久化 offer 的生命跨越 lease 过期。
    // prepareOffers 在 t=10 发 O1/O2；agent-1 acquire(O1) 仅 consumeTaskOffers（清内存 map），
    // 不失效持久化 O2、也不触发 sweep。clock 推过 L1 过期(60)后 agent-2 accept 持久化 O2 →
    // getLatest=L1(active,已时间过期)→claim_granted→respondToOffer 内联过期分支触发。
    // 无修复：旧 grant 不撤销 → 内存双 active grant（sqlite 则撞唯一索引回滚整笔 accept）。
    const harness = await createHarness({ offerTtlMs: 500, leaseTtlMs: 50 });
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await seedAgent(harness.repositories, 'agent-2', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1', 'agent-2'], updatedAt: 10 } });

    // t=10：无 active lease → 给两 agent 各持久化一个 offer（均 valid 到 510）。
    const prepared = await harness.broker.prepareOffers('task-a');
    const o1 = prepared.find((candidate) => candidate.agentId === 'agent-1')!;
    const o2 = prepared.find((candidate) => candidate.agentId === 'agent-2')!;

    // agent-1 acquire(O1) → L1（expiresAt = 10+50 = 60）+ G1。
    const first = await harness.broker.acquire({ schemaVersion: 1,
      offerId: o1.offerId, agentId: 'agent-1' });
    expect(first.ok).toBe(true);
    const firstAck = first as Extract<TaskClaimAcquireAckV1, { ok: true }>;
    const g1Id = firstAck.execution.grantId;
    expect(typeof g1Id).toBe('string');
    await expect(harness.repositories.taskCoordination.executionGrants
      .getActiveByTaskAttempt({ taskId: 'task-a', taskAttempt: 1 }))
      .resolves.toMatchObject({ state: 'active', agentId: 'agent-1', id: g1Id });

    // 关键：clock 推过 L1 过期(60)，但不调 prepareOffers/expireClaims → L1 仍持久化 active、G1 仍 active。
    harness.clock.value = 70;

    // agent-2 accept 持久化 O2（valid 到 510）→ 命中 respondToOffer 内联过期分支。
    const accepted = await harness.broker.respondToOffer({
      offerId: o2.offerId, agentId: 'agent-2', kind: 'accepted',
    });
    expect(accepted).toMatchObject({ kind: 'claim_granted' });

    // 旧 grant G1 必须已撤销（claim-expired），不得与新 G2 共存。
    await expect(harness.repositories.taskCoordination.executionGrants.getById(g1Id!))
      .resolves.toMatchObject({ state: 'revoked', revocationReason: 'claim-expired' });
    await expect(harness.repositories.taskCoordination.executionGrants
      .getActiveByTaskAttempt({ taskId: 'task-a', taskAttempt: 1 }))
      .resolves.toMatchObject({ state: 'active', agentId: 'agent-2' });
    // (task-a) 全表仅一个 active grant——锁死内存分叉的双 active grant 回归。
    await expect(harness.repositories.taskCoordination.executionGrants.listActiveByTask('task-a'))
      .resolves.toHaveLength(1);
  });

  test('#829 文档 InputSet 候选必须同时声明 Agent 与 Device 合同版本', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'eligible', 'device-1', 'online', ['code-review']);

    await expect(filterStrictProjectStageAgentIds(harness.repositories, {
      teamId: 'team-1',
      candidateAgentIds: ['eligible'],
      requiredCapabilities: ['code-review'],
      requiredProjectDocumentInputSetVersion: 1,
      now: harness.clock.value,
    })).resolves.toEqual([]);
  });

  test('#829 canonical acceptance 缺失时不发布下游 Offer', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'eligible', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({
      channelId: 'channel-1',
      changes: { agentMemberIds: ['eligible'], updatedAt: 10 },
    });
    await harness.repositories.tasks.update({
      taskId: 'root-task',
      changes: { status: 'done', updatedAt: 10 },
    });
    await seedProjectStageEdge(harness.repositories, false);
    const emitTaskOffers = vi.fn();
    const autoAdvance = createProjectStageAutoAdvance({
      repositories: harness.repositories,
      broker: harness.broker,
      piHealthy: async () => true,
      emitTaskOffers,
      invokeClaimedProjectStage: async () => undefined,
      now: () => harness.clock.value,
    });

    await expect(autoAdvance.advanceChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual([{
      taskId: 'task-a',
      kind: 'waiting',
      reason: 'execution_gate_blocked',
      targetAgentIds: [],
    }]);
    expect(emitTaskOffers).not.toHaveBeenCalled();
  });

  test('#829 上游完成后由健康 PI 通过真实候选与 Offer 协议推进下游，降级时 fail closed', async () => {
    const healthy = await createHarness();
    await seedAgent(healthy.repositories, 'eligible', 'device-1', 'online', ['code-review']);
    await healthy.repositories.channels.update({
      channelId: 'channel-1',
      changes: { agentMemberIds: ['eligible'], updatedAt: 10 },
    });
    await healthy.repositories.tasks.update({
      taskId: 'root-task',
      changes: { status: 'done', updatedAt: 10 },
    });
    await seedProjectStageEdge(healthy.repositories);
    const emitted: string[] = [];
    const emittedOffers: Array<{ offerId: string; agentId: string }> = [];
    const autoAdvance = createProjectStageAutoAdvance({
      repositories: healthy.repositories,
      broker: healthy.broker,
      piHealthy: async () => true,
      emitTaskOffers: async (taskId, options) => {
        emitted.push(taskId);
        emittedOffers.push(...await healthy.broker.prepareOffers(taskId, options));
      },
      invokeClaimedProjectStage: async () => undefined,
      now: () => healthy.clock.value,
    });

    await expect(autoAdvance.advanceChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual([{
      taskId: 'task-a',
      kind: 'offered',
      targetAgentIds: ['eligible'],
    }]);
    expect(emitted).toEqual(['task-a']);
    const [autoOffer] = await healthy.repositories.taskCoordination.offers.listByTask('task-a');
    expect(autoOffer).toEqual(expect.objectContaining({
        taskId: 'task-a',
        agentId: 'eligible',
        status: 'open',
      }));
    await healthy.repositories.teamPiPolicy.setAutoCoordination({
      teamId: 'team-1',
      enabled: false,
      actorId: 'user-1',
      now: healthy.clock.value,
    });
    await expect(healthy.broker.acquire({
      schemaVersion: 1,
      offerId: emittedOffers[0]!.offerId,
      agentId: 'eligible',
    })).resolves.toMatchObject({
      ok: false,
      diagnosticCode: 'TASK_CLAIM_PROJECT_STAGE_FENCE_STALE',
    });
    await expect(healthy.broker.respondToOffer({
      offerId: autoOffer!.id,
      agentId: 'eligible',
      kind: 'accepted',
    })).resolves.toMatchObject({
      kind: 'not_accepted',
      diagnosticCode: 'TASK_CLAIM_PROJECT_STAGE_FENCE_STALE',
    });
    await expect(healthy.repositories.taskCoordination.offers.getById(autoOffer!.id))
      .resolves.toMatchObject({ status: 'invalidated' });
    await expect(healthy.broker.acquire({
      schemaVersion: 1,
      offerId: emittedOffers[0]!.offerId,
      agentId: 'eligible',
    })).resolves.toMatchObject({
      ok: false,
      diagnosticCode: 'TASK_CLAIM_PROJECT_STAGE_FENCE_STALE',
    });
    await expect(healthy.repositories.taskCoordination.claimLeases.listActive()).resolves.toEqual([]);
    await expect(healthy.repositories.tasks.getById('task-a'))
      .resolves.toMatchObject({ status: 'todo' });

    const degraded = await createHarness();
    await seedAgent(degraded.repositories, 'eligible', 'device-1', 'online', ['code-review']);
    await degraded.repositories.channels.update({
      channelId: 'channel-1',
      changes: { agentMemberIds: ['eligible'], updatedAt: 10 },
    });
    await degraded.repositories.tasks.update({
      taskId: 'root-task',
      changes: { status: 'done', updatedAt: 10 },
    });
    await seedProjectStageEdge(degraded.repositories);
    const degradedEmit = vi.fn();
    const degradedAdvance = createProjectStageAutoAdvance({
      repositories: degraded.repositories,
      broker: degraded.broker,
      piHealthy: async () => false,
      emitTaskOffers: degradedEmit,
      invokeClaimedProjectStage: async () => undefined,
      now: () => degraded.clock.value,
    });

    await expect(degradedAdvance.advanceChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual([{
      taskId: 'task-a',
      kind: 'waiting',
      reason: 'pi_degraded',
      targetAgentIds: [],
    }]);
    expect(degradedEmit).not.toHaveBeenCalled();

    const legacy = await createHarness();
    await legacy.repositories.agents.upsert({
      id: 'legacy',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'legacy',
      adapterKind: 'codex',
      category: 'executor-hosted',
      source: 'custom',
      status: 'online',
      deviceId: 'device-1',
      skills: [{
        name: 'code-review',
        description: 'legacy',
        scope: 'user',
        sourcePath: '/legacy',
        adapterKind: 'codex',
      }],
    });
    await legacy.repositories.channels.update({
      channelId: 'channel-1',
      changes: { agentMemberIds: ['legacy'], updatedAt: 10 },
    });
    await legacy.repositories.tasks.update({
      taskId: 'root-task',
      changes: { status: 'done', updatedAt: 10 },
    });
    await seedProjectStageEdge(legacy.repositories);
    const legacyEmit = vi.fn();
    const legacyAdvance = createProjectStageAutoAdvance({
      repositories: legacy.repositories,
      broker: legacy.broker,
      piHealthy: async () => true,
      emitTaskOffers: legacyEmit,
      invokeClaimedProjectStage: async () => undefined,
      now: () => legacy.clock.value,
    });
    await expect(legacyAdvance.advanceChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual([{
      taskId: 'task-a',
      kind: 'waiting',
      reason: 'no_eligible_agent',
      targetAgentIds: [],
    }]);
    expect(legacyEmit).not.toHaveBeenCalled();

    const execution = await createHarness();
    await seedAgent(execution.repositories, 'eligible', 'device-1', 'online', ['code-review']);
    await execution.repositories.channels.update({
      channelId: 'channel-1',
      changes: { agentMemberIds: ['eligible'], updatedAt: 10 },
    });
    await execution.repositories.tasks.update({
      taskId: 'root-task',
      changes: { status: 'done', updatedAt: 10 },
    });
    await seedProjectStageEdge(execution.repositories);
    let invocationId = 0;
    const gateway = createInvocationGateway({
      repositories: execution.repositories,
      clock: { now: () => execution.clock.value },
      ids: { nextId: () => `stage-invocation-${++invocationId}` },
    });
    const invokeClaimedProjectStage = async (claim: {
      managementRunId: string;
      taskId: string;
      taskRevision: number;
      taskAttempt: number;
      claimLeaseId: string;
      targetAgentId: string;
      objective: string;
    }) => {
      const invoked = await gateway.invokeClaimedProjectStage({
        managementRunId: claim.managementRunId,
        idempotencyKey: `project-stage-auto:${claim.claimLeaseId}`,
        taskId: claim.taskId,
        expectedTaskRevision: claim.taskRevision,
        taskAttempt: claim.taskAttempt,
        claimLeaseId: claim.claimLeaseId,
        targetAgentId: claim.targetAgentId,
        objective: claim.objective,
        attachmentIds: [],
      });
      return invoked.view.activeDispatchId
        ? invoked.view
        : gateway.retryClaimedProjectStage({
          managementRunId: claim.managementRunId,
          invocationId: invoked.view.id,
        });
    };
    const executionAdvance = createProjectStageAutoAdvance({
      repositories: execution.repositories,
      broker: execution.broker,
      piHealthy: async () => true,
      emitTaskOffers: async (taskId, options) => {
        await execution.broker.prepareOffers(taskId, options);
      },
      invokeClaimedProjectStage: async (claim) => {
        await invokeClaimedProjectStage(claim);
      },
      now: () => execution.clock.value,
    });
    execution.broker.bindProjectStageClaimGranted(async (claim) => {
      const view = await invokeClaimedProjectStage(claim);
      await gateway.completeAttempt({
        dispatchId: view.activeDispatchId!,
        status: 'failed',
        error: 'simulated initial dispatch failure',
      });
      throw new Error('simulated initial dispatch failure');
    });
    await executionAdvance.advanceChannel({ teamId: 'team-1', channelId: 'channel-1' });
    const [executionOffer] = await execution.repositories.taskCoordination.offers.listByTask('task-a');
    const accepted = await execution.broker.respondToOffer({
      offerId: executionOffer!.id,
      agentId: 'eligible',
      kind: 'accepted',
    });
    expect(accepted.kind).toBe('claim_granted');
    if (accepted.kind !== 'claim_granted') throw new Error('expected claim');
    await expect(executionAdvance.advanceChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual([{
      taskId: 'task-a',
      kind: 'claimed',
      targetAgentIds: ['eligible'],
    }]);
    const [invoked] = await execution.repositories.management.invocations.listByRun('run-1');
    expect(invoked).toBeDefined();
    const recovered = await gateway.getView(invoked!.id);
    expect(recovered).toMatchObject({
      status: 'pending',
      intent: {
        targetAgentId: 'eligible',
        attachmentIds: ['artifact-stage-829-final'],
        projectStageInputFence: {
          stageId: 'stage-downstream-829',
          inputs: [expect.objectContaining({
            key: 'upstream-final',
            kind: 'artifact_version',
            artifactId: 'artifact-stage-829-final',
            versionId: 'version-stage-829-final',
            reviewId: 'review-stage-829-final',
            finalizationId: 'finalization-stage-829-final',
          })],
        },
      },
    });
    await gateway.completeAttempt({
      dispatchId: recovered.activeDispatchId!,
      status: 'failed',
      error: 'prepare stale fence scenario',
    });
    await promoteReplacementStageArtifact(execution.repositories);
    await expect(executionAdvance.advanceChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual([{
      taskId: 'task-a',
      kind: 'waiting',
      reason: 'claim_stale',
      targetAgentIds: [],
    }]);
    await expect(gateway.getView(invoked!.id)).resolves.toMatchObject({
      status: 'failed',
      dispatchAttempts: [{ attemptNumber: 1 }, { attemptNumber: 2 }],
    });
  });

  test('候选集对 visibility/readiness/capability/channel 给出明确 diagnostics', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'eligible', 'device-1', 'online', ['code-review']);
    await seedAgent(harness.repositories, 'busy', 'device-1', 'busy', ['code-review']);
    await seedAgent(harness.repositories, 'missing-capability', 'device-1', 'online', []);
    await seedAgent(harness.repositories, 'offline-device', 'device-2', 'online', ['code-review']);
    await seedAgent(harness.repositories, 'hidden', 'device-1', 'online', ['code-review'], []);
    await seedAgent(harness.repositories, 'ancestor', 'device-1', 'online', ['code-review']);
    await harness.repositories.tasks.update({ taskId: 'root-task',
      changes: { assigneeId: 'ancestor', updatedAt: 10 } });
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['eligible', 'busy', 'missing-capability', 'offline-device', 'hidden', 'ancestor'], updatedAt: 10 } });

    const resolution = await harness.broker.resolveCandidates('task-a');
    expect(resolution.candidates.find((item) => item.agentId === 'eligible')).toMatchObject({ eligible: true });
    expect(resolution.candidates.find((item) => item.agentId === 'busy')).toMatchObject({
      eligible: false, diagnosticCodes: ['AGENT_NOT_READY'],
    });
    expect(resolution.candidates.find((item) => item.agentId === 'missing-capability')).toMatchObject({
      eligible: false, diagnosticCodes: ['CAPABILITY_MISSING'], missingCapabilities: ['code-review'],
    });
    expect(resolution.candidates.find((item) => item.agentId === 'offline-device')).toMatchObject({
      eligible: false, diagnosticCodes: ['DEVICE_OFFLINE'],
    });
    expect(resolution.candidates.find((item) => item.agentId === 'hidden')).toMatchObject({
      eligible: false, diagnosticCodes: ['AGENT_NOT_VISIBLE'],
    });
    expect(resolution.candidates.find((item) => item.agentId === 'ancestor')).toMatchObject({
      eligible: false, diagnosticCodes: ['ANCESTOR_AGENT_LOOP'],
    });
  });

  test('offer 不创建 Dispatch，并发 claim 仅一个 winner 获得 snapshot 与 raw token', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await seedAgent(harness.repositories, 'agent-2', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1', 'agent-2'], updatedAt: 10 } });
    const dispatchCreate = vi.spyOn(harness.repositories.dispatches, 'create');

    const offers = await harness.broker.prepareOffers('task-a');
    expect(offers).toHaveLength(2);
    expect(dispatchCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(offers)).not.toMatch(/objective|leaseToken|attachment/);
    const results = await Promise.all(offers.map((offer) => harness.broker.acquire({
      schemaVersion: 1, offerId: offer.offerId, agentId: offer.agentId,
    })));
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      ok: true,
      lease: { fencingToken: 1, leaseToken: 'raw-token-1' },
      execution: { taskId: 'task-a', title: 'Task A', objective: 'objective a',
        acceptanceCriteria: [{ id: 'criterion-a' }], dependencyTaskIds: [] },
    });
    expect(dispatchCreate).not.toHaveBeenCalled();
    await expect(harness.repositories.tasks.getById('task-a')).resolves.toMatchObject({
      status: 'in_progress', assigneeId: (winners[0] as Extract<TaskClaimAcquireAckV1, { ok: true }>).lease.agentId,
    });
    const leases = await harness.repositories.taskCoordination.claimLeases.listActive();
    expect(leases).toHaveLength(1);
    expect(leases[0]?.leaseTokenHash).not.toBe('raw-token-1');
    expect(JSON.stringify(leases[0])).not.toContain('raw-token-1');
    await expect(harness.repositories.management.events.list('run-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ type: 'task-claimed' }) }),
        expect.objectContaining({ event: expect.objectContaining({ type: 'task-state-changed' }) }),
      ]),
    );
  });

  test('blocked invalidates the old claim, advances attempt, and allows a fresh claim', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const first = await claimFirst(harness);

    await harness.coordination.reportBlocked({ authority: harness.authority,
      idempotencyKey: 'blocked-a', taskId: 'task-a', expectedTaskRevision: 1,
      reasonCode: 'DEPENDENCY_UNAVAILABLE' });
    await expect(harness.repositories.taskCoordination.claimLeases.getById(first.lease.claimLeaseId))
      .resolves.toMatchObject({ status: 'invalidated', taskAttempt: 1 });
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId('task-a'))
      .resolves.toMatchObject({ attempt: 2 });

    const [offer] = await harness.broker.prepareOffers('task-a');
    expect(offer).toMatchObject({ taskAttempt: 2 });
    await expect(harness.broker.acquire({ schemaVersion: 1,
      offerId: offer!.offerId, agentId: offer!.agentId })).resolves.toMatchObject({
      ok: true, lease: { taskAttempt: 2, fencingToken: 1 },
    });
  });

  test('renew/release/expire/disconnect/reconnect 在 fake clock 下可复现且 fencing 单调', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await seedAgent(harness.repositories, 'agent-2', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1', 'agent-2'], updatedAt: 10 } });
    const first = await claimFirst(harness);
    const authority = first.lease;

    harness.clock.value = 50;
    await expect(harness.broker.renew(authority)).resolves.toMatchObject({ ok: true, expiresAt: 150 });
    harness.broker.disconnectDevice('device-1');
    expect((await harness.broker.resolveCandidates('task-a')).candidates[0]).toMatchObject({
      eligible: false, diagnosticCodes: ['DEVICE_OFFLINE'],
    });
    harness.broker.reconnectDevice('device-1');
    expect((await harness.broker.resolveCandidates('task-a')).candidates[0]).toMatchObject({ eligible: true });
    harness.clock.value = 60;
    await expect(harness.broker.release({ ...authority, reasonCode: 'YIELD' })).resolves.toMatchObject({
      ok: true, releasedAt: 60,
    });

    const secondOffers = await harness.broker.prepareOffers('task-a');
    const secondOffer = secondOffers.find((offer) => offer.agentId === 'agent-2')!;
    const secondResult = await harness.broker.acquire({ schemaVersion: 1,
      offerId: secondOffer.offerId, agentId: secondOffer.agentId });
    expect(secondResult.ok).toBe(true);
    const second = secondResult as Extract<TaskClaimAcquireAckV1, { ok: true }>;
    expect(second.lease.fencingToken).toBe(2);
    await expect(harness.repositories.tasks.getById('task-a')).resolves.toMatchObject({ assigneeId: 'agent-2' });
    harness.clock.value = second.lease.expiresAt;
    await expect(harness.broker.expireClaims()).resolves.toEqual([expect.objectContaining({
      claimLeaseId: second.lease.claimLeaseId, taskId: 'task-a', expiredAt: second.lease.expiresAt,
    })]);
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toEqual([]);

    const third = await claimFirst(harness);
    expect(third.lease.fencingToken).toBe(3);
    await expect(harness.broker.renew(authority)).resolves.toMatchObject({
      ok: false, errorCode: 'STALE_AUTHORITY', diagnosticCode: 'TASK_CLAIM_CLAIM_RELEASED',
    });
  });
});

describe('Task Offer prepareOffers 持久化（#712 切片 C-2b-ii server：manifest 持久化 + legacy 兼容）', () => {
  test('manifest-having 候选持久化完整 TaskOffer，wire offerId = 持久化 record.id', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });

    const wireOffers = await harness.broker.prepareOffers('task-a');
    expect(wireOffers).toHaveLength(1);
    const persisted = await harness.repositories.taskCoordination.offers.getById(wireOffers[0]!.offerId);
    expect(persisted).toMatchObject({
      id: wireOffers[0]!.offerId, taskId: 'task-a', agentId: 'agent-1',
      status: 'open', manifestRevision: 1, response: null,
      objective: { requiredCapabilities: ['code-review'], objective: 'objective a' },
    });
  });

  test('legacy 候选（agent.skills 但无 manifest）不持久化，仅内存 wire offer（旧 acquire 兼容）', async () => {
    const harness = await createHarness();
    // legacy：有 agent.skills（fallback 资格）但无 active manifest
    await harness.repositories.agents.upsert({
      id: 'legacy', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'legacy',
      adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online',
      deviceId: 'device-1',
      skills: [{ name: 'code-review', description: 'x', scope: 'user', sourcePath: '/x', adapterKind: 'codex' }],
    });
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['legacy'], updatedAt: 10 } });

    const wireOffers = await harness.broker.prepareOffers('task-a');
    expect(wireOffers).toHaveLength(1);
    // 内存 wire offer 存在（旧 acquire 可用），但无持久化 record（legacy 无法用 respond fence）
    await expect(harness.repositories.taskCoordination.offers.getById(wireOffers[0]!.offerId))
      .resolves.toBeNull();
  });
});

describe('Task Offer publishOffer（#712 切片 C-2b-i：组合+持久化完整 Offer）', () => {  test('从 task/coordination/criteria/manifest 派生并持久化完整 TaskOffer（过渡派生）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const task = await harness.repositories.tasks.getById('task-a');

    const offer = await harness.broker.publishOffer({
      taskId: 'task-a', agentId: 'agent-1', offerTtlMs: 20, hardSpecified: false,
    });

    // AC#1 固定字段：objective/inputs/deliverables/constraints/risk/required Cap+Skill/TTL/fence
    expect(offer).toMatchObject({
      taskId: 'task-a', agentId: 'agent-1', teamId: 'team-1',
      taskRevision: task?.revision, taskAttempt: 1, manifestRevision: 1,
      offerTtlMs: 20, hardSpecified: false, status: 'open', response: null,
      objective: {
        objective: 'objective a', // ← task.description（过渡；decision 结构化 objective 属后续切片）
        inputs: [], // 过渡空（decision 未携带）
        deliverables: ['并发唯一'], // ← acceptance criteria 派生
        constraints: [], // 过渡空
        riskLevel: 'low', // 过渡默认（decision.riskLevel 未接入）
        requiredCapabilities: ['code-review'],
        requiredSkills: [], preferredSkills: [],
      },
    });
    expect(offer.offerExpiresAt).toBe(offer.createdAt + 20);
    // 持久化：可经 offers 仓库取回（respondToOrder 的 substrate）
    await expect(harness.repositories.taskCoordination.offers.getById(offer.id))
      .resolves.toMatchObject({ id: offer.id, status: 'open', agentId: 'agent-1' });
  });

  test('coordination.preferredSkills 进入 offer objective（#725 F3 排序输入）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    // harness 的 task-a 未声明 preferredSkills（对照组 []）；task-c 声明后须一路到达 objective。
    await harness.coordination.createSubtasks({ authority: harness.authority,
      idempotencyKey: 'subtasks-preferred', parentTaskId: 'root-task',
      subtasks: [{ taskId: 'task-c', clientKey: 'c', title: 'Task C', description: 'objective c',
        claimPolicy: 'open', requiredCapabilities: ['code-review'], preferredSkills: ['rust'],
        acceptanceCriteria: [{ id: 'criterion-c', description: 'C accepted', evidenceRequired: false }],
        maxAttempts: 3 }] });

    const offer = await harness.broker.publishOffer({
      taskId: 'task-c', agentId: 'agent-1', offerTtlMs: 20, hardSpecified: false,
    });

    expect(offer.objective.preferredSkills).toEqual(['rust']);
    const persisted = await harness.repositories.taskCoordination.offers.getById(offer.id);
    expect(persisted?.objective.preferredSkills).toEqual(['rust']);
  });

  test('显式指派的子 Task 经 allocation 服务发布后保留 assigneeId（#807 端到端）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    await harness.coordination.createSubtasks({ authority: harness.authority,
      idempotencyKey: 'subtasks-targeted', parentTaskId: 'root-task',
      subtasks: [{ taskId: 'task-t', clientKey: 't', title: 'Task T', description: 'objective t',
        claimPolicy: 'targeted', targetAgentId: 'agent-1', requiredCapabilities: ['code-review'],
        acceptanceCriteria: [{ id: 'criterion-t', description: 'T accepted', evidenceRequired: false }],
        maxAttempts: 3 }] });
    // 拆解时 assigneeId 已落库
    await expect(harness.repositories.tasks.getById('task-t'))
      .resolves.toMatchObject({ assigneeId: 'agent-1' });

    const allocation = await resolveTaskAllocation({
      taskId: 'task-t', broker: harness.broker, repositories: harness.repositories,
    });
    expect(allocation).toEqual({ claimPolicy: 'targeted', targetAgentId: 'agent-1' });

    const before = await harness.repositories.tasks.getById('task-t');
    await harness.coordination.publishForClaim({ authority: harness.authority,
      idempotencyKey: 'publish-t', taskId: 'task-t', expectedTaskRevision: before!.revision,
      ...(allocation ? { allocation } : {}) });

    // 发布后仍是 targeted 且 assigneeId 未被清空——未接线时此处会被强转 open 并清空
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId('task-t'))
      .resolves.toMatchObject({ claimPolicy: 'targeted' });
    await expect(harness.repositories.tasks.getById('task-t'))
      .resolves.toMatchObject({ assigneeId: 'agent-1' });
  });

  test('无显式指派 + 唯一合格候选 → open 修订为 targeted 并写入 assigneeId（#807 AC）', async () => {
    // 回归防线：kernel 若只覆写 claimPolicy 而不落 allocation.targetAgentId，
    // 会产出「targeted 且无 assignee」的非法状态，publish 直接抛
    // TASK_REVISION_INVALID_SEMANTIC_STATE —— 这会打断所有恰好只有 1 个合格候选的普通任务。
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    // harness 的 task-a 是 open + 无 assignee，此处只有 agent-1 一个合格候选
    const allocation = await resolveTaskAllocation({
      taskId: 'task-a', broker: harness.broker, repositories: harness.repositories,
    });
    expect(allocation).toEqual({ claimPolicy: 'targeted', targetAgentId: 'agent-1' });

    const before = await harness.repositories.tasks.getById('task-a');
    await expect(harness.coordination.publishForClaim({ authority: harness.authority,
      idempotencyKey: 'publish-single', taskId: 'task-a', expectedTaskRevision: before!.revision,
      ...(allocation ? { allocation } : {}) })).resolves.toMatchObject({ status: 'todo' });

    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId('task-a'))
      .resolves.toMatchObject({ claimPolicy: 'targeted' });
    await expect(harness.repositories.tasks.getById('task-a'))
      .resolves.toMatchObject({ assigneeId: 'agent-1' });
  });

  test('hardSpecified=true 透传（显式 @Agent，AC#8 仅元数据）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const offer = await harness.broker.publishOffer({
      taskId: 'task-a', agentId: 'agent-1', offerTtlMs: 20, hardSpecified: true,
    });
    expect(offer.hardSpecified).toBe(true);
  });

  test('agent 无 active manifest → 拒绝发布（不向无公开契约的 agent 发 offer）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', []); // 无 manifest
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    await expect(harness.broker.publishOffer({
      taskId: 'task-a', agentId: 'agent-1', offerTtlMs: 20, hardSpecified: false,
    })).rejects.toThrow();
  });
});

describe('Task Offer respondToOffer（#712 切片 C-1：显式接受事务接线）', () => {
  test('accepted 在同事务创建 Claim/Lease：offer=accepted + lease 存在 + task in_progress (AC#4)', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const offer = await publishOffer(harness, 'agent-1');

    const result = await harness.broker.respondToOffer({
      offerId: offer.id, agentId: 'agent-1', kind: 'accepted',
    });
    expect(result.kind).toBe('claim_granted');
    // AC#4 同事务：offer 与 lease 同生
    await expect(harness.repositories.taskCoordination.offers.getById(offer.id))
      .resolves.toMatchObject({ status: 'accepted', response: { kind: 'accepted' } });
    const leases = await harness.repositories.taskCoordination.claimLeases.listActive();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ agentId: 'agent-1', status: 'active', fencingToken: 1 });
    await expect(harness.repositories.tasks.getById('task-a')).resolves.toMatchObject({
      status: 'in_progress', assigneeId: 'agent-1',
    });
  });

  test('rejected/needs_info/counter_proposed 记录响应但不创 Lease (AC#5)', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });

    for (const kind of ['rejected', 'needs_info', 'counter_proposed'] as const) {
      const offer = await publishOffer(harness, 'agent-1', { id: `offer-${kind}` });
      const result = await harness.broker.respondToOffer({
        offerId: offer.id, agentId: 'agent-1', kind, detail: 'reason',
      });
      expect(result.kind).toBe('response_recorded');
      await expect(harness.repositories.taskCoordination.offers.getById(offer.id))
        .resolves.toMatchObject({ status: kind, response: { kind, detail: 'reason' } });
    }
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toEqual([]);
  });

  test('同一 open offer 重复 accepted 不产生第二个 Claim（幂等/单赢家不变量）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const offer = await publishOffer(harness, 'agent-1');

    const first = await harness.broker.respondToOffer({ offerId: offer.id, agentId: 'agent-1', kind: 'accepted' });
    const second = await harness.broker.respondToOffer({ offerId: offer.id, agentId: 'agent-1', kind: 'accepted' });
    expect(first.kind).toBe('claim_granted');
    expect(second.kind).not.toBe('claim_granted');
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toHaveLength(1);
  });

  test('并发：同一 task 的两个 agent offer 各自 accepted，仅一个获 Claim，另一个 overtaken (AC#6)', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await seedAgent(harness.repositories, 'agent-2', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1', 'agent-2'], updatedAt: 10 } });
    const o1 = await publishOffer(harness, 'agent-1');
    const o2 = await publishOffer(harness, 'agent-2');

    const r1 = await harness.broker.respondToOffer({ offerId: o1.id, agentId: 'agent-1', kind: 'accepted' });
    const r2 = await harness.broker.respondToOffer({ offerId: o2.id, agentId: 'agent-2', kind: 'accepted' });
    const granted = [r1, r2].filter((r) => r.kind === 'claim_granted');
    const overtaken = [r1, r2].filter((r) => r.kind === 'overtaken');
    expect(granted).toHaveLength(1);
    expect(overtaken).toHaveLength(1);
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toHaveLength(1);
  });

  test('accepted 但 Offer 已过期 → not_accepted，不创 Lease (AC#5)', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const offer = await publishOffer(harness, 'agent-1'); // offerExpiresAt = clock+20 = 30
    harness.clock.value = 31; // 过期

    const result = await harness.broker.respondToOffer({ offerId: offer.id, agentId: 'agent-1', kind: 'accepted' });
    expect(result.kind).toBe('not_accepted');
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toEqual([]);
  });

  test('accepted 但 task revision 已变 → not_accepted(invalidated)，不创 Lease (AC#1/#5 fence)', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const offer = await publishOffer(harness, 'agent-1'); // taskRevision 冻结为当前值
    // 推进 task revision（#709 append-only）
    await harness.repositories.tasks.updateAtRevision({
      taskId: 'task-a', expectedRevision: offer.taskRevision, nextRevision: offer.taskRevision + 1,
      reasonCode: 'TASK_REVISED', changes: { title: 'revised', updatedAt: harness.clock.value },
    });

    const result = await harness.broker.respondToOffer({ offerId: offer.id, agentId: 'agent-1', kind: 'accepted' });
    expect(result.kind).toBe('not_accepted');
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toEqual([]);
  });

  test('accepted 但候选不合格（capability 缺失）→ not_accepted(agent_not_qualified)，不创 Lease', async () => {
    const harness = await createHarness();
    // agent 无 exposure manifest → CAPABILITY_MISSING
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', []);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const offer = await publishOffer(harness, 'agent-1');

    const result = await harness.broker.respondToOffer({ offerId: offer.id, agentId: 'agent-1', kind: 'accepted' });
    expect(result.kind).toBe('not_accepted');
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toEqual([]);
  });
});

describe('#947 PR1：@Agent 硬指定 Offer 路由 + Requirement-confirmation Offer（ADR-0064 §3）', () => {
  type Harness = Awaited<ReturnType<typeof createHarness>>;
  async function seedTargetedTask(
    harness: Harness, taskId: string, targetAgentId: string, requiredCapabilities = ['code-review'],
  ) {
    await harness.coordination.createSubtasks({ authority: harness.authority,
      idempotencyKey: `subtasks-${taskId}`, parentTaskId: 'root-task',
      subtasks: [{ taskId, clientKey: taskId, title: taskId, description: `objective ${taskId}`,
        claimPolicy: 'targeted', targetAgentId, requiredCapabilities,
        acceptanceCriteria: [{ id: `criterion-${taskId}`, description: `${taskId} accepted`, evidenceRequired: false }],
        maxAttempts: 3 }] });
  }

  test('targeted + 合格目标（active manifest 覆盖）→ 正常定向 wire Offer（AC1）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    await seedTargetedTask(harness, 'task-t1', 'agent-1');

    const wireOffers = await harness.broker.prepareOffers('task-t1');
    expect(wireOffers).toHaveLength(1);
    expect(wireOffers[0]!.agentId).toBe('agent-1');
    const persisted = await harness.repositories.taskCoordination.offers.listByTask('task-t1');
    expect(persisted[0]).toMatchObject({
      requirementConfirmation: false, hardSpecified: true, manifestRevision: 1, status: 'open',
    });
  });

  test('targeted + 无 active manifest（required requirement unknown）→ Requirement-confirmation Offer 持久化，不下发 wire（AC2）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', []); // 空 capability → 无 manifest
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    await seedTargetedTask(harness, 'task-t2', 'agent-1');

    const wireOffers = await harness.broker.prepareOffers('task-t2');
    expect(wireOffers).toEqual([]); // 确认 Offer 不下发设备（不可执行）
    const persisted = await harness.repositories.taskCoordination.offers.listByTask('task-t2');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      requirementConfirmation: true, hardSpecified: true, manifestRevision: 0, status: 'open', agentId: 'agent-1',
    });
  });

  test('targeted + active manifest 明确缺失硬门槛（not_qualified = 明确不满足事实）→ 不发 Offer', async () => {
    const harness = await createHarness();
    // manifest 声明 other-cap，task 要求 code-review → 当前 manifest 明确不满足（非 unknown）
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['other-cap']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    await seedTargetedTask(harness, 'task-t3', 'agent-1');

    expect(await harness.broker.prepareOffers('task-t3')).toEqual([]);
    expect(await harness.repositories.taskCoordination.offers.listByTask('task-t3')).toEqual([]);
  });

  test('targeted + 不可覆盖硬门槛失败（设备离线）→ 不发 Offer', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-2', 'online', []); // device-2 离线
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    await seedTargetedTask(harness, 'task-t4', 'agent-1');

    expect(await harness.broker.prepareOffers('task-t4')).toEqual([]);
    expect(await harness.repositories.taskCoordination.offers.listByTask('task-t4')).toEqual([]);
  });

  test('publishOffer 发布复验：requirementConfirmation 但已有 active manifest → 拒绝（不再 unknown）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    await expect(harness.broker.publishOffer({
      taskId: 'task-a', agentId: 'agent-1', offerTtlMs: 20, hardSpecified: true, requirementConfirmation: true,
    })).rejects.toThrow('TASK_CLAIM_REQUIREMENT_CONFIRMATION_INVALID');
  });

  test('respondToOffer：确认 Offer accepted fail-closed（不产 Claim）；rejected 仍可记录（不当作 eligible）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    // 直接持久化确认 Offer（模拟 prepareOffers confirmation 分支产物；manifestRevision=1 使 validity 可接受）
    const confirmation = await publishOffer(harness, 'agent-1',
      { requirementConfirmation: true, hardSpecified: true });

    const accepted = await harness.broker.respondToOffer({
      offerId: confirmation.id, agentId: 'agent-1', kind: 'accepted',
    });
    expect(accepted).toMatchObject({
      kind: 'not_accepted', diagnosticCode: 'TASK_CLAIM_REQUIREMENT_ATTESTATION_REQUIRED',
    });
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toEqual([]);

    // decline 路径对确认 Offer 仍生效（显式 @Agent 不强迫接受，被点名 Agent 可拒绝）
    const confirmation2 = await publishOffer(harness, 'agent-1',
      { requirementConfirmation: true, hardSpecified: true, id: 'offer-conf-2' });
    const rejected = await harness.broker.respondToOffer({
      offerId: confirmation2.id, agentId: 'agent-1', kind: 'rejected',
    });
    expect(rejected).toMatchObject({ kind: 'response_recorded', status: 'rejected' });
  });
});

describe('#947 PR2：Requirement-confirmation Offer attestation 解除 fail-closed（ADR-0064 §3 AC3）', () => {
  // 确认 Offer fixture：manifestRevision=0（生产 confirm 无 active manifest），hardSpecified=true。
  const confirmationOver = { requirementConfirmation: true, hardSpecified: true, manifestRevision: 0 } as const;

  test('确认 Offer + 有效 attestation（覆盖 required）→ claim_granted（解除 fail-closed）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', []); // 无 manifest（unknown）
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const confirmation = await publishOffer(harness, 'agent-1', confirmationOver);

    const result = await harness.broker.respondToOffer({
      offerId: confirmation.id, agentId: 'agent-1', kind: 'accepted',
      attestation: { attestedCapabilities: ['code-review'], attestedSkills: [] },
    });
    expect(result).toMatchObject({ kind: 'claim_granted' });
    // 持久化的 response 应携带 attestation（form A 审计）
    const persisted = await harness.repositories.taskCoordination.offers.getById(confirmation.id);
    expect(persisted?.response?.attestation).toEqual({ attestedCapabilities: ['code-review'], attestedSkills: [] });
  });

  test('确认 Offer + 缺 attestation → fail-closed 维持（REQUIREMENT_ATTESTATION_REQUIRED）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', []);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const confirmation = await publishOffer(harness, 'agent-1', confirmationOver);

    const result = await harness.broker.respondToOffer({
      offerId: confirmation.id, agentId: 'agent-1', kind: 'accepted',
    });
    expect(result).toMatchObject({
      kind: 'not_accepted', diagnosticCode: 'TASK_CLAIM_REQUIREMENT_ATTESTATION_REQUIRED',
    });
    expect(await harness.repositories.taskCoordination.claimLeases.listActive()).toEqual([]);
  });

  test('确认 Offer + attestation 不覆盖 required → ATTESTATION_INCOMPLETE', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', []);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const confirmation = await publishOffer(harness, 'agent-1', confirmationOver);

    const result = await harness.broker.respondToOffer({
      offerId: confirmation.id, agentId: 'agent-1', kind: 'accepted',
      attestation: { attestedCapabilities: ['other-cap'], attestedSkills: [] },
    });
    expect(result).toMatchObject({
      kind: 'not_accepted', diagnosticCode: 'TASK_CLAIM_ATTESTATION_INCOMPLETE',
    });
  });

  test('确认 Offer + 有效 attestation 但硬门槛失败（设备离线）→ agent_not_qualified', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-2', 'online', []); // device-2 offline
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    const confirmation = await publishOffer(harness, 'agent-1', confirmationOver);

    const result = await harness.broker.respondToOffer({
      offerId: confirmation.id, agentId: 'agent-1', kind: 'accepted',
      attestation: { attestedCapabilities: ['code-review'], attestedSkills: [] },
    });
    expect(result).toMatchObject({ kind: 'not_accepted', reason: 'agent_not_qualified' });
  });
});

async function publishOffer(
  harness: Awaited<ReturnType<typeof createHarness>>,
  agentId: string,
  over: Partial<import('../src/application/task-coordination-repositories.js').TaskOfferRecord> = {},
) {
  const task = await harness.repositories.tasks.getById('task-a');
  const coordination = await harness.repositories.taskCoordination.coordinations.getByTaskId('task-a');
  return harness.broker.createOffer({
    id: `offer-${agentId}`, teamId: 'team-1', taskId: 'task-a', agentId,
    taskRevision: task!.revision, taskAttempt: coordination!.attempt, manifestRevision: 1,
    objective: { objective: 'objective a', inputs: [], deliverables: [], constraints: [],
      riskLevel: 'low' as const, requiredCapabilities: ['code-review'], requiredSkills: [], preferredSkills: [] },
    offerTtlMs: 20, offerExpiresAt: harness.clock.value + 20, hardSpecified: false,
    requirementConfirmation: false,
    status: 'open', response: null,
    createdAt: harness.clock.value, updatedAt: harness.clock.value,
    ...over,
  });
}

describe('#948-F allocation_blocked（ADR-0064：无合格候选 → 结构化脱敏建议）', () => {
  test('频道外有 agent 可胜任 → allocation-blocked 携带脱敏 external-capability 建议（不泄露身份）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    // agent-1 具备 task-a 所需 'code-review'，但未加入 channel-1（频道外）→ 无合格候选。
    const offers = await harness.broker.prepareOffers('task-a');
    expect(offers).toEqual([]);
    const blocked = (await harness.repositories.management.events.list('run-1'))
      .find((record) => record.event.type === 'allocation-blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.event.payload).toMatchObject({ taskId: 'task-a', cause: 'no_qualified_candidate',
      suggestionKind: 'escalate_external_capability', externalAgentCount: 1 });
    // 脱敏不变量：payload 绝不含 agent 身份。
    expect(JSON.stringify(blocked!.event.payload)).not.toMatch(/agent-1|agentId/i);
  });

  test('频道内外都无所需能力 → escalate_no_capability', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['other-capability']);
    // agent-1 缺 'code-review'（频道外且无能力）→ 频道内外都无人可胜任。
    await harness.broker.prepareOffers('task-a');
    const blocked = (await harness.repositories.management.events.list('run-1'))
      .find((record) => record.event.type === 'allocation-blocked');
    expect(blocked!.event.payload).toMatchObject({ suggestionKind: 'escalate_no_capability' });
    expect(blocked!.event.payload).not.toHaveProperty('externalAgentCount');
  });

  test('重复 prepareOffers 不重复记录 allocation-blocked（幂等）', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.broker.prepareOffers('task-a');
    await harness.broker.prepareOffers('task-a');
    const blocked = (await harness.repositories.management.events.list('run-1'))
      .filter((record) => record.event.type === 'allocation-blocked');
    expect(blocked).toHaveLength(1);
  });
});

describe('#948-B ADR-0064：Offer 原子发布 + acquire 持久化兜底', () => {
  test('prepareOffers 优先读持久化 offer（open + 未过期）→ 构建 StoredOffer + emit', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    // 模拟 kernel 直接创建持久化 offer（绕开 broker publishOffer 的 manifest gate）。
    await harness.repositories.taskCoordination.offers.create({
      id: 'persisted-offer-1', teamId: 'team-1', taskId: 'task-a', agentId: 'agent-1',
      taskRevision: 1, taskAttempt: 1, manifestRevision: 0,
      objective: {
        objective: 'test objective', inputs: [], deliverables: ['criteria'],
        constraints: [], riskLevel: 'low',
        requiredCapabilities: ['code-review'], requiredSkills: [], preferredSkills: [],
      },
      offerTtlMs: 20, offerExpiresAt: 30, hardSpecified: false,
      requirementConfirmation: false, status: 'open', response: null,
      createdAt: 10, updatedAt: 10,
    });
    // clock=10, offerExpiresAt=30 → 未过期。
    const offers = await harness.broker.prepareOffers('task-a');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ offerId: 'persisted-offer-1', agentId: 'agent-1' });
  });

  test('prepareOffers 跳过已过期持久化 offer → fallback legacy 创建', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    // 过期 offer（expiresAt=5 < clock=10）。
    await harness.repositories.taskCoordination.offers.create({
      id: 'expired-offer', teamId: 'team-1', taskId: 'task-a', agentId: 'agent-1',
      taskRevision: 1, taskAttempt: 1, manifestRevision: 0,
      objective: {
        objective: 'test objective', inputs: [], deliverables: ['criteria'],
        constraints: [], riskLevel: 'low',
        requiredCapabilities: ['code-review'], requiredSkills: [], preferredSkills: [],
      },
      offerTtlMs: 20, offerExpiresAt: 5, hardSpecified: false,
      requirementConfirmation: false, status: 'open', response: null,
      createdAt: 10, updatedAt: 10,
    });
    const offers = await harness.broker.prepareOffers('task-a');
    // 过期 offer 被跳过 → fallback 到 legacy 创建路径（memory-only，因无 active manifest）。
    // legacy 路径仍 create 一个内存 StoredOffer（manifestRevision=0 fallback）。
    expect(offers).toHaveLength(1);
    expect(offers[0].offerId).not.toBe('expired-offer');
  });

  test('acquire Map miss → 持久化兜底成功', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    await harness.repositories.channels.update({ channelId: 'channel-1',
      changes: { agentMemberIds: ['agent-1'], updatedAt: 10 } });
    // 直接创建持久化 offer（不在 memory Map 中）。
    await harness.repositories.taskCoordination.offers.create({
      id: 'direct-offer', teamId: 'team-1', taskId: 'task-a', agentId: 'agent-1',
      taskRevision: 1, taskAttempt: 1, manifestRevision: 0,
      objective: {
        objective: 'test objective', inputs: [], deliverables: ['criteria'],
        constraints: [], riskLevel: 'low',
        requiredCapabilities: ['code-review'], requiredSkills: [], preferredSkills: [],
      },
      offerTtlMs: 100, offerExpiresAt: 110, hardSpecified: false,
      requirementConfirmation: false, status: 'open', response: null,
      createdAt: 10, updatedAt: 10,
    });
    // acquire 直接调——Map miss → 持久化 fallback → 重算 ancestorAgentIds + projectStageAuto。
    const result = await harness.broker.acquire({
      schemaVersion: 1, offerId: 'direct-offer', agentId: 'agent-1',
    });
    expect(result.ok).toBe(true);
    const granted = result as Extract<TaskClaimAcquireAckV1, { ok: true }>;
    expect(granted.lease).toMatchObject({ agentId: 'agent-1', taskId: 'task-a' });
  });

  test('acquire Map miss + 持久化 offer 已过期 → INVALID', async () => {
    const harness = await createHarness();
    await seedAgent(harness.repositories, 'agent-1', 'device-1', 'online', ['code-review']);
    // 过期 offer。
    await harness.repositories.taskCoordination.offers.create({
      id: 'expired-direct', teamId: 'team-1', taskId: 'task-a', agentId: 'agent-1',
      taskRevision: 1, taskAttempt: 1, manifestRevision: 0,
      objective: {
        objective: 'test objective', inputs: [], deliverables: ['criteria'],
        constraints: [], riskLevel: 'low',
        requiredCapabilities: ['code-review'], requiredSkills: [], preferredSkills: [],
      },
      offerTtlMs: 20, offerExpiresAt: 5, hardSpecified: false,
      requirementConfirmation: false, status: 'open', response: null,
      createdAt: 10, updatedAt: 10,
    });
    const result = await harness.broker.acquire({
      schemaVersion: 1, offerId: 'expired-direct', agentId: 'agent-1',
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ errorCode: 'UNAVAILABLE', diagnosticCode: 'TASK_CLAIM_OFFER_EXPIRED' });
  });
});

async function createHarness(options: { offerTtlMs?: number; leaseTtlMs?: number } = {}) {
  const repositories = createInMemoryRepositories();
  const clock = { value: 10 };
  let id = 0;
  const kernelIds = { nextId: () => id++ === 0 ? 'run-1' : `kernel-${id}` };
  await repositories.users.create({
    id: 'user-1',
    username: 'user-1',
    passwordHash: 'hash',
    role: 'user',
    createdAt: 1,
    updatedAt: 1,
  });
  await repositories.teams.create({
    id: 'team-1',
    name: 'Team',
    path: 'team-1',
    visibility: 'private',
    ownerId: 'user-1',
    createdAt: 1,
  });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel',
    name: 'private', visibility: 'private', createdBy: 'user-1', humanMemberIds: ['user-1'],
    agentMemberIds: [], createdAt: 1, updatedAt: 1 });
  await repositories.devices.upsertHello(device('device-1', 'online'));
  await repositories.devices.upsertHello(device('device-2', 'offline'));
  await repositories.tasks.create({ id: 'root-task', teamId: 'team-1', title: 'Root',
    description: 'root objective', status: 'todo', creatorId: 'user-1', channelId: 'channel-1',
    tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 });
  const management = createManagementKernel({ repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork, clock: { now: () => clock.value }, ids: kernelIds });
  await management.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'root-task',
    rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'request-hash',
    placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
  await management.acquireLease({ managementRunId: 'run-1', workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'manager-token', ttlMs: 1_000 });
  const coordination = createTaskCoordinationKernel({ unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock: { now: () => clock.value }, ids: kernelIds });
  const authority = { managementRunId: 'run-1', workerId: 'worker-1', leaseToken: 'manager-token', fencingToken: 1 };
  await coordination.createRootCoordination({ authority, idempotencyKey: 'root', taskId: 'root-task',
    claimPolicy: 'open', requiredCapabilities: [], acceptanceCriteria: [], maxAttempts: 3 });
  await coordination.createSubtasks({ authority, idempotencyKey: 'subtasks', parentTaskId: 'root-task',
    subtasks: [{ taskId: 'task-a', clientKey: 'a', title: 'Task A', description: 'objective a',
      claimPolicy: 'open', requiredCapabilities: ['code-review'],
      acceptanceCriteria: [{ id: 'criterion-a', description: '并发唯一', evidenceRequired: true }], maxAttempts: 3 }] });
  let brokerId = 0;
  let tokenId = 0;
  const broker = createTaskClaimBroker({ repositories, clock: { now: () => clock.value },
    ids: { nextId: () => `broker-${++brokerId}` },
    leaseTokens: { nextToken: () => `raw-token-${++tokenId}` },
    offerTtlMs: options.offerTtlMs ?? 20, leaseTtlMs: options.leaseTtlMs ?? 100,
    piHealthy: async () => true });
  return { repositories, clock, broker, coordination, authority };
}

async function seedAgent(
  repositories: ServerNextRepositories,
  id: string,
  deviceId: string,
  status: 'online' | 'busy',
  capabilities: string[],
  visibleTeamIds = ['team-1'],
) {
  await repositories.agents.upsert({ id, primaryTeamId: 'team-1', visibleTeamIds, name: id,
    adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status, deviceId });
  // #710：候选硬过滤的能力来自 Team Agent Exposure active manifest（取代 agent.skills）。
  // 无 manifest（如 missing-capability）→ 无公开能力 → CAPABILITY_MISSING。
  if (capabilities.length > 0) {
    await repositories.agentExposure.manifests.create({
      id: `manifest-${id}`, teamId: 'team-1', agentId: id, revision: 1, status: 'active',
      capabilities: capabilities.map((name) => ({ name, description: name })),
      skills: [], constraints: [], availability: { status: 'available' },
      validFrom: 0, validUntil: null, createdBy: 'user-1', now: 0,
    });
  }
}

async function seedProjectStageEdge(
  repositories: ServerNextRepositories,
  canonicalAcceptance = true,
) {
  if (canonicalAcceptance) {
    await repositories.taskCoordination.claimLeases.create({
      id: 'claim-stage-829',
      teamId: 'team-1',
      taskId: 'root-task',
      taskRevision: 1,
      taskAttempt: 1,
      agentId: 'eligible',
      leaseTokenHash: 'lease-token-hash',
      leaseFingerprint: 'lease-fingerprint',
      fencingToken: 1,
      status: 'active',
      acquiredAt: 1,
      heartbeatAt: 1,
      expiresAt: 1_000,
    });
    await repositories.taskCoordination.deliveries.create({
      schemaVersion: 1,
      id: 'delivery-stage-829',
      teamId: 'team-1',
      taskId: 'root-task',
      taskRevision: 1,
      taskAttempt: 1,
      claimLeaseId: 'claim-stage-829',
      invocationId: 'invocation-stage-829',
      summary: '上游阶段已交付',
      claims: [],
      evidenceRefs: [],
      idempotencyKey: 'delivery-stage-829',
      createdAt: 3,
    });
    await repositories.taskCoordination.acceptances.create({
      schemaVersion: 1,
      id: 'acceptance-stage-829',
      teamId: 'team-1',
      taskId: 'root-task',
      deliveryId: 'delivery-stage-829',
      expectedTaskRevision: 1,
      taskAttempt: 1,
      claimLeaseId: 'claim-stage-829',
      decision: 'accepted',
      criteriaResults: [],
      reason: '人审通过',
      decidedBy: 'manager',
      decidedAt: 3,
      decisionVersion: 1,
      canonical: true,
    });
    await repositories.taskCoordination.claimLeases.update({
      id: 'claim-stage-829',
      expectedStatus: 'active',
      status: 'released',
      heartbeatAt: 1,
      expiresAt: 1_000,
      releasedAt: 3,
    });
  }
  const profile = {
    id: 'profile-829',
    teamId: 'team-1',
    channelId: 'channel-1',
    projectLeadId: 'user-1',
    defaultReviewerIds: ['user-1'],
    revision: 1,
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
  };
  const upstream = {
    id: 'stage-upstream-829',
    teamId: 'team-1',
    channelId: 'channel-1',
    taskId: 'root-task',
    taskRevision: 1,
    name: '上游',
    goal: '完成上游',
    ownerId: 'user-1',
    reviewerIds: ['user-1'],
    acceptanceCriteria: ['完成'],
    createdAt: 1,
    updatedAt: 1,
  };
  await repositories.channelProjects.createInitialStage({
    expectedRevision: 0,
    profile,
    stage: upstream,
    mutation: {
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'stage-upstream-829',
      requestFingerprint: 'stage-upstream-829',
      profileId: profile.id,
      stageId: upstream.id,
      resultRevision: 1,
      resultOverview: {} as never,
      createdAt: 1,
    },
  });
  const downstream = {
    ...upstream,
    id: 'stage-downstream-829',
    taskId: 'task-a',
    name: '下游',
    goal: '消费上游结果',
    createdAt: 2,
    updatedAt: 2,
  };
  await repositories.channelProjects.createStage({
    expectedRevision: 1,
    nextRevision: 2,
    updatedAt: 2,
    stage: downstream,
    mutation: {
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'stage-downstream-829',
      requestFingerprint: 'stage-downstream-829',
      profileId: profile.id,
      stageId: downstream.id,
      resultRevision: 2,
      resultOverview: {} as never,
      createdAt: 2,
    },
  });
  await repositories.artifacts.create({
    id: 'artifact-stage-829-final',
    teamId: 'team-1',
    channelId: 'channel-1',
    uploaderId: 'user-1',
    filename: 'upstream-final.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 8,
    sha256: 'sha256-stage-829-final',
    createdAt: 4,
  });
  await repositories.channelProjects.promoteArtifact({
    teamId: 'team-1',
    channelId: 'channel-1',
    createsCollection: true,
    collection: {
      id: 'collection-stage-829', teamId: 'team-1', channelId: 'channel-1',
      name: '上游最终产物', kind: 'file', revision: 1,
      currentVersionId: 'version-stage-829-final', versionCount: 1,
      createdBy: 'user-1', createdAt: 4, updatedAt: 4,
    },
    version: {
      id: 'version-stage-829-final', teamId: 'team-1', channelId: 'channel-1',
      collectionId: 'collection-stage-829', versionNumber: 1,
      artifactId: 'artifact-stage-829-final', stageId: upstream.id,
      taskId: upstream.taskId, taskRevision: upstream.taskRevision, lineage: [],
      promotedBy: 'user-1', createdAt: 4,
    },
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'promote-stage-829-final',
      requestFingerprint: 'promote-stage-829-final', collectionId: 'collection-stage-829',
      versionId: 'version-stage-829-final', createdAt: 4,
    },
  });
  await repositories.channelProjects.appendArtifactReview({
    review: {
      id: 'review-stage-829-final', teamId: 'team-1', channelId: 'channel-1',
      collectionId: 'collection-stage-829', versionId: 'version-stage-829-final',
      stageId: upstream.id, decision: 'approved', comment: '通过', basis: [],
      reviewedBy: 'user-1', createdAt: 5,
    },
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'review-stage-829-final',
      requestFingerprint: 'review-stage-829-final', action: 'review',
      collectionId: 'collection-stage-829', versionId: 'version-stage-829-final',
      resultId: 'review-stage-829-final', createdAt: 5,
    },
  });
  await repositories.channelProjects.setArtifactFinalVersion({
    teamId: 'team-1', channelId: 'channel-1', collectionId: 'collection-stage-829',
    expectedCollectionRevision: 1, nextRevision: 2, updatedAt: 6,
    finalization: {
      id: 'finalization-stage-829-final', teamId: 'team-1', channelId: 'channel-1',
      collectionId: 'collection-stage-829', versionId: 'version-stage-829-final',
      basisReviewId: 'review-stage-829-final', actorKind: 'human', finalizedBy: 'user-1', createdAt: 6,
    },
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'finalize-stage-829-final',
      requestFingerprint: 'finalize-stage-829-final', action: 'finalize',
      collectionId: 'collection-stage-829', versionId: 'version-stage-829-final',
      resultId: 'finalization-stage-829-final', createdAt: 6,
    },
  });
  await repositories.channelProjects.createStageEdge({
    expectedRevision: 2,
    nextRevision: 3,
    updatedAt: 3,
    edge: {
      id: 'edge-829',
      teamId: 'team-1',
      channelId: 'channel-1',
      upstreamStageId: upstream.id,
      downstreamStageId: downstream.id,
      upstreamTaskId: upstream.taskId,
      upstreamTaskRevision: upstream.taskRevision,
      downstreamTaskId: downstream.taskId,
      downstreamTaskRevision: downstream.taskRevision,
      semantics: 'blocks_start',
      requiredInputs: [{
        key: 'upstream-final',
        kind: 'artifact',
        label: '上游最终产物',
        source: {
          kind: 'artifact_collection',
          collectionId: 'collection-stage-829',
          versionPolicy: 'final',
        },
      }],
      mirroredTaskDependency: false,
      createdBy: 'user-1',
      createdAt: 3,
      updatedAt: 3,
    },
    mutation: {
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'edge-829',
      requestFingerprint: 'edge-829',
      profileId: profile.id,
      stageId: downstream.id,
      resultRevision: 3,
      resultOverview: {} as never,
      createdAt: 3,
    },
  });
}

async function promoteReplacementStageArtifact(repositories: ServerNextRepositories) {
  await repositories.artifacts.create({
    id: 'artifact-stage-829-replacement',
    teamId: 'team-1',
    channelId: 'channel-1',
    uploaderId: 'user-1',
    filename: 'upstream-replacement.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 9,
    sha256: 'sha256-stage-829-replacement',
    createdAt: 7,
  });
  await repositories.channelProjects.promoteArtifact({
    teamId: 'team-1',
    channelId: 'channel-1',
    expectedCollectionRevision: 2,
    createsCollection: false,
    collection: {
      id: 'collection-stage-829',
      teamId: 'team-1',
      channelId: 'channel-1',
      name: '上游最终产物',
      kind: 'file',
      revision: 3,
      currentVersionId: 'version-stage-829-replacement',
      versionCount: 2,
      createdBy: 'user-1',
      createdAt: 4,
      updatedAt: 7,
    },
    version: {
      id: 'version-stage-829-replacement',
      teamId: 'team-1',
      channelId: 'channel-1',
      collectionId: 'collection-stage-829',
      versionNumber: 2,
      artifactId: 'artifact-stage-829-replacement',
      stageId: 'stage-upstream-829',
      taskId: 'root-task',
      taskRevision: 1,
      lineage: [],
      promotedBy: 'user-1',
      createdAt: 7,
    },
    mutation: {
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'promote-stage-829-replacement',
      requestFingerprint: 'promote-stage-829-replacement',
      collectionId: 'collection-stage-829',
      versionId: 'version-stage-829-replacement',
      createdAt: 7,
    },
  });
  await repositories.channelProjects.appendArtifactReview({
    review: {
      id: 'review-stage-829-replacement',
      teamId: 'team-1',
      channelId: 'channel-1',
      collectionId: 'collection-stage-829',
      versionId: 'version-stage-829-replacement',
      stageId: 'stage-upstream-829',
      decision: 'approved',
      comment: '替换版本通过',
      basis: [],
      reviewedBy: 'user-1',
      createdAt: 8,
    },
    mutation: {
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'review-stage-829-replacement',
      requestFingerprint: 'review-stage-829-replacement',
      action: 'review',
      collectionId: 'collection-stage-829',
      versionId: 'version-stage-829-replacement',
      resultId: 'review-stage-829-replacement',
      createdAt: 8,
    },
  });
  await repositories.channelProjects.setArtifactFinalVersion({
    teamId: 'team-1',
    channelId: 'channel-1',
    collectionId: 'collection-stage-829',
    expectedCollectionRevision: 3,
    nextRevision: 4,
    updatedAt: 9,
    finalization: {
      id: 'finalization-stage-829-replacement',
      teamId: 'team-1',
      channelId: 'channel-1',
      collectionId: 'collection-stage-829',
      versionId: 'version-stage-829-replacement',
      basisReviewId: 'review-stage-829-replacement',
      actorKind: 'human',
      finalizedBy: 'user-1',
      createdAt: 9,
    },
    mutation: {
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'finalize-stage-829-replacement',
      requestFingerprint: 'finalize-stage-829-replacement',
      action: 'finalize',
      collectionId: 'collection-stage-829',
      versionId: 'version-stage-829-replacement',
      resultId: 'finalization-stage-829-replacement',
      createdAt: 9,
    },
  });
}

function device(id: string, status: 'online' | 'offline') {
  return { id, teamId: 'team-1', ownerId: 'user-1', status, machineId: `machine-${id}`,
    profileId: `profile-${id}`, createdAt: 1, updatedAt: 1 };
}

async function claimFirst(harness: Awaited<ReturnType<typeof createHarness>>) {
  const [offer] = await harness.broker.prepareOffers('task-a');
  expect(offer).toBeDefined();
  const result = await harness.broker.acquire({ schemaVersion: 1, offerId: offer!.offerId, agentId: offer!.agentId });
  expect(result.ok).toBe(true);
  return result as Extract<TaskClaimAcquireAckV1, { ok: true }>;
}

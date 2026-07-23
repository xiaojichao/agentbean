import { describe, expect, test, vi } from 'vitest';
import type { TaskClaimAcquireAckV1 } from '../../../packages/contracts/src/index.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createTaskClaimBroker } from '../src/application/management/task-claim-broker.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Task Claim Broker', () => {
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
    status: 'open', response: null,
    createdAt: harness.clock.value, updatedAt: harness.clock.value,
    ...over,
  });
}

async function createHarness() {
  const repositories = createInMemoryRepositories();
  const clock = { value: 10 };
  let id = 0;
  const kernelIds = { nextId: () => id++ === 0 ? 'run-1' : `kernel-${id}` };
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
    leaseTokens: { nextToken: () => `raw-token-${++tokenId}` }, offerTtlMs: 20, leaseTtlMs: 100 });
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

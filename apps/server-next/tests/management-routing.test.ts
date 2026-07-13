import { describe, expect, test, vi } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createManagementRouter } from '../src/application/management/management-router.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Phase 1 management routing', () => {
  test('defaults to direct without management side effects', async () => {
    const harness = await createHarness();
    const result = await harness.router.route(request());
    expect(result).toEqual({ kind: 'direct', mode: 'direct' });
    expect(await harness.repositories.management.reservations.getByRequestKey({ teamId: 'team-1', requestKey: 'team-1:user-1:client-1' })).toBeNull();
  });

  test('shadow keeps direct routing and uses an isolated request namespace', async () => {
    const harness = await createHarness();
    await harness.router.updatePolicy({ userId: 'user-1', teamId: 'team-1', mode: 'shadow' });
    const routing = await harness.router.route(request());
    expect(routing).toEqual({
      kind: 'direct',
      mode: 'shadow',
      shadowRequestKey: 'shadow:team-1:user-1:client-1',
    });
    await harness.router.recordShadowDecision({
      shadowRequestKey: (routing as { shadowRequestKey: string }).shadowRequestKey,
      body: request().body,
      targetAgentId: request().targetAgentId,
    });
    await vi.waitFor(async () => {
      await expect(harness.repositories.management.shadowDecisions.getByRequestKey('shadow:team-1:user-1:client-1'))
        .resolves.toMatchObject({
          shadowRequestKey: 'shadow:team-1:user-1:client-1',
          diagnostics: { codes: ['MANAGEMENT_SHADOW_EVALUATION_UNAVAILABLE'] },
        });
    });
    expect(await harness.repositories.management.runs.getById('shadow:team-1:user-1:client-1')).toBeNull();
    expect(harness.gateway.schedule).not.toHaveBeenCalled();
  });

  test('managed requires owner policy, explicit target, client id and green preflight', async () => {
    const harness = await createHarness();
    await expect(harness.router.updatePolicy(managedPolicy('member-1')))
      .resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    await expect(harness.router.updatePolicy({ userId: 'user-1', teamId: 'team-1', mode: 'managed' }))
      .resolves.toEqual({ ok: false, error: 'VALIDATION_ERROR' });
    await harness.router.updatePolicy(managedPolicy());
    await expect(harness.router.route({ ...request(), clientMessageId: undefined })).resolves.toMatchObject({
      kind: 'unavailable',
      diagnostics: ['MANAGEMENT_CLIENT_MESSAGE_ID_REQUIRED'],
    });

    const result = await harness.router.route(request());
    expect(result).toMatchObject({ kind: 'managed', managementRunId: expect.any(String), profileId: 'profile-1' });
    expect(harness.gateway.schedule).not.toHaveBeenCalled();
    if (result.kind !== 'managed') throw new Error('managed route expected');
    await harness.router.scheduleManaged(result);
    expect(harness.gateway.schedule).toHaveBeenCalledOnce();
    const runId = result.managementRunId;
    await expect(harness.repositories.management.runs.getById(runId)).resolves.toMatchObject({
      mode: 'managed', status: 'queued', rootMessageId: 'message-1', placementPolicy: { placement: 'device' },
    });
    await expect(harness.repositories.management.events.list(runId)).resolves.toHaveLength(1);
  });

  test('managed fails closed when preflight is red and never schedules direct work', async () => {
    const harness = await createHarness({ workerAvailable: false });
    await harness.router.updatePolicy(managedPolicy());
    await expect(harness.router.route(request())).resolves.toMatchObject({
      kind: 'unavailable', diagnostics: ['MANAGEMENT_PREFLIGHT_WORKERAVAILABLE_MISSING'],
    });
    expect(harness.gateway.schedule).not.toHaveBeenCalled();
  });

  test('managed message creates one Run and zero direct Dispatches after the barrier', async () => {
    const harness = await createHarness();
    await harness.router.updatePolicy(managedPolicy());
    harness.gateway.schedule.mockImplementationOnce(async ({ managementRunId }) => {
      const run = await harness.repositories.management.runs.getById(managementRunId);
      expect(run).not.toBeNull();
      await expect(harness.repositories.messages.getById(run!.rootMessageId)).resolves.not.toBeNull();
      return { ok: true };
    });
    const result = await harness.app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      body: '@agent do it', clientMessageId: 'client-usecase-1',
      connectedAgentDeviceIds: ['device-1'], dispatchClaimDeviceIds: ['device-1'],
    });
    expect(result).toMatchObject({
      ok: true,
      dispatches: [],
      management: { kind: 'managed', managementRunId: expect.any(String) },
    });
    expect(await harness.repositories.dispatches.listByTeam('team-1')).toHaveLength(0);
  });
});

function request() {
  return {
    userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1',
    clientMessageId: 'client-1', body: '@agent do it', targetAgentId: 'agent-1',
  };
}

function managedPolicy(userId = 'user-1') {
  return {
    userId,
    teamId: 'team-1',
    mode: 'managed' as const,
    placementPolicy: {
      placement: 'device' as const,
      allowedDeviceIds: ['device-1'],
      allowServerContext: false,
      requireLocalModelCredentials: true,
    },
  };
}

async function createHarness(overrides: Partial<{ workerAvailable: boolean }> = {}) {
  const repositories = createInMemoryRepositories();
  const clock = { now: () => 10 };
  let id = 0;
  const ids = { nextId: () => `id-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'owner', role: 'user', passwordHash: 'hash', primaryTeamId: 'team-1', currentTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.users.create({ id: 'member-1', username: 'member', role: 'user', passwordHash: 'hash', primaryTeamId: 'team-1', currentTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', username: 'owner', role: 'owner', joinedAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'member-1', username: 'member', role: 'member', joinedAt: 1 });
  await repositories.devices.upsertHello({ id: 'device-1', teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'profile-1', status: 'online', createdAt: 1, updatedAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', identityKey: 'agent-1', name: 'agent', category: 'custom', adapterKind: 'custom', ownerId: 'user-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], deviceId: 'device-1', status: 'online', createdAt: 1, updatedAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'all', visibility: 'public', createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'] });
  const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const gateway = {
    preflight: vi.fn(async () => ({ workerAvailable: overrides.workerAvailable ?? true, credentialAvailable: true, placementAllowed: true, budgetAvailable: true, targetAvailable: true })),
    schedule: vi.fn(async () => ({ ok: true })),
  };
  const router = createManagementRouter({ repositories, kernel, gateway, clock, ids });
  const app = createServerNextUseCases({ repositories, clock, ids, managementRouter: router });
  return { repositories, gateway, router, app };
}

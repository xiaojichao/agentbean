import { describe, expect, test, vi } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createManagementRouter } from '../src/application/management/management-router.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Phase 1 management routing', () => {
  test('keeps the Team policy on Phase 1 by default and only lets owner/admin raise the ceiling', async () => {
    const harness = await createHarness();
    await expect(harness.router.getPolicy({ userId: 'member-1', teamId: 'team-1' }))
      .resolves.toMatchObject({ ok: true, canManage: false, policy: { schemaVersion: 2, maxManagementPhase: 1 } });
    await expect(harness.router.updatePolicy({ ...managedPolicy('member-1'), maxManagementPhase: 2 }))
      .resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    await expect(harness.router.updatePolicy({ ...managedPolicy(), maxManagementPhase: 2 }))
      .resolves.toMatchObject({ ok: true, policy: { maxManagementPhase: 2 } });
  });

  test('only owner/admin opt the Team into Server managed while unrooted requests stay direct', async () => {
    const harness = await createHarness();
    const serverManagedPolicy = {
      userId: 'member-1',
      teamId: 'team-1',
      mode: 'managed' as const,
      maxManagementPhase: 2 as const,
      placementPolicy: {
        placement: 'managed' as const,
        allowServerContext: true,
        requireLocalModelCredentials: false,
      },
    };

    await expect(harness.router.updatePolicy(serverManagedPolicy))
      .resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    await expect(harness.router.updatePolicy({ ...serverManagedPolicy, userId: 'admin-1' }))
      .resolves.toMatchObject({ ok: true, policy: { placementPolicy: { placement: 'managed' } } });

    await expect(harness.router.route(request())).resolves.toEqual({ kind: 'direct', mode: 'direct' });
    await expect(harness.router.route({ ...request(), rootTaskId: 'direct-agent-task' }))
      .resolves.toEqual({ kind: 'direct', mode: 'direct' });
    await expect(harness.router.route({ ...request(), targetAgentId: undefined, body: '今天进展如何？' }))
      .resolves.toEqual({ kind: 'direct', mode: 'direct' });
    await expect(harness.router.route({
      ...request(), targetAgentId: undefined, rootTaskId: 'root-task-1', body: '请协调团队完成复杂任务',
    })).resolves.toMatchObject({
      kind: 'managed', managementPhase: 2, profileId: 'profile-1', managementRunId: expect.any(String),
    });
    expect(harness.gateway.preflightPhase2).toHaveBeenCalledWith(expect.objectContaining({
      placementPolicy: expect.objectContaining({ placement: 'managed', allowServerContext: true }),
    }));

    await expect(harness.router.updatePolicy({
      userId: 'admin-1', teamId: 'team-1', mode: 'direct',
    })).resolves.toMatchObject({ ok: true, policy: { mode: 'direct' } });
  });

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
      mode: 'managed', status: 'queued', rootMessageId: 'message-1', initiatedByUserId: 'user-1',
      placementPolicy: { placement: 'device' },
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

  test('Phase 2 requires an explicit root Task and green Phase 2 preflight before creating a Run', async () => {
    const blocked = await createHarness({ phase2WorkerAvailable: false });
    await blocked.router.updatePolicy({ ...managedPolicy(), maxManagementPhase: 2 });
    await expect(blocked.router.route(request())).resolves.toMatchObject({
      kind: 'unavailable', diagnostics: ['MANAGEMENT_PHASE_2_ROOT_TASK_REQUIRED'],
    });
    await expect(blocked.router.route({ ...request(), rootTaskId: 'root-task' })).resolves.toMatchObject({
      kind: 'unavailable', diagnostics: ['MANAGEMENT_PHASE_2_PREFLIGHT_WORKERAVAILABLE_MISSING'],
    });
    await expect(blocked.repositories.management.reservations.getByRequestKey({
      teamId: 'team-1', requestKey: 'team-1:user-1:client-1',
    })).resolves.toBeNull();
  });

  test('a green explicit Phase 2 Task creates a V2 Run and bootstraps its root coordination', async () => {
    const harness = await createHarness();
    await harness.router.updatePolicy({ ...managedPolicy(), maxManagementPhase: 2 });
    const result = await harness.app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      body: '请协调团队完成任务', asTask: true, clientMessageId: 'phase2-usecase-1',
      connectedAgentDeviceIds: ['device-1'], dispatchClaimDeviceIds: ['device-1'],
    });
    expect(result).toMatchObject({
      ok: true,
      task: { id: expect.any(String), status: 'in_progress', assigneeId: undefined },
      management: { kind: 'managed', managementPhase: 2, managementRunId: expect.any(String) },
    });
    if (!result.ok || !result.task || result.management?.kind !== 'managed') throw new Error('Phase 2 result expected');
    await expect(harness.repositories.management.runs.getById(result.management.managementRunId))
      .resolves.toMatchObject({ schemaVersion: 2, managementPhase: 2, rootTaskId: result.task.id,
        initiatedByUserId: 'user-1' });
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId(result.task.id))
      .resolves.toMatchObject({ nodeKind: 'root', taskRevision: 1, reviewPolicy: 'human' });
    await expect(harness.app.getTaskDag({ userId: 'user-1', teamId: 'team-1', rootTaskId: result.task.id }))
      .resolves.toMatchObject({ ok: true, dag: { rootTaskId: result.task.id } });
  });

  test('a green explicit Phase 3 Task creates a V3 Run with the same root coordination barrier', async () => {
    const harness = await createHarness();
    await harness.router.updatePolicy({ ...managedPolicy(), maxManagementPhase: 3 });
    const result = await harness.app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      body: '请协调团队并使用 Memory 完成任务', asTask: true, clientMessageId: 'phase3-usecase-1',
      connectedAgentDeviceIds: ['device-1'], dispatchClaimDeviceIds: ['device-1'],
    });
    expect(result).toMatchObject({
      ok: true,
      task: { id: expect.any(String), status: 'in_progress', assigneeId: undefined },
      management: { kind: 'managed', managementPhase: 3, managementRunId: expect.any(String) },
    });
    if (!result.ok || !result.task || result.management?.kind !== 'managed') throw new Error('Phase 3 result expected');
    await expect(harness.repositories.management.runs.getById(result.management.managementRunId))
      .resolves.toMatchObject({ schemaVersion: 2, managementPhase: 3, rootTaskId: result.task.id });
    await expect(harness.repositories.taskCoordination.coordinations.getByTaskId(result.task.id))
      .resolves.toMatchObject({ nodeKind: 'root', taskRevision: 1, reviewPolicy: 'human' });
    await expect(harness.app.getTaskDag({ userId: 'user-1', teamId: 'team-1', rootTaskId: result.task.id }))
      .resolves.toMatchObject({ ok: true, dag: { rootTaskId: result.task.id } });
  });

  test('getTaskDag 暴露从 events 派生的用量与 run 冻结预算（#649）', async () => {
    const harness = await createHarness();
    await harness.router.updatePolicy({
      ...managedPolicy(), maxManagementPhase: 2,
      budgetOverrides: { maxSubtasks: 30 },
    });
    const result = await harness.app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      body: '请协调团队完成复杂任务', asTask: true, clientMessageId: 'usage-usecase-1',
      connectedAgentDeviceIds: ['device-1'], dispatchClaimDeviceIds: ['device-1'],
    });
    expect(result).toMatchObject({ ok: true, management: { kind: 'managed' } });
    if (!result.ok || !result.task) throw new Error('managed result expected');
    const dag = await harness.app.getTaskDag({ userId: 'user-1', teamId: 'team-1', rootTaskId: result.task.id });
    expect(dag).toMatchObject({
      ok: true,
      dag: {
        // root task-created 已写入：0-based 边深 0（#660）、尚无扇出与外部调用（#661）
        usage: { maxFanOut: 0, externalInvocationCount: 0, maxDepthReached: 0 },
        // 冻结预算 = #648 覆盖合并结果（maxSubtasks 30，其余 Phase 2 默认）
        budget: { maxSubtasks: 30, maxDepth: 3, maxExternalInvocations: 20 },
      },
    });
  });
});

describe('Phase 4 auto placement routing（#647）', () => {
  test('auto + device 可用 → resolve device：preflight 收 device 形状、run 冻结 device、event 与审计留理由码', async () => {
    const harness = await createHarness({ autoProbe: { deviceAvailable: true, serverAvailable: true } });
    await harness.router.updatePolicy(autoPolicy());
    const result = await harness.router.route(rootedRequest());
    expect(result).toMatchObject({ kind: 'managed', managementPhase: 2 });
    expect(harness.gateway.probeAutoPlacement).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1' }));
    expect(harness.gateway.preflightPhase2).toHaveBeenCalledWith(expect.objectContaining({
      placementPolicy: expect.objectContaining({ placement: 'device', allowedDeviceIds: ['device-1'] }),
    }));
    if (result.kind !== 'managed') throw new Error('managed expected');
    const run = await harness.repositories.management.runs.getById(result.managementRunId);
    expect(run?.placementPolicy.placement).toBe('device');
    const events = await harness.repositories.management.events.list(result.managementRunId);
    expect(events[0]?.event).toMatchObject({
      type: 'run-started',
      payload: { autoPlacement: { resolvedPlacement: 'device', reasonCode: 'device-preferred' } },
    });
    const audits = await harness.repositories.management.accessAudits.list(result.managementRunId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'access', decision: 'allowed', diagnosticCode: 'AUTO_PLACEMENT_DEVICE_PREFERRED',
    });
  });

  test('auto + device 不可用 + 已授权 server 可用 → resolve managed：preflight 收 managed 约束形状、run 冻结 managed', async () => {
    const harness = await createHarness({ autoProbe: { deviceAvailable: false, serverAvailable: true } });
    await harness.router.updatePolicy(autoPolicy());
    const result = await harness.router.route(rootedRequest());
    expect(result).toMatchObject({ kind: 'managed', managementPhase: 2 });
    expect(harness.gateway.preflightPhase2).toHaveBeenCalledWith(expect.objectContaining({
      placementPolicy: expect.objectContaining({
        placement: 'managed', allowServerContext: true, requireLocalModelCredentials: false,
      }),
    }));
    const preflightPolicy = (harness.gateway.preflightPhase2 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.placementPolicy;
    expect(preflightPolicy?.allowedDeviceIds).toBeUndefined();
    if (result.kind !== 'managed') throw new Error('managed expected');
    const run = await harness.repositories.management.runs.getById(result.managementRunId);
    expect(run?.placementPolicy.placement).toBe('managed');
    const events = await harness.repositories.management.events.list(result.managementRunId);
    expect(events[0]?.event).toMatchObject({
      type: 'run-started',
      payload: { autoPlacement: { resolvedPlacement: 'managed', reasonCode: 'server-fallback-device-unavailable' } },
    });
  });

  test('auto resolve 为 managed 后沿用 managed 守卫：带 target 的请求回退 direct', async () => {
    const harness = await createHarness({ autoProbe: { deviceAvailable: false, serverAvailable: true } });
    await harness.router.updatePolicy(autoPolicy());
    await expect(harness.router.route(request())).resolves.toEqual({ kind: 'direct', mode: 'direct' });
    expect(harness.gateway.preflightPhase2).not.toHaveBeenCalled();
  });

  test('红线：auto + 未授权 server + device 不可用 → 明确 unavailable，不静默迁移、不建 run', async () => {
    const harness = await createHarness({ autoProbe: { deviceAvailable: false, serverAvailable: true } });
    await harness.router.updatePolicy({
      ...autoPolicy(),
      placementPolicy: {
        placement: 'auto', allowedDeviceIds: ['device-1'],
        allowServerContext: false, requireLocalModelCredentials: true,
      },
    });
    const result = await harness.router.route(rootedRequest());
    expect(result).toEqual({
      kind: 'unavailable', mode: 'managed',
      diagnostics: ['AUTO_PLACEMENT_UNAVAILABLE_DEVICE_OFFLINE_SERVER_DISALLOWED'],
    });
    expect(harness.gateway.preflightPhase2).not.toHaveBeenCalled();
  });

  test('auto + 两侧都不可用 → 明确 unavailable（no-capacity）', async () => {
    const harness = await createHarness({ autoProbe: { deviceAvailable: false, serverAvailable: false } });
    await harness.router.updatePolicy(autoPolicy());
    await expect(harness.router.route(rootedRequest())).resolves.toEqual({
      kind: 'unavailable', mode: 'managed',
      diagnostics: ['AUTO_PLACEMENT_UNAVAILABLE_NO_CAPACITY'],
    });
  });

  test('auto + probe 未装配 → fail closed 明确 unavailable（无信号不乱猜）', async () => {
    const harness = await createHarness({ autoProbe: undefined });
    await harness.router.updatePolicy(autoPolicy());
    await expect(harness.router.route(rootedRequest())).resolves.toMatchObject({
      kind: 'unavailable', mode: 'managed',
    });
  });

  test('auto 解析随 run 冻结：幂等重放不重新 resolve（probe 状态漂移不改变已有 run）', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ deviceAvailable: true, serverAvailable: true })
      .mockResolvedValueOnce({ deviceAvailable: false, serverAvailable: true });
    const harness = await createHarness({ autoProbe: probe });
    await harness.router.updatePolicy(autoPolicy());
    const first = await harness.router.route(rootedRequest());
    expect(first).toMatchObject({ kind: 'managed' });
    if (first.kind !== 'managed') throw new Error('managed expected');
    const second = await harness.router.route(rootedRequest());
    expect(second).toMatchObject({ kind: 'managed', managementRunId: first.managementRunId });
    // 重放走 reservation resume，不再 probe（解析只发生一次）
    expect(probe).toHaveBeenCalledTimes(1);
    const run = await harness.repositories.management.runs.getById(first.managementRunId);
    expect(run?.placementPolicy.placement).toBe('device');
    // 重放路径的 preflight 必须消费冻结值（device 形状），而非 auto 原值（review finding：
    // auto 原值下行会被 gateway 按非 managed 分流，managed 冻结 run 会拿错 profileId）
    const secondPreflightPolicy = (harness.gateway.preflightPhase2 as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.placementPolicy;
    expect(secondPreflightPolicy).toMatchObject({ placement: 'device', allowedDeviceIds: ['device-1'] });
  });
});

describe('Phase 4 Team 预算配置（#648）', () => {
  test('updatePolicy 保存预算覆盖并钳制到上下限', async () => {
    const harness = await createHarness();
    await expect(harness.router.updatePolicy({
      ...managedPolicy(), maxManagementPhase: 2,
      budgetOverrides: { maxSubtasks: 9999, maxDepth: 0 },
    })).resolves.toMatchObject({
      ok: true,
      policy: { budgetOverrides: { maxSubtasks: 50, maxDepth: 1 } },
    });
    await expect(harness.repositories.management.policies.get('team-1'))
      .resolves.toMatchObject({ budgetOverrides: { maxSubtasks: 50, maxDepth: 1 } });
  });

  test('预算覆盖含非法值 → VALIDATION_ERROR 且不留半个覆盖', async () => {
    const harness = await createHarness();
    await expect(harness.router.updatePolicy({
      ...managedPolicy(), maxManagementPhase: 2,
      budgetOverrides: { maxSubtasks: 10, maxDepth: 2.5 },
    })).resolves.toEqual({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(harness.repositories.management.policies.get('team-1')).resolves.toBeNull();
  });

  test('未传 budgetOverrides 的更新保留既有覆盖', async () => {
    const harness = await createHarness();
    await harness.router.updatePolicy({ ...managedPolicy(), maxManagementPhase: 2, budgetOverrides: { maxSubtasks: 30 } });
    await expect(harness.router.updatePolicy({ ...managedPolicy(), maxManagementPhase: 3 }))
      .resolves.toMatchObject({ ok: true, policy: { budgetOverrides: { maxSubtasks: 30 }, maxManagementPhase: 3 } });
  });

  test('route 创建 Run 消费合并后的预算（覆盖生效）', async () => {
    const harness = await createHarness();
    await harness.router.updatePolicy({
      ...managedPolicy(), maxManagementPhase: 2,
      budgetOverrides: { maxSubtasks: 7, maxExternalInvocations: 9 },
    });
    const result = await harness.router.route({
      ...request(), targetAgentId: undefined, rootTaskId: 'root-task-1', body: '请协调团队完成复杂任务',
    });
    expect(result).toMatchObject({ kind: 'managed' });
    if (result.kind !== 'managed') throw new Error('managed expected');
    await expect(harness.repositories.management.runs.getById(result.managementRunId))
      .resolves.toMatchObject({ budget: { maxSubtasks: 7, maxDepth: 3, maxExternalInvocations: 9 } });
  });

  test('未配置覆盖的 Team 预算与 Phase 默认逐比特一致（回归红线）', async () => {
    const harness = await createHarness();
    await harness.router.updatePolicy({ ...managedPolicy(), maxManagementPhase: 2 });
    const result = await harness.router.route({
      ...request(), targetAgentId: undefined, rootTaskId: 'root-task-1', body: '请协调团队完成复杂任务',
    });
    if (result.kind !== 'managed') throw new Error('managed expected');
    await expect(harness.repositories.management.runs.getById(result.managementRunId))
      .resolves.toMatchObject({ budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 } });
  });
});

function rootedRequest() {
  return {
    ...request(),
    targetAgentId: undefined,
    rootTaskId: 'root-task-1',
    body: '@unknown-agent 请协调团队完成复杂任务',
  };
}

function autoPolicy(userId = 'user-1') {
  return {
    userId,
    teamId: 'team-1',
    mode: 'managed' as const,
    maxManagementPhase: 2 as const,
    placementPolicy: {
      placement: 'auto' as const,
      allowedDeviceIds: ['device-1'],
      allowServerContext: true,
      requireLocalModelCredentials: true,
    },
  };
}

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

async function createHarness(overrides: Partial<{
  workerAvailable: boolean;
  phase2WorkerAvailable: boolean;
  phase3WorkerAvailable: boolean;
  autoProbe: { deviceAvailable: boolean; serverAvailable: boolean } | undefined | ReturnType<typeof vi.fn>;
}> = {}) {
  const repositories = createInMemoryRepositories();
  const clock = { now: () => 10 };
  let id = 0;
  const ids = { nextId: () => `id-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'owner', role: 'user', passwordHash: 'hash', primaryTeamId: 'team-1', currentTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.users.create({ id: 'admin-1', username: 'admin', role: 'user', passwordHash: 'hash', primaryTeamId: 'team-1', currentTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.users.create({ id: 'member-1', username: 'member', role: 'user', passwordHash: 'hash', primaryTeamId: 'team-1', currentTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', username: 'owner', role: 'owner', joinedAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'admin-1', username: 'admin', role: 'admin', joinedAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'member-1', username: 'member', role: 'member', joinedAt: 1 });
  await repositories.devices.upsertHello({ id: 'device-1', teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'profile-1', status: 'online', createdAt: 1, updatedAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', identityKey: 'agent-1', name: 'agent', category: 'custom', adapterKind: 'custom', ownerId: 'user-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], deviceId: 'device-1', status: 'online', createdAt: 1, updatedAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'all', visibility: 'public', createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'] });
  const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const gateway = {
    preflight: vi.fn(async () => ({ workerAvailable: overrides.workerAvailable ?? true, credentialAvailable: true, placementAllowed: true, budgetAvailable: true, targetAvailable: true })),
    preflightPhase2: vi.fn(async () => ({
      preflight: { workerAvailable: overrides.phase2WorkerAvailable ?? true, credentialAvailable: true,
        placementAllowed: true, budgetAvailable: true, targetAvailable: true },
      profileId: 'profile-1',
    })),
    preflightPhase3: vi.fn(async () => ({
      preflight: { workerAvailable: overrides.phase3WorkerAvailable ?? true, credentialAvailable: true,
        placementAllowed: true, budgetAvailable: true, targetAvailable: true },
      profileId: 'profile-1',
    })),
    schedule: vi.fn(async () => ({ ok: true })),
    // #647 auto placement probe：undefined 模拟未装配（fail closed 路径）；
    // 传 vi.fn 可逐次控制返回值（冻结测试）。
    ...('autoProbe' in overrides && overrides.autoProbe === undefined ? {} : {
      probeAutoPlacement: typeof overrides.autoProbe === 'function'
        ? overrides.autoProbe
        : vi.fn(async () => overrides.autoProbe ?? { deviceAvailable: true, serverAvailable: true }),
    }),
  };
  const router = createManagementRouter({ repositories, kernel, gateway, clock, ids });
  const app = createServerNextUseCases({ repositories, clock, ids, managementRouter: router });
  return { repositories, gateway, router, app };
}

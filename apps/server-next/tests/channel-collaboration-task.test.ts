import { describe, expect, test } from 'vitest';

import { ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1 } from '../../../packages/contracts/src/index.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createTaskClaimBroker } from '../src/application/management/task-claim-broker.js';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import {
  recordChannelCollaborationClaim,
  recordChannelCollaborationStatus,
  type ChannelCollaborationClaimInput,
} from '../src/application/channel-collaboration-task-handler.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('channel collaboration task', () => {
  test('creates one root, one targeted subtask and one offer per channel Agent', async () => {
    const repositories = createInMemoryRepositories();
    let now = 100;
    let id = 0;
    const clock = { now: () => ++now };
    const ids = { nextId: () => `collab-${++id}` };
    const broker = createTaskClaimBroker({ repositories, clock, ids, offerTtlMs: 60_000 });
    const offeredIds: string[] = [];
    const grantedClaims: string[] = [];
    const blockedMessageIds: string[] = [];
    let failNextPublication = false;
    broker.bindTaskClaimGranted(async (claim) => {
      grantedClaims.push(claim.taskId);
    });
    broker.bindTaskAllocationBlockedRecorded(async ({ taskId, agentId }) => {
      const projected = await recordChannelCollaborationStatus({
        repositories,
        clock,
        status: { kind: 'allocation_blocked', taskId, agentId },
      });
      if (projected?.created) blockedMessageIds.push(projected.message.id);
    });
    const app = createServerNextUseCases({
      repositories,
      clock,
      ids,
      onChannelCollaborationTasksPublished: async (taskIds) => {
        if (failNextPublication) {
          failNextPublication = false;
          throw new Error('transient publication failure');
        }
        let offered = 0;
        for (const taskId of taskIds) {
          const offers = await broker.prepareOffers(taskId);
          offeredIds.push(...offers.map((offer) => offer.offerId));
          offered += offers.length;
        }
        return { offered };
      },
    });

    const registered = await app.registerUser({
      username: 'owner',
      password: 'secret',
      teamName: 'Team',
    });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    const channel = await app.createChannel({
      userId,
      teamId,
      name: 'collaboration',
      visibility: 'public',
    });
    if (!channel.ok) throw new Error(channel.error);
    const channelId = channel.channel.id;
    const hello = await app.deviceHello({
      teamId,
      ownerId: userId,
      machineId: 'machine-collaboration',
      hostname: 'device-collaboration',
    });
    if (!hello.ok) throw new Error(hello.error);
    const discovered = await app.registerDiscoveredAgents({
      teamId,
      deviceId: hello.device.id,
      agents: [
        { name: 'Alpha', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'Beta', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'Gamma', adapterKind: 'hermes', category: 'agentos-hosted' },
      ],
    });
    if (!discovered.ok) throw new Error(discovered.error);
    for (const agent of discovered.agents) {
      const added = await app.addChannelAgentMember({
        userId,
        teamId,
        channelId,
        agentId: agent.id,
      });
      if (!added.ok) throw new Error(added.error);
      await repositories.agentExposure.manifests.create({
        id: `manifest-${agent.id}`,
        teamId,
        agentId: agent.id,
        revision: 1,
        status: 'active',
        capabilities: [],
        skills: [],
        constraints: [],
        availability: { status: 'available' },
        validFrom: 0,
        validUntil: null,
        createdBy: userId,
        now: clock.now(),
      });
    }

    const plain = await app.sendMessage({
      userId,
      teamId,
      channelId,
      clientMessageId: 'plain-introduction',
      body: '各位，请分别介绍一下自己吧',
    });
    expect(plain).toMatchObject({ ok: true, dispatches: [] });
    const tasksAfterPlain = await app.listTasks({ userId, teamId, channelId });
    if (!tasksAfterPlain.ok) throw new Error(tasksAfterPlain.error);
    expect(tasksAfterPlain.tasks).toHaveLength(0);

    const command = {
      userId,
      teamId,
      channelId,
      clientMessageId: 'collaboration-introduction',
      body: '各位，请分别介绍一下自己吧',
      collaborationTask: ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1,
    } as const;
    const first = await app.sendMessage(command);
    expect(first).toMatchObject({
      ok: true,
      dispatches: [],
      collaborationTask: {
        subtaskIds: expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String)]),
        offerDelivery: 'offered',
        offeredCount: 3,
        targetCount: 3,
        stableCode: 'PROMOTION_APPLIED',
      },
      task: { status: 'todo' },
    });
    if (!first.ok || !first.collaborationTask?.rootTaskId) throw new Error('promotion failed');
    expect(first.collaborationTask.subtaskIds).toHaveLength(3);
    expect(offeredIds).toHaveLength(3);

    const listedTasks = await app.listTasks({ userId, teamId, channelId });
    if (!listedTasks.ok) throw new Error(listedTasks.error);
    const tasks = listedTasks.tasks;
    expect(tasks).toHaveLength(4);
    const subtasks = tasks.filter((task) => task.tags.includes('channel-collaboration'));
    expect(subtasks).toHaveLength(3);
    expect(subtasks.map((task) => task.assigneeId).sort()).toEqual(
      discovered.agents.map((agent) => agent.id).sort(),
    );
    for (const task of subtasks) {
      const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
      expect(coordination).toMatchObject({
        nodeKind: 'subtask',
        rootTaskId: first.collaborationTask.rootTaskId,
        parentTaskId: first.collaborationTask.rootTaskId,
        claimPolicy: 'targeted',
      });
      await expect(repositories.taskCoordination.offers.listByTask(task.id)).resolves.toHaveLength(1);
    }

    const offlineTask = subtasks[2]!;
    await repositories.agents.updateStatus({
      agentId: offlineTask.assigneeId!,
      status: 'offline',
      lastSeenAt: clock.now(),
    });
    const replay = await app.sendMessage(command);
    expect(replay).toMatchObject({
      ok: true,
      collaborationTask: {
        rootTaskId: first.collaborationTask.rootTaskId,
        subtaskIds: [...first.collaborationTask.subtaskIds].sort(),
        stableCode: 'PROMOTION_REPLAYED',
        offerDelivery: 'partial',
        offeredCount: 2,
        targetCount: 3,
      },
    });
    const tasksAfterReplay = await app.listTasks({ userId, teamId, channelId });
    if (!tasksAfterReplay.ok) throw new Error(tasksAfterReplay.error);
    expect(tasksAfterReplay.tasks).toHaveLength(4);
    for (const task of subtasks) {
      await expect(repositories.taskCoordination.offers.listByTask(task.id)).resolves.toHaveLength(1);
    }
    const managementRunId = first.collaborationTask.managementRunId!;
    expect((await repositories.management.events.list(managementRunId))
      .some((record) => record.event.type === 'allocation-blocked'
        && record.event.payload.taskId === offlineTask.id)).toBe(true);
    expect(blockedMessageIds).toHaveLength(1);
    await expect(repositories.messages.getById(blockedMessageIds[0]!)).resolves.toMatchObject({
      threadId: first.message?.id,
      senderKind: 'system',
      meta: {
        kind: 'channel-collaboration-status',
        status: 'allocation_blocked',
        taskId: offlineTask.id,
        agentId: offlineTask.assigneeId,
      },
    });

    const acceptedTask = subtasks[0]!;
    const [acceptedOffer] = await repositories.taskCoordination.offers.listByTask(acceptedTask.id);
    await expect(broker.respondToOffer({
      offerId: acceptedOffer!.id,
      agentId: acceptedTask.assigneeId!,
      kind: 'accepted',
      detail: null,
    })).resolves.toMatchObject({ kind: 'claim_granted' });
    expect(grantedClaims).toEqual([acceptedTask.id]);

    const revokedTask = subtasks[1]!;
    const [revokedOffer] = await repositories.taskCoordination.offers.listByTask(revokedTask.id);
    const removed = await app.removeChannelAgentMember({
      userId,
      teamId,
      channelId,
      agentId: revokedTask.assigneeId!,
    });
    if (!removed.ok) throw new Error(removed.error);
    await expect(broker.respondToOffer({
      offerId: revokedOffer!.id,
      agentId: revokedTask.assigneeId!,
      kind: 'accepted',
      detail: null,
    })).resolves.toMatchObject({
      kind: 'not_accepted',
      reason: 'agent_not_qualified',
      diagnosticCode: 'TASK_CHANNEL_FORBIDDEN',
    });

    const retryCommand = {
      ...command,
      clientMessageId: 'collaboration-publication-retry',
      body: '请再次分别介绍一下自己吧',
    };
    failNextPublication = true;
    await expect(app.sendMessage(retryCommand)).resolves.toMatchObject({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'CHANNEL_COLLABORATION_OFFER_PUBLICATION_PENDING',
    });
    await expect(app.sendMessage(retryCommand)).resolves.toMatchObject({
      ok: true,
      collaborationTask: {
        stableCode: 'PROMOTION_REPLAYED',
        offerDelivery: 'partial',
        offeredCount: 1,
        targetCount: 2,
      },
    });
  });

  test('rejects an unversioned trigger before saving a message', async () => {
    const repositories = createInMemoryRepositories();
    let id = 0;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: () => `invalid-${++id}` },
    });
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const channel = await repositories.channels.getDefaultChannel(registered.user.primaryTeamId!);
    const result = await app.sendMessage({
      userId: registered.user.id,
      teamId: registered.user.primaryTeamId!,
      channelId: channel!.id,
      body: 'hello',
      collaborationTask: { audience: 'all-channel-agents' } as never,
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: 'CHANNEL_COLLABORATION_TASK_TRIGGER_INVALID',
    });
    await expect(repositories.messages.listByChannel(channel!.id, 10)).resolves.toEqual([]);
  });

  test('projects a visible claim and moves the root to review after every Agent reply', async () => {
    const repositories = createInMemoryRepositories();
    let now = 1_000;
    let id = 0;
    const clock = { now: () => ++now };
    const ids = { nextId: () => `closure-${++id}` };
    const grantedByTask = new Map<string, ChannelCollaborationClaimInput>();
    const dispatchByTask = new Map<string, string>();
    const realtimeMessageIds: string[] = [];
    const gateway = createInvocationGateway({ repositories, clock, ids });
    const broker = createTaskClaimBroker({ repositories, clock, ids, offerTtlMs: 60_000 });
    broker.bindTaskClaimGranted(async (claim) => {
      grantedByTask.set(claim.taskId, claim);
      await recordChannelCollaborationClaim({ repositories, clock, ids, claim });
      const invoked = await gateway.invokeClaimedProjectStage({
        managementRunId: claim.managementRunId,
        idempotencyKey: `closure-invocation:${claim.claimLeaseId}`,
        taskId: claim.taskId,
        expectedTaskRevision: claim.taskRevision,
        taskAttempt: claim.taskAttempt,
        claimLeaseId: claim.claimLeaseId,
        targetAgentId: claim.targetAgentId,
        objective: claim.objective,
        attachmentIds: [],
      });
      if (invoked.view.activeDispatchId) dispatchByTask.set(claim.taskId, invoked.view.activeDispatchId);
    });
    const app = createServerNextUseCases({
      repositories,
      clock,
      ids,
      onChannelCollaborationTasksPublished: async (taskIds) => {
        let offered = 0;
        for (const taskId of taskIds) offered += (await broker.prepareOffers(taskId)).length;
        return { offered };
      },
      onChannelCollaborationMessageAppended: async (delivery) => {
        realtimeMessageIds.push(delivery.messageId);
      },
    });
    const registered = await app.registerUser({
      username: 'closure-owner',
      password: 'secret',
      teamName: 'Closure Team',
    });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    const channel = await app.createChannel({
      userId,
      teamId,
      name: 'closure',
      visibility: 'public',
    });
    if (!channel.ok) throw new Error(channel.error);
    const hello = await app.deviceHello({
      teamId,
      ownerId: userId,
      machineId: 'closure-machine',
      hostname: 'closure-device',
    });
    if (!hello.ok) throw new Error(hello.error);
    const discovered = await app.registerDiscoveredAgents({
      teamId,
      deviceId: hello.device.id,
      agents: [
        { name: 'Alpha', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'Beta', adapterKind: 'hermes', category: 'agentos-hosted' },
      ],
    });
    if (!discovered.ok) throw new Error(discovered.error);
    for (const agent of discovered.agents) {
      const added = await app.addChannelAgentMember({
        userId,
        teamId,
        channelId: channel.channel.id,
        agentId: agent.id,
      });
      if (!added.ok) throw new Error(added.error);
      await repositories.agentExposure.manifests.create({
        id: `manifest-${agent.id}`,
        teamId,
        agentId: agent.id,
        revision: 1,
        status: 'active',
        capabilities: [],
        skills: [],
        constraints: [],
        availability: { status: 'available' },
        validFrom: 0,
        validUntil: null,
        createdBy: userId,
        now: clock.now(),
      });
    }
    const sent = await app.sendMessage({
      userId,
      teamId,
      channelId: channel.channel.id,
      clientMessageId: 'closure-message',
      body: '请介绍一下自己',
      collaborationTask: ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1,
    });
    if (!sent.ok || !sent.collaborationTask || !sent.message) throw new Error('promotion failed');
    const subtasks = (await repositories.tasks.list({
      teamId,
      channelIds: [channel.channel.id],
      includeGlobal: false,
    })).filter((task) => task.tags.includes('channel-collaboration'));
    const alpha = discovered.agents.find((agent) => agent.name === 'Alpha')!;
    const beta = discovered.agents.find((agent) => agent.name === 'Beta')!;
    const alphaTask = subtasks.find((task) => task.assigneeId === alpha.id)!;
    const betaTask = subtasks.find((task) => task.assigneeId === beta.id)!;
    const [alphaOffer] = await repositories.taskCoordination.offers.listByTask(alphaTask.id);
    const alphaAccepted = await broker.respondToOffer({
      offerId: alphaOffer!.id,
      agentId: alpha.id,
      kind: 'accepted',
      detail: null,
    });
    expect(alphaAccepted).toMatchObject({ kind: 'claim_granted' });
    const alphaClaim = grantedByTask.get(alphaTask.id)!;
    const alphaDispatchId = dispatchByTask.get(alphaTask.id)!;
    const alphaClaimMessage = await app.receiveDispatchAgentMessage({
      schemaVersion: 1,
      dispatchId: alphaDispatchId,
      agentId: alpha.id,
      updateId: `claim-${alphaClaim.claimLeaseId}`,
      sequence: 1,
      kind: 'plan',
      body: '我是 Alpha，已认领并开始处理。',
    });
    expect(alphaClaimMessage).toMatchObject({
      ok: true,
      message: {
        senderKind: 'agent',
        senderId: alpha.id,
        threadId: sent.message.id,
        meta: { kind: 'dispatch-agent-message', dispatchId: alphaDispatchId },
      },
    });
    await expect(repositories.tasks.getById(sent.collaborationTask.rootTaskId)).resolves.toMatchObject({
      status: 'in_progress',
    });
    await expect(repositories.management.runs.getById(sent.collaborationTask.managementRunId!))
      .resolves.toMatchObject({ status: 'running' });

    const alphaRunStartedAt = now;
    const alphaCompleted = await app.receiveDispatchResult({
      dispatchId: alphaDispatchId,
      agentId: alpha.id,
      body: '我是 Alpha，负责频道协作任务。',
      artifacts: [{
        id: 'alpha-inline-artifact',
        filename: 'alpha-note.md',
        mimeType: 'text/markdown',
        sizeBytes: 12,
      }],
      workspaceRun: {
        status: 'succeeded',
        startedAt: alphaRunStartedAt,
        completedAt: alphaRunStartedAt,
      },
    });
    expect(alphaCompleted).toMatchObject({
      ok: true,
      message: {
        senderKind: 'agent',
        senderId: alpha.id,
        threadId: sent.message.id,
      },
    });
    await expect(repositories.tasks.getById(alphaTask.id)).resolves.toMatchObject({ status: 'done' });
    await expect(app.receiveDispatchResult({
      dispatchId: alphaDispatchId,
      agentId: alpha.id,
      body: '我是 Alpha，负责频道协作任务。',
      artifacts: [{
        id: 'alpha-inline-artifact',
        filename: 'alpha-note.md',
        mimeType: 'text/markdown',
        sizeBytes: 12,
      }],
      workspaceRun: {
        publishId: 'alpha-late-publish',
        status: 'succeeded',
        startedAt: alphaRunStartedAt,
        completedAt: alphaRunStartedAt,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: 'Channel collaboration result cannot add a late OutputPackage publish',
    });
    await expect(repositories.tasks.getById(betaTask.id)).resolves.toMatchObject({ status: 'todo' });
    await expect(repositories.tasks.getById(sent.collaborationTask.rootTaskId)).resolves.toMatchObject({
      status: 'in_progress',
    });
    const summaryMessageId = `channel-collaboration-summary:${sent.collaborationTask.managementRunId}`;
    await expect(repositories.messages.getById(summaryMessageId)).resolves.toBeNull();

    const [betaOffer] = await repositories.taskCoordination.offers.listByTask(betaTask.id);
    await expect(broker.respondToOffer({
      offerId: betaOffer!.id,
      agentId: beta.id,
      kind: 'accepted',
      detail: null,
    })).resolves.toMatchObject({ kind: 'claim_granted' });
    const betaDispatchId = dispatchByTask.get(betaTask.id)!;
    await expect(app.receiveDispatchResult({
      dispatchId: betaDispatchId,
      agentId: beta.id,
      body: '我是 Beta，负责独立核验。',
      artifacts: [{
        id: 'beta-delivery-artifact',
        filename: 'beta-report.md',
        mimeType: 'text/markdown',
        sizeBytes: 12,
      }],
      workspaceRun: {
        publishId: 'closure-beta-publish',
        status: 'succeeded',
        startedAt: now,
        completedAt: now,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'OutputPackage reconciliation pending',
    });
    await expect(repositories.tasks.getById(betaTask.id)).resolves.toMatchObject({ status: 'in_review' });
    await expect(repositories.tasks.getById(sent.collaborationTask.rootTaskId)).resolves.toMatchObject({
      status: 'in_progress',
    });
    await expect(repositories.messages.getById(summaryMessageId)).resolves.toBeNull();
    const profileId = 'closure-project-profile';
    const stageId = 'closure-beta-stage';
    await expect(repositories.channelProjects.createInitialStage({
      expectedRevision: 0,
      profile: {
        id: profileId,
        teamId,
        channelId: channel.channel.id,
        projectLeadId: userId,
        defaultReviewerIds: [userId],
        revision: 1,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      },
      stage: {
        id: stageId,
        teamId,
        channelId: channel.channel.id,
        taskId: betaTask.id,
        taskRevision: betaTask.revision,
        name: 'Beta 交付审核',
        goal: '审核 Beta 的频道协作交付',
        ownerId: userId,
        reviewerIds: [userId],
        acceptanceCriteria: ['文件审核通过'],
        createdAt: now,
        updatedAt: now,
      },
      mutation: {
        teamId,
        channelId: channel.channel.id,
        idempotencyKey: 'closure-beta-stage',
        requestFingerprint: 'closure-beta-stage',
        profileId,
        stageId,
        resultRevision: 1,
        resultOverview: {} as never,
        createdAt: now,
      },
    })).resolves.toMatchObject({ kind: 'created' });
    const [betaDelivery] = await repositories.taskCoordination.deliveries.listByTask(betaTask.id);
    const betaClaim = grantedByTask.get(betaTask.id)!;
    const packageId = 'closure-beta-package';
    const collectionId = 'closure-beta-collection';
    const versionId = 'closure-beta-version';
    await expect(repositories.outputPackages.recordPackageFormation({
      record: {
        teamId,
        packageId,
        channelId: channel.channel.id,
        deliveryId: betaDelivery!.id,
        publishId: 'closure-beta-publish',
        workspaceRevisionId: 'closure-beta-workspace-revision',
        agentId: beta.id,
        taskId: betaTask.id,
        taskBinding: 'managed',
        taskRevision: betaTask.revision,
        taskAttempt: betaClaim.taskAttempt,
        memberCount: 1,
        status: 'recorded',
        createdAt: now,
      },
      members: [{
        sequence: 1,
        shortLabel: 'F1',
        role: 'deliverable',
        requiredForFinal: true,
        sourcePath: 'beta-report.md',
        filename: 'beta-report.md',
        sizeBytes: 12,
        collection: { mode: 'create', collectionId, name: 'beta-report.md', kind: 'deliverable' },
        version: {
          id: versionId,
          artifactId: 'beta-delivery-artifact',
          stageId,
          taskId: betaTask.id,
          taskRevision: betaTask.revision,
        },
      }],
      receipt: {
        receiptId: 'closure-beta-package-receipt',
        teamId,
        commandName: 'record-agent-output-package',
        commandSchemaVersion: 1,
        idempotencyKey: 'record-agent-output-package:closure-beta-publish',
        commandHash: 'closure-beta-package',
        outcome: 'applied',
        committedRevisions: [],
        eventRefs: [],
        commitTime: now,
        resultAvailable: true,
        createdAt: now,
      },
      tombstone: {
        id: 'closure-beta-package-tombstone',
        teamId,
        commandName: 'record-agent-output-package',
        idempotencyKey: 'record-agent-output-package:closure-beta-publish',
        commandHash: 'closure-beta-package',
        receiptId: 'closure-beta-package-receipt',
        outcome: 'applied',
        resultAvailable: true,
        createdAt: now,
      },
    })).resolves.toMatchObject({ kind: 'created' });
    await expect(app.submitPackageArtifactReview({
      teamId,
      userId,
      channelId: channel.channel.id,
      packageId,
      collectionId,
      versionId,
      decision: 'approved',
      comment: '文件内容符合要求',
      idempotencyKey: 'closure-beta-review',
    })).resolves.toMatchObject({ ok: true, review: { decision: 'approved' } });
    await expect(repositories.tasks.getById(betaTask.id)).resolves.toMatchObject({ status: 'done' });
    await expect(repositories.tasks.getById(sent.collaborationTask.rootTaskId)).resolves.toMatchObject({
      status: 'in_review',
    });
    await expect(repositories.management.runs.getById(sent.collaborationTask.managementRunId!))
      .resolves.toMatchObject({ status: 'in_review' });
    await expect(repositories.messages.getById(summaryMessageId)).resolves.toMatchObject({
      threadId: sent.message.id,
      senderKind: 'system',
      meta: { kind: 'channel-collaboration-summary' },
    });
    expect(realtimeMessageIds).toEqual([summaryMessageId]);
    await expect(app.receiveDispatchResult({
      dispatchId: betaDispatchId,
      agentId: beta.id,
      body: '我是 Beta，负责独立核验。',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(repositories.messages.getById(summaryMessageId)).resolves.toBeTruthy();
    const thread = await repositories.messages.listByThread({
      channelId: channel.channel.id,
      threadId: sent.message.id,
      limit: 20,
    });
    expect(thread.map((message) => message.meta?.kind)).toEqual(expect.arrayContaining([
      'dispatch-agent-message',
      'channel-collaboration-summary',
    ]));
    const visible = await app.listChannelMessages({ channelId: channel.channel.id, limit: 20 });
    if (!visible.ok) throw new Error(visible.error);
    expect(visible.messages.map((message) => message.meta?.kind)).toEqual(expect.arrayContaining([
      'dispatch-agent-message',
      'channel-collaboration-summary',
    ]));
  });

  test('keeps rejection, expiry and failure visible without blocking other Agents or summarizing early', async () => {
    const repositories = createInMemoryRepositories();
    let now = 5_000;
    let id = 0;
    const clock = { now: () => now };
    const ids = { nextId: () => `abnormal-${++id}` };
    const grantedByTask = new Map<string, ChannelCollaborationClaimInput>();
    const dispatchByTask = new Map<string, string>();
    const realtimeMessageIds: string[] = [];
    const gateway = createInvocationGateway({ repositories, clock, ids });
    const broker = createTaskClaimBroker({
      repositories,
      clock,
      ids,
      offerTtlMs: 60_000,
      leaseTtlMs: 500,
    });
    const notifyStatus = async (
      projected: Awaited<ReturnType<typeof recordChannelCollaborationStatus>>,
    ) => {
      if (projected?.created) realtimeMessageIds.push(projected.message.id);
    };
    broker.bindTaskOfferResponseRecorded(async ({ taskId, response }) => {
      if (response.kind === 'accepted') return;
      await notifyStatus(await recordChannelCollaborationStatus({
        repositories,
        clock,
        status: {
          kind: 'offer_response',
          taskId,
          agentId: response.agentId,
          offerId: response.offerId,
          responseKind: response.kind,
        },
      }));
    });
    broker.bindTaskClaimExpired(async (expired) => {
      await notifyStatus(await recordChannelCollaborationStatus({
        repositories,
        clock,
        status: {
          kind: 'claim_expired',
          taskId: expired.taskId,
          agentId: expired.agentId,
          claimLeaseId: expired.claimLeaseId,
        },
      }));
    });
    broker.bindTaskClaimGranted(async (claim) => {
      grantedByTask.set(claim.taskId, claim);
      await recordChannelCollaborationClaim({ repositories, clock, ids, claim });
      const invoked = await gateway.invokeClaimedProjectStage({
        managementRunId: claim.managementRunId,
        idempotencyKey: `abnormal-invocation:${claim.claimLeaseId}`,
        taskId: claim.taskId,
        expectedTaskRevision: claim.taskRevision,
        taskAttempt: claim.taskAttempt,
        claimLeaseId: claim.claimLeaseId,
        targetAgentId: claim.targetAgentId,
        objective: claim.objective,
        attachmentIds: [],
      });
      if (invoked.view.activeDispatchId) dispatchByTask.set(claim.taskId, invoked.view.activeDispatchId);
    });
    const app = createServerNextUseCases({
      repositories,
      clock,
      ids,
      onChannelCollaborationTasksPublished: async (taskIds) => {
        let offered = 0;
        for (const taskId of taskIds) offered += (await broker.prepareOffers(taskId)).length;
        return { offered };
      },
      onChannelCollaborationMessageAppended: async (delivery) => {
        realtimeMessageIds.push(delivery.messageId);
      },
    });
    const registered = await app.registerUser({
      username: 'abnormal-owner',
      password: 'secret',
      teamName: 'Abnormal Team',
    });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    const channel = await app.createChannel({
      userId,
      teamId,
      name: 'abnormal-collaboration',
      visibility: 'public',
    });
    if (!channel.ok) throw new Error(channel.error);
    const hello = await app.deviceHello({
      teamId,
      ownerId: userId,
      machineId: 'abnormal-machine',
      hostname: 'abnormal-device',
    });
    if (!hello.ok) throw new Error(hello.error);
    const discovered = await app.registerDiscoveredAgents({
      teamId,
      deviceId: hello.device.id,
      agents: [
        { name: 'Alpha', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'Beta', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'Gamma', adapterKind: 'hermes', category: 'agentos-hosted' },
      ],
    });
    if (!discovered.ok) throw new Error(discovered.error);
    for (const agent of discovered.agents) {
      const added = await app.addChannelAgentMember({
        userId,
        teamId,
        channelId: channel.channel.id,
        agentId: agent.id,
      });
      if (!added.ok) throw new Error(added.error);
      await repositories.agentExposure.manifests.create({
        id: `manifest-${agent.id}`,
        teamId,
        agentId: agent.id,
        revision: 1,
        status: 'active',
        capabilities: [],
        skills: [],
        constraints: [],
        availability: { status: 'available' },
        validFrom: 0,
        validUntil: null,
        createdBy: userId,
        now: clock.now(),
      });
    }
    const sent = await app.sendMessage({
      userId,
      teamId,
      channelId: channel.channel.id,
      clientMessageId: 'abnormal-message',
      body: '请分别介绍自己并保持独立执行',
      collaborationTask: ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1,
    });
    if (!sent.ok || !sent.collaborationTask || !sent.message) throw new Error('promotion failed');
    const subtasks = (await repositories.tasks.list({
      teamId,
      channelIds: [channel.channel.id],
      includeGlobal: false,
    })).filter((task) => task.tags.includes('channel-collaboration'));
    const alpha = discovered.agents.find((agent) => agent.name === 'Alpha')!;
    const beta = discovered.agents.find((agent) => agent.name === 'Beta')!;
    const gamma = discovered.agents.find((agent) => agent.name === 'Gamma')!;
    const alphaTask = subtasks.find((task) => task.assigneeId === alpha.id)!;
    const betaTask = subtasks.find((task) => task.assigneeId === beta.id)!;
    const gammaTask = subtasks.find((task) => task.assigneeId === gamma.id)!;

    const [alphaOffer] = await repositories.taskCoordination.offers.listByTask(alphaTask.id);
    await expect(broker.respondToOffer({
      offerId: alphaOffer!.id,
      agentId: alpha.id,
      kind: 'rejected',
      detail: '暂不处理',
    })).resolves.toMatchObject({ kind: 'response_recorded', status: 'rejected' });

    const [betaOffer] = await repositories.taskCoordination.offers.listByTask(betaTask.id);
    await expect(broker.respondToOffer({
      offerId: betaOffer!.id,
      agentId: beta.id,
      kind: 'accepted',
      detail: null,
    })).resolves.toMatchObject({ kind: 'claim_granted' });
    const [gammaOffer] = await repositories.taskCoordination.offers.listByTask(gammaTask.id);
    await expect(broker.respondToOffer({
      offerId: gammaOffer!.id,
      agentId: gamma.id,
      kind: 'accepted',
      detail: null,
    })).resolves.toMatchObject({ kind: 'claim_granted' });

    await expect(app.receiveDispatchResult({
      dispatchId: dispatchByTask.get(betaTask.id)!,
      agentId: beta.id,
      body: 'Beta 执行超时。',
      outcome: 'stopped',
      reasonCode: 'EXECUTION_LIMIT',
      reasonText: '已达执行上限',
      workspaceRun: { status: 'cancelled', exitCode: 124, startedAt: now, completedAt: now },
    })).resolves.toMatchObject({ ok: true });
    await expect(repositories.tasks.getById(betaTask.id)).resolves.toMatchObject({ status: 'todo' });
    await expect(repositories.tasks.getById(gammaTask.id)).resolves.toMatchObject({ status: 'in_progress' });

    await expect(app.receiveDispatchResult({
      dispatchId: dispatchByTask.get(gammaTask.id)!,
      agentId: gamma.id,
      body: '我是 Gamma；Beta 失败不影响我的独立回复。',
    })).resolves.toMatchObject({ ok: true, message: { senderId: gamma.id } });
    await expect(repositories.tasks.getById(gammaTask.id)).resolves.toMatchObject({ status: 'done' });

    const retryOffers = await broker.prepareOffers(alphaTask.id);
    expect(retryOffers).toHaveLength(1);
    await expect(broker.respondToOffer({
      offerId: retryOffers[0]!.offerId,
      agentId: alpha.id,
      kind: 'accepted',
      detail: null,
    })).resolves.toMatchObject({ kind: 'claim_granted' });
    const alphaClaim = grantedByTask.get(alphaTask.id)!;
    const expiredAlphaDispatchId = dispatchByTask.get(alphaTask.id)!;
    now += 1_000;
    const expired = await broker.expireClaims();
    expect(expired).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimLeaseId: alphaClaim.claimLeaseId, taskId: alphaTask.id }),
    ]));
    await expect(repositories.tasks.getById(alphaTask.id)).resolves.toMatchObject({ status: 'todo' });
    await expect(app.receiveDispatchResult({
      dispatchId: expiredAlphaDispatchId,
      agentId: alpha.id,
      body: '这是已过期 Claim 的迟到结果。',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: 'Channel collaboration result belongs to a stale Claim',
    });
    await expect(repositories.taskCoordination.deliveries.listByTask(alphaTask.id)).resolves.toHaveLength(0);
    await expect(repositories.tasks.getById(alphaTask.id)).resolves.toMatchObject({ status: 'todo' });
    const firstAlphaExpiry = expired.find((claim) => claim.claimLeaseId === alphaClaim.claimLeaseId)!;
    await expect(broker.canAutoReofferExpiredChannelCollaborationClaim(firstAlphaExpiry))
      .resolves.toBe(true);
    const automaticRetryOffers = await broker.prepareOffers(alphaTask.id, {
      allowedAgentIds: [alpha.id],
    });
    expect(automaticRetryOffers).toHaveLength(1);
    await expect(broker.canAutoReofferExpiredChannelCollaborationClaim(firstAlphaExpiry))
      .resolves.toBe(false);
    await expect(broker.respondToOffer({
      offerId: automaticRetryOffers[0]!.offerId,
      agentId: alpha.id,
      kind: 'accepted',
      detail: null,
    })).resolves.toMatchObject({ kind: 'claim_granted' });
    const automaticRetryClaim = grantedByTask.get(alphaTask.id)!;
    const automaticRetryDispatchId = dispatchByTask.get(alphaTask.id)!;
    await expect(app.receiveDispatchResult({
      dispatchId: expiredAlphaDispatchId,
      agentId: alpha.id,
      body: '这是旧 Claim 的迟到失败结果。',
      outcome: 'failed',
      reasonCode: 'LATE_FAILURE',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: 'Channel collaboration result belongs to a stale Claim',
    });
    await expect(repositories.tasks.getById(alphaTask.id)).resolves.toMatchObject({
      status: 'in_progress',
    });
    await expect(repositories.taskCoordination.coordinations.getByTaskId(alphaTask.id))
      .resolves.toMatchObject({ attempt: automaticRetryClaim.taskAttempt });
    await expect(repositories.taskCoordination.claimLeases.getCurrent({
      taskId: alphaTask.id,
      taskRevision: alphaTask.revision,
      taskAttempt: automaticRetryClaim.taskAttempt,
    })).resolves.toMatchObject({ id: automaticRetryClaim.claimLeaseId, status: 'active' });
    now += 1_000;
    await expect(app.receiveDispatchError({
      dispatchId: automaticRetryDispatchId,
      agentId: alpha.id,
      error: 'LATE_ERROR_AFTER_LEASE_EXPIRY',
    })).resolves.toMatchObject({ ok: true, dispatch: { status: 'failed' } });
    await expect(repositories.tasks.getById(alphaTask.id)).resolves.toMatchObject({
      status: 'in_progress',
    });
    await expect(repositories.taskCoordination.coordinations.getByTaskId(alphaTask.id))
      .resolves.toMatchObject({ attempt: automaticRetryClaim.taskAttempt });
    await expect(repositories.taskCoordination.claimLeases.getCurrent({
      taskId: alphaTask.id,
      taskRevision: alphaTask.revision,
      taskAttempt: automaticRetryClaim.taskAttempt,
    })).resolves.toMatchObject({ id: automaticRetryClaim.claimLeaseId, status: 'active' });
    const secondExpired = await broker.expireClaims();
    const secondAlphaExpiry = secondExpired.find((claim) =>
      claim.claimLeaseId === automaticRetryClaim.claimLeaseId)!;
    expect(secondAlphaExpiry).toBeDefined();
    await expect(broker.canAutoReofferExpiredChannelCollaborationClaim(secondAlphaExpiry))
      .resolves.toBe(false);

    const summaryMessageId = `channel-collaboration-summary:${sent.collaborationTask.managementRunId}`;
    await expect(repositories.messages.getById(summaryMessageId)).resolves.toBeNull();
    await expect(repositories.tasks.getById(sent.collaborationTask.rootTaskId)).resolves.toMatchObject({
      status: 'in_progress',
    });
    const thread = await repositories.messages.listByThread({
      channelId: channel.channel.id,
      threadId: sent.message.id,
      limit: 50,
    });
    const statusMessages = thread.filter((message) =>
      message.meta?.kind === 'channel-collaboration-status');
    expect(statusMessages.map((message) => message.meta?.status)).toEqual(expect.arrayContaining([
      'offer_rejected',
      'invocation_failed',
      'claim_expired',
    ]));
    expect(statusMessages).toHaveLength(4);
    expect(statusMessages.every((message) => message.senderKind === 'system'
      && message.threadId === sent.message!.id)).toBe(true);
    const visible = await app.listChannelMessages({ channelId: channel.channel.id, limit: 50 });
    if (!visible.ok) throw new Error(visible.error);
    expect(visible.messages.filter((message) =>
      message.meta?.kind === 'channel-collaboration-status')).toHaveLength(4);
    await broker.expireClaims();
    const replayedThread = await repositories.messages.listByThread({
      channelId: channel.channel.id,
      threadId: sent.message.id,
      limit: 50,
    });
    expect(replayedThread.filter((message) =>
      message.meta?.kind === 'channel-collaboration-status')).toHaveLength(4);
    expect(new Set(realtimeMessageIds)).toEqual(new Set(statusMessages.map((message) => message.id)));
  });
});

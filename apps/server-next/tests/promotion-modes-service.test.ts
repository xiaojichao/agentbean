import { describe, expect, test } from 'vitest';

import { createPromotionModesService } from '../src/application/promotion-modes-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

function harness(options: { manifestRevision?: number | null } = {}) {
  const repositories = createInMemoryRepositories();
  let id = 0;
  let now = 1_000;
  const service = createPromotionModesService({
    teamId: 'team-1',
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock: { now: () => (now += 10) },
    ids: { nextId: () => `generated-${++id}` },
    issueAuthorizationToken: ({ proposalId, revision, approverId, expiresAt }) =>
      `token:${proposalId}:${revision}:${approverId}:${expiresAt}`,
    canApproveProposal: async ({ userId }) => userId === 'user-1' || userId === 'reviewer-1',
    resolveActiveManifestRevision: async () => options.manifestRevision === undefined
      ? 7
      : options.manifestRevision,
  });
  return { repositories, service };
}

async function seedSimpleRequest(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  status: 'queued' | 'running' = 'running',
) {
  await repositories.channels.create({
    id: 'channel-1',
    teamId: 'team-1',
    kind: 'channel',
    name: 'delivery',
    title: 'delivery',
    visibility: 'private',
    humanMemberIds: ['user-1'],
    agentMemberIds: ['agent-1'],
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  await repositories.messages.append({
    id: 'message-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    senderKind: 'human',
    senderId: 'user-1',
    body: '@Agent 请处理这个请求',
    createdAt: 1_000,
    meta: { revision: 1 },
  });
  await repositories.dispatches.create({
    id: 'dispatch-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    agentId: 'agent-1',
    status,
    requestId: 'request-1',
    prompt: '请处理这个请求',
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  await repositories.management.dispatchAttempts.create({
    id: 'attempt-1',
    invocationId: 'invocation-1',
    dispatchId: 'dispatch-1',
    attemptNumber: 1,
    status,
    startedAt: 1_000,
  });
}

const objective = {
  schemaVersion: 1,
  objective: '协调多个 Agent 完成交付',
  scope: '当前频道',
  riskLevel: 'low',
} as const;

async function enableProposalOnly(service: ReturnType<typeof createPromotionModesService>) {
  await service.upsertSemanticRollout({
    schemaVersion: 1,
    teamId: 'team-1',
    mode: 'proposal-only',
    revision: 1,
    updatedAt: 1_000,
  });
}

describe('#923 Promotion modes service', () => {
  test('evaluator 故障只记录 audit，不创建 Task 或 Dispatch', async () => {
    const { repositories, service } = harness();
    await enableProposalOnly(service);
    const result = await service.evaluateSemantic({
      channelId: 'channel-1',
      requesterId: 'user-1',
      approverId: 'user-1',
      evaluatorFailed: true,
    });
    expect(result.path.kind).toBe('evaluator-unavailable');
    expect(await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    })).toEqual([]);
    expect(await repositories.dispatches.listByTeam('team-1')).toEqual([]);
  });

  test('direct Agent escalation 原子创建 root Task、fence 旧 Dispatch 并保留 targeted Offer 约束', async () => {
    const { repositories, service } = harness();
    await seedSimpleRequest(repositories);

    const result = await service.escalateAgent({
      escalation: {
        schemaVersion: 1,
        agentId: 'agent-1',
        channelId: 'channel-1',
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'message-1' },
          sourceRevision: 1,
        },
        objectiveSnapshot: objective,
        orchestrationNeed: true,
        scopeDecision: 'within-authorized-scope',
        simpleRequest: {
          messageId: 'message-1',
          dispatchId: 'dispatch-1',
          targetAgentId: 'agent-1',
        },
      },
      idempotencyKey: 'escalate-1',
      approverId: 'user-1',
    });

    expect(result.outcome).toBe('applied');
    expect((await repositories.dispatches.getById('dispatch-1'))?.status).toBe('cancelled');
    expect((await repositories.management.dispatchAttempts.getByDispatchId('dispatch-1'))?.status)
      .toBe('cancelled');
    const handoff = await repositories.taskCoordinationUnitOfWork.run(async (repos) =>
      repos.promotion.handoffs.getBySourceDispatchId('dispatch-1'));
    expect(handoff).toMatchObject({
      targetAgentId: 'agent-1',
      targetedOfferRequired: true,
      status: 'applied',
    });
    const offers = await repositories.taskCoordination.offers.listByTask(result.result!.rootTaskId);
    expect(offers).toEqual([
      expect.objectContaining({
        id: handoff!.targetedOfferId,
        agentId: 'agent-1',
        manifestRevision: 7,
        hardSpecified: true,
        status: 'open',
      }),
    ]);
    expect(JSON.parse(handoff!.materialJson)).toMatchObject({ kind: 'unaccepted-handoff-material' });
  });

  test('proposal accept 只允许合法 approver，并与 root Task 创建原子提交且可幂等重放', async () => {
    const { repositories, service } = harness();
    await seedSimpleRequest(repositories, 'queued');
    await enableProposalOnly(service);
    const evaluated = await service.evaluateSemantic({
      channelId: 'channel-1',
      requesterId: 'user-1',
      approverId: 'user-1',
      evaluation: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: 'message-1' },
        sourceRevision: 1,
        verdict: 'proposal',
        objectiveSnapshot: objective,
        rationaleCode: 'ORCHESTRATION_NEEDED',
      },
    });
    expect(evaluated).toHaveProperty('proposal');
    if (!('proposal' in evaluated)) throw new Error('proposal was not created');
    const replayedEvaluation = await service.evaluateSemantic({
      channelId: 'channel-1',
      requesterId: 'user-1',
      approverId: 'user-1',
      evaluation: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: 'message-1' },
        sourceRevision: 1,
        verdict: 'proposal',
        objectiveSnapshot: objective,
        rationaleCode: 'ORCHESTRATION_NEEDED',
      },
    });
    expect(replayedEvaluation).toMatchObject({
      disposition: 'existing',
      proposal: {
        id: evaluated.proposal.id,
        authorizationToken: evaluated.proposal.authorizationToken,
      },
    });
    const action = {
      schemaVersion: 1,
      action: 'accept',
      proposalId: evaluated.proposal.id,
      expectedRevision: 1,
      authorizationToken: evaluated.proposal.authorizationToken,
      idempotencyKey: 'proposal-accept-1',
    } as const;
    expect(await service.actOnProposal({ actorId: 'observer', action }))
      .toMatchObject({ outcome: 'rejected', stableCode: 'PROPOSAL_APPROVER_NOT_AUTHORIZED' });
    const accepted = await service.actOnProposal({ actorId: 'user-1', action });
    expect(accepted).toMatchObject({ outcome: 'applied', stableCode: 'PROPOSAL_ACCEPTED' });
    expect(await service.actOnProposal({ actorId: 'user-1', action })).toEqual(accepted);
    const stored = await repositories.taskCoordinationUnitOfWork.run(async (repos) =>
      repos.promotion.proposals.getById(evaluated.proposal.id));
    expect(stored).toMatchObject({
      status: 'accepted',
      revision: 2,
      rootTaskId: accepted.rootTaskId,
      managementRunId: accepted.managementRunId,
    });
  });

  test('proposal requester 与合法 Human approver 可以是不同用户', async () => {
    const { repositories, service } = harness();
    await seedSimpleRequest(repositories, 'queued');
    await enableProposalOnly(service);
    const evaluated = await service.evaluateSemantic({
      channelId: 'channel-1',
      requesterId: 'user-1',
      approverId: 'reviewer-1',
      evaluation: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: 'message-1' },
        sourceRevision: 1,
        verdict: 'proposal',
        objectiveSnapshot: objective,
        rationaleCode: 'ORCHESTRATION_NEEDED',
      },
    });
    if (!('proposal' in evaluated)) throw new Error('proposal was not created');
    const action = {
      schemaVersion: 1,
      action: 'accept',
      proposalId: evaluated.proposal.id,
      expectedRevision: 1,
      authorizationToken: evaluated.proposal.authorizationToken,
      idempotencyKey: 'proposal-reviewer-accept-1',
    } as const;
    expect(await service.actOnProposal({ actorId: 'user-1', action }))
      .toMatchObject({ outcome: 'rejected', stableCode: 'PROPOSAL_APPROVER_REQUIRED' });
    expect(await service.actOnProposal({ actorId: 'reviewer-1', action }))
      .toMatchObject({ outcome: 'applied', stableCode: 'PROPOSAL_ACCEPTED' });
  });

  test('proposal reject/cancel/expire 都幂等，且不创建 root Task', async () => {
    for (const scenario of [
      { action: 'reject' as const, actorId: 'user-1' },
      { action: 'cancel' as const, actorId: 'user-1' },
      { action: 'expire' as const, systemActor: true, proposalTtlMs: 0 },
    ]) {
      const { repositories, service } = harness();
      await seedSimpleRequest(repositories, 'queued');
      await enableProposalOnly(service);
      const evaluated = await service.evaluateSemantic({
        channelId: 'channel-1',
        requesterId: 'user-1',
        approverId: 'user-1',
        proposalTtlMs: scenario.proposalTtlMs,
        evaluation: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'message-1' },
          sourceRevision: 1,
          verdict: 'proposal',
          objectiveSnapshot: objective,
          rationaleCode: 'ORCHESTRATION_NEEDED',
        },
      });
      if (!('proposal' in evaluated)) throw new Error('proposal was not created');
      const action = {
        schemaVersion: 1,
        action: scenario.action,
        proposalId: evaluated.proposal.id,
        expectedRevision: 1,
        authorizationToken: evaluated.proposal.authorizationToken,
        idempotencyKey: `proposal-${scenario.action}-1`,
      } as const;
      const first = await service.actOnProposal({
        ...(scenario.actorId ? { actorId: scenario.actorId } : {}),
        ...(scenario.systemActor ? { systemActor: true } : {}),
        action,
      });
      expect(first.outcome).toBe('applied');
      expect(await service.actOnProposal({
        ...(scenario.actorId ? { actorId: scenario.actorId } : {}),
        ...(scenario.systemActor ? { systemActor: true } : {}),
        action,
      })).toEqual(first);
      expect(await repositories.tasks.list({
        teamId: 'team-1',
        channelIds: ['channel-1'],
        includeGlobal: true,
      })).toEqual([]);
    }
  });

  test('Team policy 仅确定性预授权入口 direct promote，chat-only 不建 Task', async () => {
    const { repositories, service } = harness();
    await seedSimpleRequest(repositories, 'queued');
    await service.upsertTeamPolicy({
      schemaVersion: 1,
      teamId: 'team-1',
      revision: 1,
      enabled: true,
      ruleId: 'structured-workflow',
      preauthorized: true,
      requireOrchestrationNeed: true,
      updatedAt: 1_000,
    });
    const excluded = await service.applyTeamPolicy({
      requesterId: 'user-1',
      channelId: 'channel-1',
      ruleId: 'structured-workflow',
      orchestrationNeed: true,
      exclusion: 'chat-only',
      objectiveSnapshot: objective,
      freshnessBasis: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: 'message-1' },
        sourceRevision: 1,
      },
      idempotencyKey: 'policy-excluded',
    });
    expect(excluded.outcome).toBe('rejected');
    const applied = await service.applyTeamPolicy({
      requesterId: 'user-1',
      channelId: 'channel-1',
      ruleId: 'structured-workflow',
      orchestrationNeed: true,
      objectiveSnapshot: objective,
      freshnessBasis: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: 'message-1' },
        sourceRevision: 1,
      },
      idempotencyKey: 'policy-applied',
    });
    expect(applied.outcome).toBe('applied');
  });

  test('Agent escalation freshness hold 不创建 Task、不 fence 旧执行权、不留下 handoff', async () => {
    const { repositories, service } = harness();
    await seedSimpleRequest(repositories);
    const result = await service.escalateAgent({
      escalation: {
        schemaVersion: 1,
        agentId: 'agent-1',
        channelId: 'channel-1',
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'message-1' },
          sourceRevision: 0,
        },
        objectiveSnapshot: objective,
        orchestrationNeed: true,
        scopeDecision: 'within-authorized-scope',
        simpleRequest: {
          messageId: 'message-1',
          dispatchId: 'dispatch-1',
          targetAgentId: 'agent-1',
        },
      },
      idempotencyKey: 'escalate-stale',
      approverId: 'user-1',
    });
    expect(result.outcome).toBe('freshness_hold');
    expect((await repositories.dispatches.getById('dispatch-1'))?.status).toBe('running');
    expect(await repositories.taskCoordinationUnitOfWork.run(async (repos) =>
      repos.promotion.handoffs.getBySourceDispatchId('dispatch-1'))).toBeNull();
  });

  test('Agent escalation 收敛到既有 root Task 时仍原子完成 fence、Offer 与 handoff', async () => {
    const { repositories, service } = harness();
    await seedSimpleRequest(repositories);
    await service.upsertTeamPolicy({
      schemaVersion: 1,
      teamId: 'team-1',
      revision: 1,
      enabled: true,
      ruleId: 'structured-workflow',
      preauthorized: true,
      requireOrchestrationNeed: true,
      updatedAt: 1_000,
    });
    const promoted = await service.applyTeamPolicy({
      requesterId: 'user-1',
      channelId: 'channel-1',
      ruleId: 'structured-workflow',
      orchestrationNeed: true,
      objectiveSnapshot: objective,
      freshnessBasis: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: 'message-1' },
        sourceRevision: 1,
      },
      idempotencyKey: 'policy-before-escalation',
    });
    expect(promoted.outcome).toBe('applied');

    const result = await service.escalateAgent({
      escalation: {
        schemaVersion: 1,
        agentId: 'agent-1',
        channelId: 'channel-1',
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'message-1' },
          sourceRevision: 1,
        },
        objectiveSnapshot: objective,
        orchestrationNeed: true,
        scopeDecision: 'within-authorized-scope',
        simpleRequest: {
          messageId: 'message-1',
          dispatchId: 'dispatch-1',
          targetAgentId: 'agent-1',
        },
      },
      idempotencyKey: 'escalate-existing-root',
      approverId: 'user-1',
    });

    expect(result.outcome).toBe('replayed');
    expect(result.result?.disposition).toBe('existing');
    expect((await repositories.dispatches.getById('dispatch-1'))?.status).toBe('cancelled');
    const handoff = await repositories.taskCoordinationUnitOfWork.run((repos) =>
      repos.promotion.handoffs.getBySourceDispatchId('dispatch-1'));
    expect(handoff?.rootTaskId).toBe(promoted.result?.rootTaskId);
    expect(await repositories.taskCoordination.offers.listByTask(promoted.result!.rootTaskId))
      .toEqual([expect.objectContaining({ id: handoff!.targetedOfferId, hardSpecified: true })]);
  });

  test('Agent 越界 escalation 在 rollout off 时仍强制生成 proposal，不 direct promote', async () => {
    const { repositories, service } = harness();
    await seedSimpleRequest(repositories);
    const result = await service.escalateAgent({
      escalation: {
        schemaVersion: 1,
        agentId: 'agent-1',
        channelId: 'channel-1',
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'message-1' },
          sourceRevision: 1,
        },
        objectiveSnapshot: { ...objective, riskLevel: 'high' },
        orchestrationNeed: true,
        scopeDecision: 'expands-authorized-scope',
        simpleRequest: {
          messageId: 'message-1',
          dispatchId: 'dispatch-1',
          targetAgentId: 'agent-1',
        },
      },
      idempotencyKey: 'escalate-out-of-scope',
      approverId: 'user-1',
    });
    expect(result).toMatchObject({
      path: { kind: 'show-proposal' },
      disposition: 'created',
    });
    expect((await repositories.dispatches.getById('dispatch-1'))?.status).toBe('running');
    expect(await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    })).toEqual([]);
  });

  test('target Agent manifest 在提交事务内失效时回滚 Task 与旧执行权', async () => {
    const { repositories, service } = harness({ manifestRevision: null });
    await seedSimpleRequest(repositories);
    await expect(service.escalateAgent({
      escalation: {
        schemaVersion: 1,
        agentId: 'agent-1',
        channelId: 'channel-1',
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'message-1' },
          sourceRevision: 1,
        },
        objectiveSnapshot: objective,
        orchestrationNeed: true,
        scopeDecision: 'within-authorized-scope',
        simpleRequest: {
          messageId: 'message-1',
          dispatchId: 'dispatch-1',
          targetAgentId: 'agent-1',
        },
      },
      idempotencyKey: 'escalate-manifest-revoked',
      approverId: 'user-1',
    })).resolves.toEqual({
      outcome: 'rejected',
      stableCode: 'TARGET_AGENT_MANIFEST_NOT_ACTIVE',
    });
    expect((await repositories.dispatches.getById('dispatch-1'))?.status).toBe('running');
    expect(await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    })).toEqual([]);
  });

  test('handoff 写入失败会回滚 root Task 与旧 Dispatch fencing', async () => {
    const { repositories, service } = harness();
    await seedSimpleRequest(repositories);
    await repositories.taskCoordinationUnitOfWork.run(async (repos) => {
      await repos.promotion.handoffs.create({
        id: 'existing-handoff',
        teamId: 'team-1',
        sourceMessageId: 'message-1',
        sourceDispatchId: 'dispatch-1',
        targetAgentId: 'agent-1',
        rootTaskId: 'old-task',
        managementRunId: 'old-run',
        status: 'applied',
        targetedOfferRequired: true,
        targetedOfferId: 'old-offer',
        materialJson: '{}',
        createdAt: 1_000,
      });
    });

    await expect(service.escalateAgent({
      escalation: {
        schemaVersion: 1,
        agentId: 'agent-1',
        channelId: 'channel-1',
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'message-1' },
          sourceRevision: 1,
        },
        objectiveSnapshot: objective,
        orchestrationNeed: true,
        scopeDecision: 'within-authorized-scope',
        simpleRequest: {
          messageId: 'message-1',
          dispatchId: 'dispatch-1',
          targetAgentId: 'agent-1',
        },
      },
      idempotencyKey: 'escalate-conflict',
      approverId: 'user-1',
    })).resolves.toEqual({
      outcome: 'conflict',
      stableCode: 'SIMPLE_REQUEST_HANDOFF_CONFLICT',
    });
    expect((await repositories.dispatches.getById('dispatch-1'))?.status).toBe('running');
    expect(await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    })).toEqual([]);
  });
});

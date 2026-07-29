import { describe, expect, test } from 'vitest';

import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('#923 Promotion modes production usecase wiring', () => {
  test('Owner 配置 rollout，合法 Admin approver 经公开 usecase 接受 proposal', async () => {
    const repositories = createInMemoryRepositories();
    let id = 0;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1_000 },
      ids: { nextId: () => `generated-${++id}` },
      sessionSecret: 'promotion-test-secret',
    });
    await repositories.teams.create({
      id: 'team-1',
      name: 'Team',
      path: 'team',
      visibility: 'private',
      ownerId: 'owner-1',
      createdAt: 1_000,
    });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'owner-1',
      username: 'owner',
      role: 'owner',
      joinedAt: 1_000,
    });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'reviewer-1',
      username: 'reviewer',
      role: 'admin',
      joinedAt: 1_000,
    });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'member-1',
      username: 'member',
      role: 'member',
      joinedAt: 1_000,
    });
    await repositories.channels.create({
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel',
      name: 'delivery',
      title: 'delivery',
      visibility: 'private',
      humanMemberIds: ['owner-1', 'reviewer-1', 'member-1'],
      agentMemberIds: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await repositories.messages.append({
      id: 'message-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      senderKind: 'human',
      senderId: 'member-1',
      body: '请协调多个 Agent 完成交付',
      createdAt: 1_000,
      meta: { revision: 1 },
    });

    await expect(app.updateSemanticPromotionRollout({
      userId: 'member-1',
      teamId: 'team-1',
      state: {
        schemaVersion: 1,
        teamId: 'team-1',
        mode: 'proposal-only',
        revision: 1,
        updatedAt: 1_000,
      },
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.updateSemanticPromotionRollout({
      userId: 'owner-1',
      teamId: 'team-1',
      state: {
        schemaVersion: 1,
        teamId: 'team-1',
        mode: 'proposal-only',
        revision: 1,
        updatedAt: 1_000,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(app.updateSemanticPromotionRollout({
      userId: 'owner-1',
      teamId: 'team-1',
      state: {
        schemaVersion: 1,
        teamId: 'team-1',
        mode: 'off',
        revision: 1,
        updatedAt: 1_001,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: 'SEMANTIC_PROMOTION_ROLLOUT_REVISION_CONFLICT',
    });

    const evaluated = await app.evaluateSemanticPromotion({
      userId: 'member-1',
      teamId: 'team-1',
      command: {
        schemaVersion: 1,
        channelId: 'channel-1',
        approverId: 'reviewer-1',
        evaluation: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'message-1' },
          sourceRevision: 1,
          verdict: 'proposal',
          objectiveSnapshot: {
            schemaVersion: 1,
            objective: '协调多个 Agent 完成交付',
            scope: '当前频道',
            riskLevel: 'low',
          },
          rationaleCode: 'ORCHESTRATION_NEEDED',
        },
      },
    });
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) throw new Error('proposal evaluation failed');
    const proposal = (evaluated.result as {
      proposal: { id: string; revision: number; authorizationToken: string };
    }).proposal;
    const accepted = await app.actOnPromotionProposal({
      userId: 'reviewer-1',
      teamId: 'team-1',
      action: {
        schemaVersion: 1,
        action: 'accept',
        proposalId: proposal.id,
        expectedRevision: proposal.revision,
        authorizationToken: proposal.authorizationToken,
        idempotencyKey: 'accept-1',
      },
    });
    expect(accepted).toMatchObject({
      ok: true,
      result: { outcome: 'applied', stableCode: 'PROPOSAL_ACCEPTED' },
    });
  });
});

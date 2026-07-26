import { afterEach, describe, expect, test } from 'vitest';

import {
  bootAcceptanceServer,
  createClaimableTask,
  queryCount,
  registerDeviceAgent,
  registerUser,
  respondToOffer,
  type AcceptanceAgent,
  type AcceptanceServer,
} from './harness.js';

describe('AC2：required Skill 硬过滤与显式 Offer 响应', () => {
  let server: AcceptanceServer | undefined;
  const agents: AcceptanceAgent[] = [];

  afterEach(async () => {
    for (const agent of agents) agent.socket.disconnect();
    agents.length = 0;
    await server?.close();
    server = undefined;
  });

  test('两个 Agent 联合覆盖不同 Skill；每个 Task 仅向合格者 Offer，接受才有 Claim，拒绝无 Lease', async () => {
    server = await bootAcceptanceServer();
    const owner = await registerUser(server.baseUrl, { username: 'ac2-owner' });
    const researcher = await registerDeviceAgent(owner, server.baseUrl, {
      name: 'Researcher',
      machineId: 'ac2-research',
      skills: ['research'],
      capabilities: ['execute'],
    });
    const reviewer = await registerDeviceAgent(owner, server.baseUrl, {
      name: 'Reviewer',
      machineId: 'ac2-review',
      skills: ['code-review'],
      capabilities: ['execute'],
    });
    agents.push(researcher, reviewer);
    const broker = server.bundle.taskClaimBroker;
    expect(broker).toBeDefined();

    const researchTask = await createClaimableTask(server, owner, {
      key: 'research',
      title: '收集发布证据',
      requiredCapabilities: ['execute'],
      requiredSkills: ['research'],
      preferredSkills: ['code-review'],
    });
    const researchResolution = await broker!.resolveCandidates(researchTask.taskId);
    expect(researchResolution.candidates.find((candidate) => candidate.agentId === researcher.agentId))
      .toMatchObject({ eligible: true });
    expect(researchResolution.candidates.find((candidate) => candidate.agentId === reviewer.agentId))
      .toMatchObject({ eligible: false, diagnosticCodes: expect.arrayContaining(['CAPABILITY_MISSING']) });
    const researchOffers = await broker!.prepareOffers(researchTask.taskId);
    expect(researchOffers.map((offer) => offer.agentId)).toEqual([researcher.agentId]);
    await expect(respondToOffer(researcher, researchOffers[0]!.offerId, 'accepted'))
      .resolves.toMatchObject({ kind: 'claim_granted' });

    const reviewTask = await createClaimableTask(server, owner, {
      key: 'review',
      title: '审核发布证据',
      requiredCapabilities: ['execute'],
      requiredSkills: ['code-review'],
      preferredSkills: ['research'],
    });
    const reviewOffers = await broker!.prepareOffers(reviewTask.taskId);
    expect(reviewOffers.map((offer) => offer.agentId)).toEqual([reviewer.agentId]);
    await expect(respondToOffer(reviewer, reviewOffers[0]!.offerId, 'rejected', '当前不可用'))
      .resolves.toMatchObject({ kind: 'response_recorded', status: 'rejected' });

    const db = server.openTeamDb();
    try {
      expect(queryCount(db, "SELECT COUNT(*) AS n FROM task_offers WHERE status = 'accepted'")).toBe(1);
      expect(queryCount(db, "SELECT COUNT(*) AS n FROM task_offers WHERE status = 'rejected'")).toBe(1);
      expect(queryCount(db, "SELECT COUNT(*) AS n FROM task_claim_leases WHERE status = 'active'")).toBe(1);
      expect(queryCount(
        db,
        'SELECT COUNT(*) AS n FROM task_claim_leases WHERE task_id = ?',
        reviewTask.taskId,
      )).toBe(0);
    } finally {
      db.close();
    }
    owner.socket.disconnect();
  });
});

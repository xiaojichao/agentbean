import { afterEach, describe, expect, test } from 'vitest';

import {
  activateControllablePiModel,
  bootAcceptanceServer,
  coordinationChatBody,
  createClaimableTask,
  promoteToSystemAdmin,
  queryCount,
  registerDeviceAgent,
  registerUser,
  respondToOffer,
  startControllableProvider,
  type AcceptanceServer,
  type ControllableProvider,
} from './harness.js';

describe('AC1：普通聊天与显式任务的生产协调链路', () => {
  let server: AcceptanceServer | undefined;
  let provider: ControllableProvider | undefined;

  afterEach(async () => {
    await server?.close();
    await provider?.close();
    server = undefined;
    provider = undefined;
  });

  test('普通聊天被理解但不创建 Task，明确作为任务才创建', async () => {
    provider = await startControllableProvider();
    server = await bootAcceptanceServer();
    const owner = await registerUser(server.baseUrl, { username: 'ac1-owner' });
    promoteToSystemAdmin(server, owner.userId);
    await activateControllablePiModel(server, owner.userId, provider);

    provider.push({
      kind: 'chat',
      body: coordinationChatBody({ intent: 'no_action', reasonCode: 'greeting' }),
    });
    const chatAck = await owner.sendMessage({
      body: '大家早上好',
      clientMessageId: 'ac1-chat',
    });
    expect(chatAck).toMatchObject({ ok: true });
    await server.app.runCoordinationCycle();

    const db = server.openTeamDb();
    try {
      expect(queryCount(db, 'SELECT COUNT(*) AS n FROM channel_coordination_decisions')).toBe(1);
      expect(queryCount(db, "SELECT COUNT(*) AS n FROM channel_coordination_decisions WHERE intent = 'no_action'")).toBe(1);
      expect(queryCount(db, 'SELECT COUNT(*) AS n FROM tasks')).toBe(0);
    } finally {
      db.close();
    }

    provider.push({
      kind: 'chat',
      body: coordinationChatBody({
        intent: 'tracked_task',
        reasonCode: 'explicit_task',
        risk: 'low',
        objective: '整理本周发布说明',
      }),
    });
    const taskAck = await owner.sendMessage({
      body: '请作为任务整理本周发布说明',
      clientMessageId: 'ac1-task',
      asTask: true,
    });
    expect(taskAck).toMatchObject({ ok: true });
    await server.app.runCoordinationCycle();

    const verified = server.openTeamDb();
    try {
      expect(queryCount(verified, 'SELECT COUNT(*) AS n FROM tasks')).toBe(1);
      expect(queryCount(
        verified,
        "SELECT COUNT(*) AS n FROM channel_coordination_decisions WHERE intent = 'tracked_task' AND gate_status = 'applied' AND linked_task_id IS NOT NULL",
      )).toBe(1);
    } finally {
      verified.close();
    }
    owner.socket.disconnect();
  });

  test('显式定向 Agent 拒绝 Offer 后不 Claim，也不静默改派', async () => {
    server = await bootAcceptanceServer();
    const owner = await registerUser(server.baseUrl, { username: 'ac1-target-owner' });
    const target = await registerDeviceAgent(owner, server.baseUrl, {
      name: 'Target Agent',
      machineId: 'ac1-target',
      skills: ['delivery'],
      capabilities: ['execute'],
    });
    const fallback = await registerDeviceAgent(owner, server.baseUrl, {
      name: 'Fallback Agent',
      machineId: 'ac1-fallback',
      skills: ['delivery'],
      capabilities: ['execute'],
    });
    const task = await createClaimableTask(server, owner, {
      key: 'target-reject',
      title: '只交给点名 Agent',
      claimPolicy: 'targeted',
      targetAgentId: target.agentId,
      requiredCapabilities: ['execute'],
      requiredSkills: ['delivery'],
    });
    const offers = await server.bundle.taskClaimBroker!.prepareOffers(task.taskId);
    expect(offers.map((offer) => offer.agentId)).toEqual([target.agentId]);
    await expect(respondToOffer(target, offers[0]!.offerId, 'rejected', '拒绝当前请求'))
      .resolves.toMatchObject({ kind: 'response_recorded', status: 'rejected' });

    const db = server.openTeamDb();
    try {
      expect(queryCount(db, 'SELECT COUNT(*) AS n FROM task_claim_leases WHERE task_id = ?', task.taskId)).toBe(0);
      expect(queryCount(
        db,
        'SELECT COUNT(*) AS n FROM task_offers WHERE task_id = ? AND agent_id = ?',
        task.taskId,
        fallback.agentId,
      )).toBe(0);
    } finally {
      db.close();
    }
    target.socket.disconnect();
    fallback.socket.disconnect();
    owner.socket.disconnect();
  });
});

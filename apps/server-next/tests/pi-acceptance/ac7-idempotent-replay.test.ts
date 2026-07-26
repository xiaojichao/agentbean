import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  activateControllablePiModel,
  bootAcceptanceServer,
  coordinationChatBody,
  promoteToSystemAdmin,
  queryCount,
  registerUser,
  startControllableProvider,
  type AcceptanceServer,
  type ControllableProvider,
} from './harness.js';

describe('AC7：Coordinator 重启与 Job 重放幂等', () => {
  const dataDirs: string[] = [];
  let server: AcceptanceServer | undefined;
  let provider: ControllableProvider | undefined;

  afterEach(async () => {
    await server?.close();
    await provider?.close();
    for (const dataDir of dataDirs) rmSync(dataDir, { recursive: true, force: true });
    dataDirs.length = 0;
    server = undefined;
    provider = undefined;
  });

  test('同一 SQLite 上重启并重放同一 Job 不重复 Decision、Task 或系统消息', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-ac7-replay-'));
    dataDirs.push(dataDir);
    provider = await startControllableProvider();
    server = await bootAcceptanceServer({ dataDir });
    const owner = await registerUser(server.baseUrl, { username: 'ac7-owner' });
    promoteToSystemAdmin(server, owner.userId);
    await activateControllablePiModel(server, owner.userId, provider);
    provider.push({
      kind: 'chat',
      body: coordinationChatBody({
        intent: 'tracked_task',
        reasonCode: 'needs_tracking',
        risk: 'low',
        objective: '生成发布验收记录',
      }),
    });

    await expect(owner.sendMessage({
      body: '请作为任务生成发布验收记录',
      clientMessageId: 'ac7-replay',
      asTask: true,
    })).resolves.toMatchObject({ ok: true });
    await server.app.runCoordinationCycle();

    const db = server.openTeamDb();
    let jobId: string;
    try {
      jobId = (db.prepare('SELECT id FROM channel_coordination_jobs LIMIT 1').get() as { id: string }).id;
      expect(snapshotCounts(db)).toEqual({
        decisions: 1,
        tasks: 1,
        systemMessages: 1,
        offers: 0,
        claims: 0,
        memories: 0,
      });
    } finally {
      db.close();
    }
    const callsBeforeRestart = provider.coordinationCalls();
    owner.socket.disconnect();
    await server.close();

    server = await bootAcceptanceServer({ dataDir });
    await server.app.runCoordinationCycle({ now: Date.now() + 60_000 });
    await expect(server.app.processCoordinationJob(jobId)).resolves.toMatchObject({
      kind: 'already_decided',
    });

    const replayed = server.openTeamDb();
    try {
      expect(snapshotCounts(replayed)).toEqual({
        decisions: 1,
        tasks: 1,
        systemMessages: 1,
        offers: 0,
        claims: 0,
        memories: 0,
      });
    } finally {
      replayed.close();
    }
    expect(provider.coordinationCalls()).toBe(callsBeforeRestart);
  });
});

function snapshotCounts(db: ReturnType<AcceptanceServer['openTeamDb']>) {
  return {
    decisions: queryCount(db, 'SELECT COUNT(*) AS n FROM channel_coordination_decisions'),
    tasks: queryCount(db, 'SELECT COUNT(*) AS n FROM tasks'),
    systemMessages: queryCount(db, "SELECT COUNT(*) AS n FROM messages WHERE sender_kind = 'system'"),
    offers: queryCount(db, 'SELECT COUNT(*) AS n FROM task_offers'),
    claims: queryCount(db, 'SELECT COUNT(*) AS n FROM task_claim_leases'),
    memories: queryCount(db, 'SELECT COUNT(*) AS n FROM memory_items'),
  };
}

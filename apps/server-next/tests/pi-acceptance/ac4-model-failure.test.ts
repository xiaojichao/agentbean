import { afterEach, describe, expect, test } from 'vitest';

import {
  activateControllablePiModel,
  bootAcceptanceServer,
  promoteToSystemAdmin,
  queryCount,
  registerUser,
  startControllableProvider,
  type AcceptanceServer,
  type ControllableProvider,
  type ProviderResponseSpec,
} from './harness.js';

describe('AC4：Active PI Model 故障不阻断消息且暂停副作用', () => {
  let server: AcceptanceServer | undefined;
  let provider: ControllableProvider | undefined;

  afterEach(async () => {
    await server?.close();
    await provider?.close();
    server = undefined;
    provider = undefined;
  });

  test.each([
    ['401', (): ProviderResponseSpec => ({ kind: 'error', status: 401 })],
    ['非 JSON', (): ProviderResponseSpec => ({ kind: 'raw', body: '<not-json>' })],
    ['超时', (): ProviderResponseSpec => ({ kind: 'hang' })],
  ])('%s 故障时消息先保存，最终不产生 Task/Offer/Claim/Memory', async (_label, response) => {
    provider = await startControllableProvider();
    server = await bootAcceptanceServer();
    const owner = await registerUser(server.baseUrl, { username: `ac4-${_label}` });
    promoteToSystemAdmin(server, owner.userId);
    await activateControllablePiModel(server, owner.userId, provider, { timeoutMs: 1_000 });
    provider.push(response());
    provider.push(response());
    provider.push(response());

    const ack = await owner.sendMessage({
      body: '请整理故障期间的发布说明',
      clientMessageId: `ac4-${_label}`,
      asTask: true,
    });
    expect(ack).toMatchObject({ ok: true });

    const db = server.openTeamDb();
    let jobId: string;
    try {
      expect(queryCount(db, "SELECT COUNT(*) AS n FROM messages WHERE sender_kind = 'human'")).toBe(1);
      jobId = (db.prepare('SELECT id FROM channel_coordination_jobs LIMIT 1').get() as { id: string }).id;
    } finally {
      db.close();
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await server.app.runCoordinationCycle({ now: Date.now() + (attempt + 1) * 60_000 });
    }

    const verified = server.openTeamDb();
    try {
      expect(queryCount(verified, "SELECT COUNT(*) AS n FROM channel_coordination_jobs WHERE status = 'failed'")).toBe(1);
      expect(queryCount(verified, "SELECT COUNT(*) AS n FROM messages WHERE sender_kind = 'human'")).toBe(1);
      expect(queryCount(verified, 'SELECT COUNT(*) AS n FROM tasks')).toBe(0);
      expect(queryCount(verified, 'SELECT COUNT(*) AS n FROM task_offers')).toBe(0);
      expect(queryCount(verified, 'SELECT COUNT(*) AS n FROM task_claim_leases')).toBe(0);
      expect(queryCount(verified, 'SELECT COUNT(*) AS n FROM memory_items')).toBe(0);
    } finally {
      verified.close();
    }
    owner.socket.disconnect();
  });
});

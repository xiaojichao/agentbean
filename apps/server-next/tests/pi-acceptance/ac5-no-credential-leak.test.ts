import { afterEach, describe, expect, test } from 'vitest';

import { WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import {
  activateControllablePiModel,
  bootAcceptanceServer,
  inviteMember,
  promoteToSystemAdmin,
  registerUser,
  startControllableProvider,
  type AcceptanceServer,
  type ControllableProvider,
} from './harness.js';

const SUPPLY_IDENTITY = /provider|model|endpoint|credential|baseurl|apikey/i;

describe('AC5：Team 成员的 Socket payload 不泄漏 PI 供给身份', () => {
  let server: AcceptanceServer | undefined;
  let provider: ControllableProvider | undefined;

  afterEach(async () => {
    await server?.close();
    await provider?.close();
    server = undefined;
    provider = undefined;
  });

  test('公开健康、Team 设置、Team 列表和频道历史均安全，管理事件 fail closed', async () => {
    provider = await startControllableProvider();
    server = await bootAcceptanceServer();
    const owner = await registerUser(server.baseUrl, { username: 'ac5-owner' });
    promoteToSystemAdmin(server, owner.userId);
    await activateControllablePiModel(server, owner.userId, provider);
    const member = await inviteMember(owner, server.baseUrl, 'ac5-member');

    const globalDb = server.openGlobalDb();
    try {
      globalDb.prepare("UPDATE pi_provider_credentials SET encrypted_payload = 'invalid'").run();
    } finally {
      globalDb.close();
    }

    const payloads = [
      await member.emitWithAck(WEB_EVENTS.piProvider.getPublicHealth, {}),
      await member.emitWithAck(WEB_EVENTS.piPolicy.get, { teamId: member.teamId }),
      await member.emitWithAck(WEB_EVENTS.team.list, {}),
      await member.emitWithAck(WEB_EVENTS.channel.join, {
        teamId: member.teamId,
        channelId: member.channelId,
        limit: 50,
      }),
    ];
    expect(payloads[0]).toMatchObject({
      ok: true,
      health: { status: 'unavailable', diagnosticCode: 'PI_UNAVAILABLE' },
    });
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).not.toMatch(SUPPLY_IDENTITY);
    }

    const denied = [
      await member.emitWithAck(WEB_EVENTS.piProvider.getActiveModel, {}),
      await member.emitWithAck(WEB_EVENTS.piProvider.listCards, {}),
      await member.emitWithAck(WEB_EVENTS.piProvider.listPresets, {}),
    ];
    for (const ack of denied) {
      expect(ack).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    }

    member.socket.disconnect();
    owner.socket.disconnect();
  });
});

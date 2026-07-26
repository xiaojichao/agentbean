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

describe('AC5：Team 角色的 Socket payload 不泄漏 PI 供给身份', () => {
  let server: AcceptanceServer | undefined;
  let provider: ControllableProvider | undefined;

  afterEach(async () => {
    await server?.close();
    await provider?.close();
    server = undefined;
    provider = undefined;
  });

  test('owner/admin/member 的公开 payload 均安全，供给管理事件 fail closed', async () => {
    provider = await startControllableProvider();
    server = await bootAcceptanceServer();
    const owner = await registerUser(server.baseUrl, { username: 'ac5-owner' });
    promoteToSystemAdmin(server, owner.userId);
    await activateControllablePiModel(server, owner.userId, provider);
    const admin = await inviteMember(owner, server.baseUrl, 'ac5-admin');
    const member = await inviteMember(owner, server.baseUrl, 'ac5-member');
    await expect(owner.emitWithAck(WEB_EVENTS.member.updateRole, {
      teamId: owner.teamId,
      targetUserId: admin.userId,
      role: 'admin',
    })).resolves.toMatchObject({ ok: true, member: { userId: admin.userId, role: 'admin' } });

    const globalDb = server.openGlobalDb();
    try {
      globalDb.prepare("UPDATE pi_provider_credentials SET encrypted_payload = 'invalid'").run();
      globalDb.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(owner.userId);
    } finally {
      globalDb.close();
    }

    for (const teamUser of [owner, admin, member]) {
      const payloads = [
        await teamUser.emitWithAck(WEB_EVENTS.piProvider.getPublicHealth, {}),
        await teamUser.emitWithAck(WEB_EVENTS.piPolicy.get, { teamId: teamUser.teamId }),
        await teamUser.emitWithAck(WEB_EVENTS.team.list, {}),
        await teamUser.emitWithAck(WEB_EVENTS.channel.join, {
          teamId: teamUser.teamId,
          channelId: teamUser.channelId,
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
        await teamUser.emitWithAck(WEB_EVENTS.piProvider.getActiveModel, {}),
        await teamUser.emitWithAck(WEB_EVENTS.piProvider.listCards, {}),
        await teamUser.emitWithAck(WEB_EVENTS.piProvider.listPresets, {}),
      ];
      for (const ack of denied) {
        expect(ack).toMatchObject({ ok: false, error: 'FORBIDDEN' });
      }
    }

    admin.socket.disconnect();
    member.socket.disconnect();
    owner.socket.disconnect();
  });
});

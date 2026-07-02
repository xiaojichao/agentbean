import { describe, expect, test } from 'vitest';
import { canAddCustomAgentToDevice, canManageDeviceForUser } from '../lib/device-permissions';

describe('device detail permissions', () => {
  // canAddCustomAgentToDevice 必须对齐后端 createCustomAgent 的双重守卫：
  //   canManageDeviceAsUser(拥有者/admin, usecases.ts:1799) AND isDeviceLocal(本机, usecases.ts:1802)
  // 任一不满足都应返回 false，否则会放行一个被后端拒绝的操作（FORBIDDEN / FORBIDDEN_REMOTE_DEVICE_SETTINGS），
  // 让用户填完表单才撞错误码。
  test('denies non-local device owners from adding custom agent (对齐后端 isLocal 守卫)', () => {
    // 拥有者(canManage=true)但非本机(isLocal=false，如普通账号登录无 deviceId)：
    // 后端 isDeviceLocalToHint 守卫会拒(FORBIDDEN_REMOTE_DEVICE_SETTINGS)。
    expect(canAddCustomAgentToDevice({ canManageDevice: true, isLocalDevice: false })).toBe(false);
  });

  test('denies local non-owners from adding custom agent (对齐后端 canManageDeviceAsUser)', () => {
    // 本机(isLocal=true)但非拥有者(canManage=false)：后端 canManageDeviceAsUser 会拒(FORBIDDEN)。
    const canManageDevice = canManageDeviceForUser({
      deviceOwnerId: 'owner-1',
      currentUserId: 'member-1',
      currentUserRole: 'user',
      currentTeamRole: 'member',
    });

    expect(canManageDevice).toBe(false);
    expect(canAddCustomAgentToDevice({ canManageDevice, isLocalDevice: true })).toBe(false);
  });

  test('lets local device owners add custom agent', () => {
    expect(canAddCustomAgentToDevice({ canManageDevice: true, isLocalDevice: true })).toBe(true);
  });

  test('denies team owner/admin roles managing remote devices (收紧：仅设备拥有者/系统管理员)', () => {
    for (const currentTeamRole of ['owner', 'admin'] as const) {
      expect(
        canManageDeviceForUser({
          deviceOwnerId: 'owner-1',
          currentUserId: 'member-1',
          currentUserRole: 'user',
          currentTeamRole,
        }),
      ).toBe(false);
    }
  });

  test('lets the device owner manage their own device', () => {
    expect(
      canManageDeviceForUser({
        deviceOwnerId: 'owner-1',
        currentUserId: 'owner-1',
        currentUserRole: 'user',
      }),
    ).toBe(true);
  });

  test('lets a system admin (user.role=admin) manage any device', () => {
    expect(
      canManageDeviceForUser({
        deviceOwnerId: 'owner-1',
        currentUserId: 'member-1',
        currentUserRole: 'admin',
      }),
    ).toBe(true);
  });

  test('honors an explicit server-side device.canManage value', () => {
    expect(
      canManageDeviceForUser({
        deviceCanManage: false,
        deviceOwnerId: 'owner-1',
        currentUserId: 'member-1',
        currentUserRole: 'admin',
        currentTeamRole: 'admin',
      }),
    ).toBe(false);
  });
});

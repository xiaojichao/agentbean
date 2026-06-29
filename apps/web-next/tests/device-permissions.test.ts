import { describe, expect, test } from 'vitest';
import { canAddCustomAgentToDevice, canManageDeviceForUser } from '../lib/device-permissions';

describe('device detail permissions', () => {
  test('lets local devices keep the custom agent add entry even without management rights', () => {
    const canManageDevice = canManageDeviceForUser({
      deviceOwnerId: 'owner-1',
      currentUserId: 'member-1',
      currentUserRole: 'user',
      currentTeamRole: 'member',
    });

    expect(canManageDevice).toBe(false);
    expect(canAddCustomAgentToDevice({ canManageDevice, isLocalDevice: true })).toBe(true);
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

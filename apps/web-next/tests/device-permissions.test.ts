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

  test('lets team owner and admin roles manage remote devices before device.canManage is populated', () => {
    for (const currentTeamRole of ['owner', 'admin'] as const) {
      expect(
        canManageDeviceForUser({
          deviceOwnerId: 'owner-1',
          currentUserId: 'member-1',
          currentUserRole: 'user',
          currentTeamRole,
        }),
      ).toBe(true);
    }
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

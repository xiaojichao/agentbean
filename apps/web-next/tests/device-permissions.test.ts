import { describe, expect, test } from 'vitest';
import { canAddCustomAgentToDevice, canBrowseDirectory, canManageDeviceForUser, hasLocalDevice, requiresDeleteNameConfirm } from '../lib/device-permissions';

describe('device detail permissions', () => {
  // canAddCustomAgentToDevice：runtime 配置由设备拥有者授权（canManageDeviceAsUser），
  // 不再强制本机 —— 否则账号密码登录（无 deviceId）的拥有者（含物理本机）会被误判远程、按钮消失。
  test('设备拥有者可添加 custom agent（不论本机/远程）', () => {
    expect(canAddCustomAgentToDevice({ canManageDevice: true })).toBe(true);
  });

  test('非设备拥有者不可添加 custom agent', () => {
    const canManageDevice = canManageDeviceForUser({
      deviceOwnerId: 'owner-1',
      currentUserId: 'member-1',
      currentUserRole: 'user',
      currentTeamRole: 'member',
    });
    expect(canManageDevice).toBe(false);
    expect(canAddCustomAgentToDevice({ canManageDevice })).toBe(false);
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

describe('device local/remote distinction (本机/远程分流)', () => {
  test('canBrowseDirectory: 仅本机可浏览目录，远程降级手动填', () => {
    expect(canBrowseDirectory(true)).toBe(true);
    expect(canBrowseDirectory(false)).toBe(false);
    expect(canBrowseDirectory(undefined)).toBe(false);
    expect(canBrowseDirectory(null)).toBe(false);
  });

  test('requiresDeleteNameConfirm: 远程删除需输入设备名，本机无需', () => {
    expect(requiresDeleteNameConfirm(true)).toBe(false);
    expect(requiresDeleteNameConfirm(false)).toBe(true);
    expect(requiresDeleteNameConfirm(undefined)).toBe(true);
  });

  test('hasLocalDevice: 含本机设备为真，全远程/空为假', () => {
    expect(hasLocalDevice([{ isLocal: true }, { isLocal: false }])).toBe(true);
    expect(hasLocalDevice([{ isLocal: false }, { isLocal: undefined }])).toBe(false);
    expect(hasLocalDevice([])).toBe(false);
  });
});

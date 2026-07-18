import { describe, expect, test } from 'vitest';
import { canAddCustomAgentToDevice, canBrowseDirectory, canManageDeviceForUser, directoryBrowseMode, FS_BROWSE_MIN_DAEMON_VERSION, requiresDeleteNameConfirm } from '../lib/device-permissions';

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
  test('requiresDeleteNameConfirm: 远程删除需输入设备名，本机无需', () => {
    expect(requiresDeleteNameConfirm(true)).toBe(false);
    expect(requiresDeleteNameConfirm(false)).toBe(true);
    expect(requiresDeleteNameConfirm(undefined)).toBe(true);
    expect(requiresDeleteNameConfirm(null)).toBe(true);
  });
});

// 切片5（#640）：目录浏览门控从身份（isLocal）切换到能力（fsBrowse）。
// 三态矩阵（spec §5.4）：fsBrowse 设备 → tree（树形选择器，完全不读 isLocal）；
// 旧 daemon + 本机 → native-picker（osascript 弹窗兼容分支）；旧 daemon + 远程 → manual（D1 兜底）。
describe('directoryBrowseMode 能力门控三态矩阵（切片5）', () => {
  test('fsBrowse=true → tree，与 isLocal 无关（主路径不读 isLocal）', () => {
    expect(directoryBrowseMode({ fsBrowse: true, isLocal: true })).toBe('tree');
    expect(directoryBrowseMode({ fsBrowse: true, isLocal: false })).toBe('tree');
    expect(directoryBrowseMode({ fsBrowse: true, isLocal: undefined })).toBe('tree');
  });

  test('远程设备 + fsBrowse → tree（本次痛点：远程二等公民体验解决）', () => {
    expect(directoryBrowseMode({ fsBrowse: true, daemonVersion: null, isLocal: false })).toBe('tree');
  });

  test('能力字段缺失回退版本门：daemonVersion ≥ 0.3.11 → tree', () => {
    expect(directoryBrowseMode({ daemonVersion: FS_BROWSE_MIN_DAEMON_VERSION, isLocal: false })).toBe('tree');
    expect(directoryBrowseMode({ daemonVersion: '0.4.0', isLocal: undefined })).toBe('tree');
  });

  test('能力字段缺失 + 版本不足 → 非 tree', () => {
    expect(directoryBrowseMode({ daemonVersion: '0.3.10', isLocal: true })).toBe('native-picker');
    expect(directoryBrowseMode({ daemonVersion: '0.3.10', isLocal: false })).toBe('manual');
  });

  test('fsBrowse 显式 false 不走版本回退（daemon 明确无此能力）', () => {
    expect(directoryBrowseMode({ fsBrowse: false, daemonVersion: '9.9.9', isLocal: true })).toBe('native-picker');
  });

  test('旧 daemon（无能力无版本）+ 本机 → native-picker（弹窗行为不变）', () => {
    expect(directoryBrowseMode({ isLocal: true })).toBe('native-picker');
  });

  test('旧 daemon + 远程/未关联 → manual（D1 降级兜底）', () => {
    expect(directoryBrowseMode({ isLocal: false })).toBe('manual');
    expect(directoryBrowseMode({ isLocal: undefined })).toBe('manual');
    expect(directoryBrowseMode({ isLocal: null })).toBe('manual');
    expect(directoryBrowseMode({})).toBe('manual');
  });

  test('canBrowseDirectory = 非 manual（tree 或 native-picker 均可浏览）', () => {
    expect(canBrowseDirectory({ fsBrowse: true, isLocal: false })).toBe(true);
    expect(canBrowseDirectory({ isLocal: true })).toBe(true);
    expect(canBrowseDirectory({ isLocal: false })).toBe(false);
    expect(canBrowseDirectory({})).toBe(false);
  });
});

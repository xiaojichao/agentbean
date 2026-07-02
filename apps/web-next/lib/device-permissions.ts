type DeviceManageInput = {
  deviceCanManage?: boolean | null;
  deviceOwnerId?: string | null;
  currentUserId?: string | null;
  currentUserRole?: string | null;
  currentTeamRole?: string | null;
};

export function canManageDeviceForUser({
  deviceCanManage,
  deviceOwnerId,
  currentUserId,
  currentUserRole,
}: DeviceManageInput): boolean {
  // 仅系统管理员（user.role='admin'）或设备拥有者可管理设备。
  // 团队角色（team owner/admin）不再放行 —— 与后端 canManageDeviceAsUser 对齐。
  return deviceCanManage ?? (
    currentUserRole === 'admin' ||
    Boolean(currentUserId && currentUserId === deviceOwnerId)
  );
}

export function canAddCustomAgentToDevice({
  canManageDevice,
}: {
  canManageDevice: boolean;
}): boolean {
  // runtime 配置由设备拥有者授权（canManageDeviceAsUser），不再强制本机。
  // 旧「必须 isLocal」会拒绝账号密码登录（无 deviceId）的拥有者，含物理本机场景。
  return canManageDevice;
}

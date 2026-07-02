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
  isLocalDevice,
}: {
  canManageDevice: boolean;
  isLocalDevice: boolean;
}): boolean {
  // 对齐后端 createCustomAgent 双重守卫：canManageDeviceAsUser(拥有者/admin, usecases.ts:1799) AND isDeviceLocal(本机, usecases.ts:1802)。
  // 任一不满足都禁用，避免放行一个被后端拒绝的操作（FORBIDDEN / FORBIDDEN_REMOTE_DEVICE_SETTINGS），让用户填完表才撞错误码。
  return canManageDevice && isLocalDevice;
}

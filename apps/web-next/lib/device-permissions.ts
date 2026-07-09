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

// 远程设备（非本机）目录浏览：本机依赖 GUI 目录选择器，远程 daemon 多无桌面会话会挂起。
// 远程一律降级为手动填写项目绝对路径（isLocal !== true 视为远程，含未关联本机设备场景）。
export function canBrowseDirectory(isLocal: boolean | null | undefined): boolean {
  return isLocal === true;
}

// 远程设备删除加额外护栏（输入设备名确认）；本机维持现有确认。
export function requiresDeleteNameConfirm(isLocal: boolean | null | undefined): boolean {
  return isLocal !== true;
}

// 设备列表中是否存在本机设备（用于「未关联本机设备」引导提示）。
export function hasLocalDevice(devices: { isLocal?: boolean | null }[]): boolean {
  return devices.some((d) => d.isLocal === true);
}

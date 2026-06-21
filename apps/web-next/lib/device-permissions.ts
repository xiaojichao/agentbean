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
  currentTeamRole,
}: DeviceManageInput): boolean {
  return deviceCanManage ?? (
    currentTeamRole === 'owner' ||
    currentTeamRole === 'admin' ||
    currentUserRole === 'admin' ||
    currentUserRole === 'owner' ||
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
  return canManageDevice || isLocalDevice;
}

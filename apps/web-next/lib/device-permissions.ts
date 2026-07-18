import { versionAtLeast } from './daemon-version';

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

/**
 * 目录浏览的三种交互模式（spec §5.4 支持矩阵）：
 * - tree：fs:list 树形选择器（浏览器渲染，远程/headless 全功能）
 * - native-picker：旧 daemon 的 osascript/zenity 弹窗（需本机桌面会话）
 * - manual：手动填绝对路径（2026-07-09 D1 降级，保留为兜底）
 */
export type DirectoryBrowseMode = 'tree' | 'native-picker' | 'manual';

/** fs:list 随 daemon 0.3.11 发布（0.3.10 是 fs:list 合并前的最后一个 npm 版）。 */
export const FS_BROWSE_MIN_DAEMON_VERSION = '0.3.11';

/**
 * 目录浏览门控：能力驱动取代身份驱动（切片5，#640——推翻 2026-07-09 D1）。
 *
 * 主路径（fsBrowse 设备）完全不读 isLocal——本机误判 bug 在目录浏览场景结构性绝种；
 * 保留的 isLocal===true 仅服务「旧 daemon 弹窗」兼容降级分支，全设备升级后走不到。
 *
 * 能力判定优先看 capabilities.fsBrowse（daemon hello 自报，天然准确）；
 * 能力字段缺失（旧 DTO）才回退版本门。fsBrowse 显式 false = daemon 明确无能力，
 * 不走版本回退。版本为 null 时 fail-closed 不放行 tree；不可解析的非 null 版本串
 * 按 versionAtLeast 惯例 permissive 放行（daemonVersion 来自 systemInfo 恒为 semver，可接受）。
 */
export function directoryBrowseMode({
  fsBrowse,
  daemonVersion,
  isLocal,
}: {
  fsBrowse?: boolean | null;
  daemonVersion?: string | null;
  isLocal?: boolean | null;
}): DirectoryBrowseMode {
  const supportsFsBrowse =
    fsBrowse === true ||
    (fsBrowse == null && daemonVersion != null && versionAtLeast(daemonVersion, FS_BROWSE_MIN_DAEMON_VERSION));
  if (supportsFsBrowse) return 'tree';
  if (isLocal === true) return 'native-picker';
  return 'manual';
}

/** 是否有任何可视化的目录浏览入口（tree 或 native-picker）；manual 时仅能手填。 */
export function canBrowseDirectory(input: {
  fsBrowse?: boolean | null;
  daemonVersion?: string | null;
  isLocal?: boolean | null;
}): boolean {
  return directoryBrowseMode(input) !== 'manual';
}

// 远程设备删除加额外护栏（输入设备名确认）；本机维持现有确认。
export function requiresDeleteNameConfirm(isLocal: boolean | null | undefined): boolean {
  return isLocal !== true;
}

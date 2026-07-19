export interface DaemonVersionFields {
  status: string;
  latestDaemonVersion?: string | null;
  daemonUpdateAvailable?: boolean;
  daemonVersionInfo?: {
    current: string | null;
    latest: string | null;
    updateAvailable: boolean;
    status: 'current' | 'update-available' | 'unknown';
  };
  systemInfo?: { daemonVersion?: string } | null;
}

export interface DaemonVersionDisplay {
  currentLabel: string;
  latestLabel: string | null;
  updateAvailable: boolean;
  unknown: boolean;
}

export type DaemonUpgradeGuidance =
  | { mode: 'self-update'; command: 'agentbean update'; description: string }
  | { mode: 'bootstrap'; command: 'npm install -g @agentbean/daemon@latest && agentbean device install && agentbean device restart'; description: string }
  | { mode: 'legacy'; command: null; description: string };

const SELF_UPDATE_MIN_VERSION = '0.3.13';
const DEVICE_SERVICE_MVP_MIN_VERSION = '0.3.12';

function label(version?: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed || trimmed === 'unknown') return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

function parseVersionParts(version: string | null | undefined): number[] | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  const match = trimmed.replace(/^v/, '').match(/\d+(\.\d+)*/);
  if (!match) return null;
  return match[0].split('.').map((part) => Number(part) || 0);
}

/**
 * 语义化版本比较：current >= minimum。无法解析时返回 true（permissive）——
 * 调用方若需 fail-closed（如能力版本门），先用 `version != null` 守卫。
 */
export function versionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const current = parseVersionParts(version);
  const required = parseVersionParts(minimum);
  if (!current || !required) return true;
  const len = Math.max(current.length, required.length);
  for (let i = 0; i < len; i += 1) {
    const a = current[i] ?? 0;
    const b = required[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export function daemonUpgradeGuidance(version: string | null | undefined): DaemonUpgradeGuidance {
  const stableVersion = version?.trim().replace(/^v/, '');
  if (!stableVersion || !/^\d+\.\d+\.\d+$/.test(stableVersion)) {
    return {
      mode: 'legacy',
      command: null,
      description: '当前版本无法使用内置更新，请停止旧 Daemon，再生成并运行新的连接命令完成迁移。',
    };
  }
  if (versionAtLeast(version, SELF_UPDATE_MIN_VERSION)) {
    return {
      mode: 'self-update',
      command: 'agentbean update',
      description: '请在这台 Mac 的终端运行；AgentBean 会自动更新并安全重启 Device Service。',
    };
  }
  if (versionAtLeast(version, DEVICE_SERVICE_MVP_MIN_VERSION)) {
    return {
      mode: 'bootstrap',
      command: 'npm install -g @agentbean/daemon@latest && agentbean device install && agentbean device restart',
      description: '当前版本尚无内置更新命令。请在这台 Mac 的终端仅执行这一次，完成安装、刷新服务入口并重启；以后升级运行 agentbean update。',
    };
  }
  return {
    mode: 'legacy',
    command: null,
    description: '当前版本无法使用内置更新，请停止旧 Daemon，再生成并运行新的连接命令完成迁移。',
  };
}

export function daemonVersionDisplay(device: DaemonVersionFields): DaemonVersionDisplay {
  const current = label(device.daemonVersionInfo?.current ?? device.systemInfo?.daemonVersion);
  const latest = label(device.daemonVersionInfo?.latest ?? device.latestDaemonVersion);
  const updateAvailable = Boolean(device.daemonVersionInfo?.updateAvailable ?? device.daemonUpdateAvailable);
  if (current) {
    return { currentLabel: current, latestLabel: latest, updateAvailable, unknown: false };
  }
  return {
    currentLabel: device.status === 'offline' ? '离线' : '版本未知',
    latestLabel: latest,
    updateAvailable: false,
    unknown: true,
  };
}

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

function label(version?: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed || trimmed === 'unknown') return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
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

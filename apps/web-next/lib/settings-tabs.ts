export type SettingsTab = 'account' | 'browser' | 'server' | 'releases';

/** Legacy settings tab ids that now live under System Admin Console (see ADR 0060). */
export type LegacySettingsConsoleTab = 'pi' | 'memory' | 'runs';

export const ALL_SETTINGS_TABS: readonly SettingsTab[] = [
  'account',
  'browser',
  'server',
  'releases',
] as const;

/** 设置侧栏 tab：系统级运维入口已迁出 Console，角色不再影响可见 tab 集合。 */
export function settingsTabsForRole(_isSystemAdmin: boolean): readonly SettingsTab[] {
  return ALL_SETTINGS_TABS;
}

export function normalizeSettingsTab(value: string | null): SettingsTab | null {
  if (
    value === 'account'
    || value === 'browser'
    || value === 'server'
    || value === 'releases'
  ) {
    return value;
  }
  return null;
}

/**
 * 是否为已迁出的系统 PI 设置 tab（书签 / 旧链接）。
 * 系统管理员应重定向到 dashboard/pi；非管理员回退到 account，不进入 Console。
 */
export function isLegacyPiSettingsTab(value: string | null): boolean {
  return value === 'pi';
}

/**
 * 已迁出到 System Admin Console 的旧设置 tab。
 * 返回对应 dashboard section；非此类 tab 返回 null。
 */
export function legacySettingsConsoleSection(
  value: string | null,
): LegacySettingsConsoleTab | null {
  if (value === 'pi' || value === 'memory' || value === 'runs') return value;
  return null;
}

/**
 * 解析设置页当前 tab。
 * `?tab=pi|memory|runs` 不再作为有效设置 tab（由页面层重定向或回退）。
 */
export function resolveSettingsTab(
  requested: string | null,
  _isSystemAdmin: boolean,
  fallback: SettingsTab = 'account',
): SettingsTab {
  const tab = normalizeSettingsTab(requested);
  if (!tab) return fallback;
  return tab;
}

export type SettingsTab = 'account' | 'browser' | 'server' | 'memory' | 'runs' | 'releases';

/** Legacy system-PI tab id; no longer a settings primary tab (see ADR 0060). */
export type LegacySettingsPiTab = 'pi';

export const ALL_SETTINGS_TABS: readonly SettingsTab[] = [
  'account',
  'browser',
  'server',
  'memory',
  'runs',
  'releases',
] as const;

/** 设置侧栏 tab：系统级 PI 已迁出，角色不再影响可见 tab 集合。 */
export function settingsTabsForRole(_isSystemAdmin: boolean): readonly SettingsTab[] {
  return ALL_SETTINGS_TABS;
}

export function normalizeSettingsTab(value: string | null): SettingsTab | null {
  if (
    value === 'account'
    || value === 'browser'
    || value === 'server'
    || value === 'memory'
    || value === 'runs'
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
 * 解析设置页当前 tab。`?tab=pi` 不再作为有效设置 tab（由页面层重定向或回退）。
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

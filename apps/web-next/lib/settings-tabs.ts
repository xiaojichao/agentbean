export type SettingsTab = 'account' | 'browser' | 'server' | 'pi' | 'memory' | 'runs' | 'releases';

export const ALL_SETTINGS_TABS: readonly SettingsTab[] = [
  'account',
  'browser',
  'server',
  'pi',
  'memory',
  'runs',
  'releases',
] as const;

/** 非系统管理员不可见/不可进入 PI Agent 系统入口。 */
export function settingsTabsForRole(isSystemAdmin: boolean): readonly SettingsTab[] {
  if (isSystemAdmin) return ALL_SETTINGS_TABS;
  return ALL_SETTINGS_TABS.filter((tab) => tab !== 'pi');
}

export function normalizeSettingsTab(value: string | null): SettingsTab | null {
  if (
    value === 'account'
    || value === 'browser'
    || value === 'server'
    || value === 'pi'
    || value === 'memory'
    || value === 'runs'
    || value === 'releases'
  ) {
    return value;
  }
  return null;
}

/**
 * 解析设置页当前 tab：非系统管理员直接访问 `?tab=pi` 时回退到 account，
 * 不先进入 PI 再显示禁止页。
 */
export function resolveSettingsTab(
  requested: string | null,
  isSystemAdmin: boolean,
  fallback: SettingsTab = 'account',
): SettingsTab {
  const tab = normalizeSettingsTab(requested);
  if (!tab) return fallback;
  if (tab === 'pi' && !isSystemAdmin) return fallback;
  return tab;
}

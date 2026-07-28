import { describe, expect, test } from 'vitest';

import {
  isLegacyPiSettingsTab,
  legacySettingsConsoleSection,
  resolveSettingsTab,
  settingsTabsForRole,
} from '../lib/settings-tabs.js';

describe('settings tab role visibility', () => {
  test('neither admin nor member sees PI / Memory / runs as settings primary tabs', () => {
    expect(settingsTabsForRole(true)).not.toContain('pi' as never);
    expect(settingsTabsForRole(true)).not.toContain('memory' as never);
    expect(settingsTabsForRole(true)).not.toContain('runs' as never);
    expect(settingsTabsForRole(false)).not.toContain('memory' as never);
    expect(settingsTabsForRole(false)).not.toContain('runs' as never);
    expect(settingsTabsForRole(true)).toEqual([
      'account', 'browser', 'server', 'releases',
    ]);
    expect(settingsTabsForRole(false)).toEqual([
      'account', 'browser', 'server', 'releases',
    ]);
  });

  test('legacy console tabs are detected for redirect and are not valid settings tabs', () => {
    expect(isLegacyPiSettingsTab('pi')).toBe(true);
    expect(isLegacyPiSettingsTab('memory')).toBe(false);
    expect(legacySettingsConsoleSection('pi')).toBe('pi');
    expect(legacySettingsConsoleSection('memory')).toBe('memory');
    expect(legacySettingsConsoleSection('runs')).toBe('runs');
    expect(legacySettingsConsoleSection('account')).toBeNull();
    expect(resolveSettingsTab('pi', true)).toBe('account');
    expect(resolveSettingsTab('memory', false)).toBe('account');
    expect(resolveSettingsTab('runs', true)).toBe('account');
    expect(resolveSettingsTab(null, false)).toBe('account');
  });
});

import { describe, expect, test } from 'vitest';

import {
  isLegacyPiSettingsTab,
  resolveSettingsTab,
  settingsTabsForRole,
} from '../lib/settings-tabs.js';

describe('settings tab role visibility', () => {
  test('neither admin nor member sees PI Agent as a settings primary tab', () => {
    expect(settingsTabsForRole(true)).not.toContain('pi' as never);
    expect(settingsTabsForRole(false)).not.toContain('pi' as never);
    expect(settingsTabsForRole(true)).toEqual([
      'account', 'browser', 'server', 'memory', 'runs', 'releases',
    ]);
    expect(settingsTabsForRole(false)).toEqual([
      'account', 'browser', 'server', 'memory', 'runs', 'releases',
    ]);
  });

  test('Memory governance remains a settings tab for all roles', () => {
    expect(settingsTabsForRole(true)).toContain('memory');
    expect(settingsTabsForRole(false)).toContain('memory');
  });

  test('legacy ?tab=pi is detected for redirect and is not a valid settings tab', () => {
    expect(isLegacyPiSettingsTab('pi')).toBe(true);
    expect(isLegacyPiSettingsTab('memory')).toBe(false);
    expect(resolveSettingsTab('pi', true)).toBe('account');
    expect(resolveSettingsTab('pi', false)).toBe('account');
    expect(resolveSettingsTab('memory', false)).toBe('memory');
    expect(resolveSettingsTab(null, false)).toBe('account');
  });
});

import { describe, expect, test } from 'vitest';

import {
  resolveSettingsTab,
  settingsTabsForRole,
} from '../lib/settings-tabs.js';

describe('settings tab role visibility', () => {
  test('system admin sees PI Agent tab', () => {
    expect(settingsTabsForRole(true)).toContain('pi');
  });

  test('non-admin never sees PI Agent tab', () => {
    expect(settingsTabsForRole(false)).not.toContain('pi');
    expect(settingsTabsForRole(false)).toEqual([
      'account', 'browser', 'server', 'memory', 'runs', 'releases',
    ]);
  });

  test('direct ?tab=pi falls back for non-admin without entering PI', () => {
    expect(resolveSettingsTab('pi', false)).toBe('account');
    expect(resolveSettingsTab('pi', true)).toBe('pi');
    expect(resolveSettingsTab('memory', false)).toBe('memory');
    expect(resolveSettingsTab(null, false)).toBe('account');
  });
});

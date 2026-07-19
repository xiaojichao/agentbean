import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panelSource = readFileSync(
  resolve(import.meta.dirname, '../app/[teamPath]/settings/PiManagementPanel.tsx'),
  'utf8',
);
const settingsSource = readFileSync(
  resolve(import.meta.dirname, '../app/[teamPath]/settings/page.tsx'),
  'utf8',
);

describe('PI Management settings scope', () => {
  test('settings sidebar includes PI Agent tab separate from team settings for admins only', () => {
    expect(settingsSource).toContain("id: 'pi'");
    expect(settingsSource).toContain("label: 'PI Agent'");
    expect(settingsSource).toContain('PiManagementPanel');
    expect(settingsSource).toContain('settingsTabsForRole');
    expect(settingsSource).toContain('resolveSettingsTab');
    expect(settingsSource).toContain('tab === \'pi\' && isSystemAdmin');
  });

  test('panel itself remains system-admin scoped', () => {
    expect(panelSource).toContain('settings-pi-forbidden');
    expect(panelSource).toContain('仅系统管理员可访问');
  });

  test('system admin panel supports four presets, form/advanced editors, and credential-safe UX', () => {
    expect(panelSource).toContain('data-pi-scope="system"');
    expect(panelSource).not.toContain('settings-pi-scope-switch');
    expect(panelSource).not.toContain('settings-pi-team-scope');
    expect(panelSource).toContain('settings-pi-presets');
    expect(panelSource).toContain('settings-pi-editor-form');
    expect(panelSource).toContain('settings-pi-editor-advanced');
    expect(panelSource).toContain('settings-pi-field-api-key');
    expect(panelSource).toContain('type="password"');
    expect(panelSource).toContain('不回显');
    expect(panelSource).toContain('openai');
    expect(panelSource).toContain('openrouter');
    expect(panelSource).toContain('deepseek');
    expect(panelSource).toContain('custom_openai_compatible');
  });

  test('successful save and copy refresh the list without resetting editor state or success feedback', () => {
    expect(panelSource).toContain('preserveEditor?: boolean');
    expect(panelSource).toContain('preserveMessage?: boolean');
    expect(panelSource.match(/load\(\{ preserveEditor: true, preserveMessage: true \}\)/g)).toHaveLength(2);
    expect(panelSource.indexOf('startEdit(result.card)')).toBeLessThan(
      panelSource.indexOf("setMessage({ ok: true, text: '已复制为新 Draft' })"),
    );
  });

});

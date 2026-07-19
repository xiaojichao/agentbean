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
  test('settings sidebar includes PI Agent tab separate from team settings', () => {
    expect(settingsSource).toContain("id: 'pi'");
    expect(settingsSource).toContain("label: 'PI Agent'");
    expect(settingsSource).toContain('PiManagementPanel');
    expect(settingsSource).toContain('isSystemAdmin={Boolean(isSystemAdmin)}');
  });

  test('non-admin path fails closed without provider supply fields', () => {
    expect(panelSource).toContain('settings-pi-forbidden');
    expect(panelSource).toContain('仅系统管理员可访问');
    expect(panelSource).toContain('不会展示 Provider、Model、Endpoint 或 Credential');
  });

  test('system admin panel supports four presets, form/advanced editors, and credential-safe UX', () => {
    expect(panelSource).toContain('settings-pi-scope-system');
    expect(panelSource).toContain('settings-pi-scope-team');
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

  test('team scope copy never claims to show provider identity fields', () => {
    expect(panelSource).toContain('settings-pi-team-scope');
    expect(panelSource).toContain('不提供 Provider、Model、Endpoint、Credential 或 revision');
  });
});

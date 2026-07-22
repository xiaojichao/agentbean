// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  listPresets: vi.fn(),
  listCards: vi.fn(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  copyCard: vi.fn(),
  discoverModels: vi.fn(),
  runTest: vi.fn(),
  cancelTest: vi.fn(),
  publishCard: vi.fn(),
  getActiveModel: vi.fn(),
  setActiveModel: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  piProviderEvents: () => mocks,
}));

const preset = {
  preset: 'openai' as const,
  displayName: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultEndpointMode: 'chat_completions' as const,
  defaultConsoleUrl: 'https://platform.openai.com',
  protocol: 'openai_chat_completions' as const,
};

const sourceCard = {
  id: 'card-1',
  displayName: 'OpenAI',
  preset: 'openai' as const,
  notes: null,
  consoleUrl: null,
  credential: { credentialRef: 'credential-1', configured: true, fingerprint: 'fingerprint' },
  draftRevision: {
    id: 'revision-1',
    cardId: 'card-1',
    status: 'draft' as const,
    displayName: 'OpenAI',
    notes: null,
    consoleUrl: null,
    config: {
      protocol: 'openai_chat_completions' as const,
      baseUrl: 'https://api.openai.com/v1',
      endpointMode: 'chat_completions' as const,
      modelId: 'gpt-4.1-mini',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      compatibilityParams: {},
    },
    createdBy: 'admin-1',
    createdAt: 1,
  },
  publishedRevision: null,
  modelCandidates: [{ modelId: 'gpt-4.1-mini' }],
  modelCandidatesUpdatedAt: 1,
  latestTest: null,
  canPublish: false,
  createdBy: 'admin-1',
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  mocks.listPresets.mockResolvedValue({ ok: true, presets: [preset] });
  mocks.listCards.mockResolvedValue({ ok: true, cards: [sourceCard] });
  mocks.createCard.mockResolvedValue({ ok: true, card: { ...sourceCard, id: 'card-created' } });
  mocks.updateCard.mockResolvedValue({ ok: true, card: sourceCard });
  mocks.copyCard.mockResolvedValue({
    ok: true,
    card: { ...sourceCard, id: 'card-copy', displayName: 'OpenAI (copy)' },
  });
  mocks.discoverModels.mockResolvedValue({
    ok: true, discoverySupported: true, models: [{ modelId: 'gpt-4.1-mini' }],
  });
  mocks.runTest.mockResolvedValue({
    ok: true,
    test: { status: 'passed', diagnosticCode: null },
    card: { ...sourceCard, canPublish: true, latestTest: { status: 'passed' } },
  });
  mocks.cancelTest.mockResolvedValue({ ok: true, cancelled: true });
  mocks.publishCard.mockResolvedValue({
    ok: true,
    card: { ...sourceCard, draftRevision: null, canPublish: false },
  });
  mocks.getActiveModel.mockResolvedValue({
    ok: true, activeModel: null, history: [], health: { status: 'unavailable', diagnosticCode: 'PI_ACTIVE_MODEL_NOT_CONFIGURED' },
  });
  mocks.setActiveModel.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const panelSource = readFileSync(
  resolve(import.meta.dirname, '../app/[teamPath]/settings/PiManagementPanel.tsx'),
  'utf8',
);
const settingsSource = readFileSync(
  resolve(import.meta.dirname, '../app/[teamPath]/settings/page.tsx'),
  'utf8',
);
const sidebarSource = readFileSync(
  resolve(import.meta.dirname, '../components/sidebar.tsx'),
  'utf8',
);
const socketSource = readFileSync(
  resolve(import.meta.dirname, '../lib/socket.ts'),
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

  test('team users can consume only the public PI health projection', () => {
    expect(socketSource).toContain('getPublicHealth()');
    expect(socketSource).toContain('WEB_EVENTS.piProvider.getPublicHealth');
    expect(sidebarSource).toContain('piProviderEvents().getPublicHealth()');
    expect(sidebarSource).toContain('data-smoke="pi-public-health"');
    expect(sidebarSource).not.toContain('activeModel');
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
    expect(panelSource).toContain('settings-pi-discover');
    expect(panelSource).toContain('settings-pi-run-test');
    expect(panelSource).toContain('settings-pi-cancel-test');
    expect(panelSource).toContain('settings-pi-publish');
    expect(panelSource).toContain('settings-pi-active-model');
    expect(panelSource).toContain('设为 Active');
    expect(panelSource).toContain('activeHealth.diagnosticCode');
    expect(panelSource).not.toContain('只影响后续新建 Run');
  });

  test('successful save and copy refresh the list without resetting editor state or success feedback', () => {
    expect(panelSource).toContain('editorInitializedRef');
    expect(panelSource).toContain('}, [isSystemAdmin]);');
    expect(panelSource).not.toContain('}, [editingCardId, isSystemAdmin]);');
    expect(panelSource).toContain('preserveEditor?: boolean');
    expect(panelSource).toContain('preserveMessage?: boolean');
    expect((panelSource.match(/load\(\{ preserveEditor: true, preserveMessage: true \}\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(panelSource.indexOf('startEdit(result.card)')).toBeLessThan(
      panelSource.indexOf("setMessage({ ok: true, text: '已复制为新 Draft' })"),
    );
  });

  test('create keeps success feedback without an editing-id-triggered reload', async () => {
    const { PiManagementPanel } = await import('../app/[teamPath]/settings/PiManagementPanel');
    render(React.createElement(PiManagementPanel, { isSystemAdmin: true }));
    await waitFor(() => expect(mocks.listPresets).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '保存 Draft' }));

    await waitFor(() => expect(screen.getByText('Draft 已创建')).toBeTruthy());
    await waitFor(() => expect(mocks.listPresets).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('Draft 已创建')).toBeTruthy();
    expect(mocks.listPresets).toHaveBeenCalledTimes(2);
  });

  test('copy keeps success feedback without an editing-id-triggered reload', async () => {
    const { PiManagementPanel } = await import('../app/[teamPath]/settings/PiManagementPanel');
    render(React.createElement(PiManagementPanel, { isSystemAdmin: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: '复制' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '复制' }));

    await waitFor(() => expect(screen.getByText('已复制为新 Draft')).toBeTruthy());
    await waitFor(() => expect(mocks.listPresets).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('已复制为新 Draft')).toBeTruthy();
    expect(mocks.listPresets).toHaveBeenCalledTimes(2);
  });

  test('shows a secret-free discovery diagnostic instead of reporting every failure as unsupported', async () => {
    mocks.discoverModels.mockResolvedValue({
      ok: true,
      discoverySupported: false,
      models: [],
      diagnosticCode: 'PI_PROVIDER_DISCOVERY_AUTH_FAILED',
    });
    const { PiManagementPanel } = await import('../app/[teamPath]/settings/PiManagementPanel');
    render(React.createElement(PiManagementPanel, { isSystemAdmin: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新模型' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '刷新模型' }));

    await waitFor(() => expect(screen.getByText('模型发现失败：PI_PROVIDER_DISCOVERY_AUTH_FAILED')).toBeTruthy());
  });

  test('offers cancellation while a production-path test is running', async () => {
    let finishTest!: (value: unknown) => void;
    mocks.runTest.mockImplementation(() => new Promise((resolve) => { finishTest = resolve; }));
    const { PiManagementPanel } = await import('../app/[teamPath]/settings/PiManagementPanel');
    render(React.createElement(PiManagementPanel, { isSystemAdmin: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: '运行测试' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '运行测试' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '取消测试' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '取消测试' }));

    await waitFor(() => expect(mocks.cancelTest).toHaveBeenCalledWith('card-1'));
    finishTest({
      ok: true,
      test: { status: 'failed', diagnosticCode: 'MANAGEMENT_MODEL_ABORTED' },
      card: sourceCard,
    });
    await waitFor(() => expect(screen.getByText('生产同路径测试已取消')).toBeTruthy());
  });

});

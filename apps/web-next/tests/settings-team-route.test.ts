// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  updateTeam: vi.fn(async () => ({ ok: true })),
  getPiPolicy: vi.fn(async (_teamId: string) => ({ ok: true, autoCoordinationEnabled: true })),
  updatePiPolicy: vi.fn(async (payload: { teamId: string; autoCoordinationEnabled: boolean }) => ({ ok: true, autoCoordinationEnabled: payload.autoCoordinationEnabled })),
  storeState: {
    currentTeamId: 'stale-team',
    teams: [{ id: 'stale-team', name: 'Stale Team', path: 'stale-team' }],
    agents: {},
    visibleAgents: [],
    currentUser: { id: 'user-1', username: 'alice' },
    setCurrentTeamId: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ teamPath: 'route-team' }),
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (state: unknown) => unknown) => selector(mocks.storeState),
}));

vi.mock('@/lib/socket', () => ({
  authEvents: () => ({ changePassword: vi.fn() }),
  clearStoredAuth: vi.fn(),
  getWebSocket: () => ({ disconnect: vi.fn() }),
  joinEvents: () => ({
    list: vi.fn(async () => ({ ok: true, links: [] })),
    create: vi.fn(),
    revoke: vi.fn(),
  }),
  teamEvents: () => ({
    update: mocks.updateTeam,
    delete: vi.fn(),
  }),
  piPolicyEvents: () => ({
    get: mocks.getPiPolicy,
    update: mocks.updatePiPolicy,
  }),
  agentExposureEvents: () => ({
    getActive: vi.fn().mockResolvedValue({ ok: true, projection: null }),
    listRevisions: vi.fn().mockResolvedValue({ ok: true, revisions: [], activeRestriction: null }),
    createDraft: vi.fn().mockResolvedValue({ ok: true, manifest: { id: 'm1' } }),
    updateDraft: vi.fn().mockResolvedValue({ ok: true, manifest: { id: 'm1' } }),
    publish: vi.fn().mockResolvedValue({ ok: true, manifest: { id: 'm1', revision: 1 } }),
    revoke: vi.fn().mockResolvedValue({ ok: true, revoked: true }),
    upsertRestriction: vi.fn().mockResolvedValue({ ok: true, restriction: null }),
    getTeamCoverage: vi.fn().mockResolvedValue({ ok: true, coverage: { teamId: 'team-1', entries: [] } }),
  }),
  userMemoryEvents: () => ({
    list: vi.fn().mockResolvedValue({ ok: true, list: { items: [] } }),
    detail: vi.fn().mockResolvedValue({ ok: true }),
    create: vi.fn().mockResolvedValue({ ok: true }),
    revise: vi.fn().mockResolvedValue({ ok: true }),
    deactivate: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  }),
}));

vi.mock('@/components/connection-banner', () => ({ ConnectionBanner: () => null }));

beforeEach(() => {
  mocks.getPiPolicy.mockImplementation(async (_teamId: string) => ({ ok: true, autoCoordinationEnabled: true }));
  mocks.updatePiPolicy.mockImplementation(async (payload: { teamId: string; autoCoordinationEnabled: boolean }) => ({
    ok: true,
    autoCoordinationEnabled: payload.autoCoordinationEnabled,
  }));
  mocks.storeState.currentTeamId = 'stale-team';
  mocks.storeState.teams = [{ id: 'stale-team', name: 'Stale Team', path: 'stale-team' }];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SettingsPage Team route binding', () => {
  test('does not update the stale current Team while the route Team is hydrating', async () => {
    const { default: SettingsPage } = await import('../app/[teamPath]/settings/page');
    const view = render(React.createElement(SettingsPage));
    fireEvent.click(screen.getByRole('button', { name: '团队' }));

    const input = view.container.querySelector('[data-smoke="settings-team-name-input"]') as HTMLInputElement;
    const save = screen.getByRole('button', { name: '保存资料' }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'Wrong Team Update' } });
    fireEvent.click(save);

    expect(save.disabled).toBe(true);
    expect(mocks.updateTeam).not.toHaveBeenCalled();

    mocks.storeState.teams = [
      ...mocks.storeState.teams,
      { id: 'route-team-id', name: 'Route Team', path: 'route-team' },
    ];
    view.rerender(React.createElement(SettingsPage));

    await waitFor(() => expect(input.value).toBe('Route Team'));
    await waitFor(() => expect(mocks.getPiPolicy).toHaveBeenCalledWith('route-team-id'));
    fireEvent.change(input, { target: { value: 'Renamed Route Team' } });
    fireEvent.click(save);

    await waitFor(() => expect(mocks.updateTeam).toHaveBeenCalledWith({
      teamId: 'route-team-id',
      name: 'Renamed Route Team',
    }));
  });

  test('PI auto-coordination toggle saves through the owner/admin control', async () => {
    const { PiPolicyPanel } = await import('../app/[teamPath]/settings/PiPolicyPanel');
    render(React.createElement(PiPolicyPanel, { teamId: 'route-team-id', canManage: true }));
    await waitFor(() => expect(mocks.getPiPolicy).toHaveBeenCalledWith('route-team-id'));

    const toggle = document.querySelector('[data-smoke="settings-pi-auto-coordination"] input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);

    await waitFor(() => expect(mocks.updatePiPolicy).toHaveBeenCalledWith({
      teamId: 'route-team-id',
      autoCoordinationEnabled: false,
    }));
  });

  test('keeps the PI auto-coordination toggle read-only for Team members', async () => {
    const { PiPolicyPanel } = await import('../app/[teamPath]/settings/PiPolicyPanel');
    render(React.createElement(PiPolicyPanel, { teamId: 'route-team-id', canManage: false }));
    await waitFor(() => expect(mocks.getPiPolicy).toHaveBeenCalledWith('route-team-id'));

    const toggle = document.querySelector('[data-smoke="settings-pi-auto-coordination"] input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(mocks.updatePiPolicy).not.toHaveBeenCalled();
    expect(screen.getByText('仅 Team owner/admin 可修改。')).toBeTruthy();
  });

  test('shows an unknown disabled state instead of treating a failed read as enabled', async () => {
    mocks.getPiPolicy.mockResolvedValueOnce({ ok: false, autoCoordinationEnabled: false });
    const { PiPolicyPanel } = await import('../app/[teamPath]/settings/PiPolicyPanel');
    render(React.createElement(PiPolicyPanel, { teamId: 'route-team-id', canManage: true }));

    await waitFor(() => expect(screen.getByText('状态未知')).toBeTruthy());
    const toggle = document.querySelector('[data-smoke="settings-pi-auto-coordination"] input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(screen.queryByText('已开启')).toBeNull();
    expect(screen.getByText('读取 PI 自动协调状态失败')).toBeTruthy();
  });

  test('does not let a previous Team save response overwrite the current Team', async () => {
    let resolveFirstUpdate: ((value: { ok: true; autoCoordinationEnabled: boolean }) => void) | undefined;
    mocks.updatePiPolicy.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirstUpdate = resolve;
    }));
    mocks.getPiPolicy.mockImplementation(async (teamId: string) => ({
      ok: true,
      autoCoordinationEnabled: teamId === 'team-a',
    }));

    const { PiPolicyPanel } = await import('../app/[teamPath]/settings/PiPolicyPanel');
    const view = render(React.createElement(PiPolicyPanel, { key: 'team-a', teamId: 'team-a', canManage: true }));
    await waitFor(() => expect(screen.getByText('已开启')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-smoke="settings-pi-auto-coordination"] input[type="checkbox"]')!);
    await waitFor(() => expect(mocks.updatePiPolicy).toHaveBeenCalledWith({
      teamId: 'team-a',
      autoCoordinationEnabled: false,
    }));

    view.rerender(React.createElement(PiPolicyPanel, { key: 'team-b', teamId: 'team-b', canManage: true }));
    await waitFor(() => expect(mocks.getPiPolicy).toHaveBeenCalledWith('team-b'));
    await waitFor(() => expect(screen.getByText('已关闭')).toBeTruthy());

    resolveFirstUpdate?.({ ok: true, autoCoordinationEnabled: true });
    await Promise.resolve();
    expect(screen.getByText('已关闭')).toBeTruthy();
    expect(screen.queryByText('已开启 PI 自动协调')).toBeNull();
  });
});

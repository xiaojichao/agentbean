// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  updateTeam: vi.fn(async () => ({ ok: true })),
  getManagementPolicy: vi.fn(async () => ({
    ok: true,
    policy: {
      schemaVersion: 2, teamId: 'route-team-id', mode: 'direct', maxManagementPhase: 1,
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      updatedBy: '', updatedAt: 0,
    },
    canManage: true,
  })),
  updateManagementPolicy: vi.fn(async () => ({ ok: true })),
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
  managementPolicyEvents: () => ({
    get: mocks.getManagementPolicy,
    update: mocks.updateManagementPolicy,
  }),
}));

vi.mock('@/components/connection-banner', () => ({ ConnectionBanner: () => null }));

beforeEach(() => {
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
    await waitFor(() => expect(mocks.getManagementPolicy).toHaveBeenCalledWith('route-team-id'));
    fireEvent.change(input, { target: { value: 'Renamed Route Team' } });
    fireEvent.click(save);

    await waitFor(() => expect(mocks.updateTeam).toHaveBeenCalledWith({
      teamId: 'route-team-id',
      name: 'Renamed Route Team',
    }));
  });

  test('saves an explicit Phase 2 ceiling only through the owner/admin management control', async () => {
    const { ManagementPolicyPanel } = await import('../app/[teamPath]/settings/ManagementPolicyPanel');
    const view = render(React.createElement(ManagementPolicyPanel, {
      teamId: 'route-team-id', canManage: true, deviceIds: ['device-1'],
    }));
    await waitFor(() => expect(mocks.getManagementPolicy).toHaveBeenCalledWith('route-team-id'));
    fireEvent.change(view.container.querySelector('[data-smoke="settings-management-mode"]')!, { target: { value: 'managed' } });
    fireEvent.click(view.container.querySelector('input[type="checkbox"]')!);
    fireEvent.change(view.container.querySelector('[data-smoke="settings-management-phase"]')!, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存管理模式' }));
    await waitFor(() => expect(mocks.updateManagementPolicy).toHaveBeenCalledWith({
      teamId: 'route-team-id',
      mode: 'managed',
      maxManagementPhase: 2,
      placementPolicy: {
        placement: 'device',
        allowedDeviceIds: ['device-1'],
        allowServerContext: false,
        requireLocalModelCredentials: true,
      },
      // #648：面板全量表单提交预算区，留空 = 显式回落 Phase 默认（空覆盖对象）。
      budgetOverrides: {},
    }));
  });
});

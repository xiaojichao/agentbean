// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ChannelsPage from '../app/[teamPath]/channels/page';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  routeTeamPath: 'route-team',
  subscribeAgents: vi.fn(),
  subscribeChannels: vi.fn(),
  storeState: {
    channels: [],
    teams: [] as Array<{ id: string; path: string }>,
    currentTeamId: 'stale-team',
    applyAgentsSnapshot: vi.fn(),
    applyAgentStatus: vi.fn(),
    applyChannelsSnapshot: vi.fn(),
    setConn: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ teamPath: mocks.routeTeamPath }),
}));

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (state: unknown) => unknown) => selector(mocks.storeState),
  useCurrentTeamPath: () => 'stale-team-path',
}));

vi.mock('@/lib/socket', () => ({
  getWebSocket: () => ({
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
  }),
  agentEvents: () => ({
    onSnapshot: () => vi.fn(),
    onStatus: () => vi.fn(),
    subscribe: mocks.subscribeAgents,
  }),
  channelEvents: () => ({
    subscribe: mocks.subscribeChannels,
  }),
}));

vi.mock('@/components/new-channel-dialog', () => ({
  NewChannelDialog: ({ teamId }: { teamId?: string }) => React.createElement(
    'div',
    { 'data-testid': 'new-channel-dialog', 'data-team-id': teamId },
  ),
}));

beforeEach(() => {
  mocks.storeState.teams = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChannelsPage', () => {
  test('waits for the route Team instead of creating a channel in the stale current Team', () => {
    const view = render(React.createElement(ChannelsPage));
    const createButton = screen.getByRole('button', { name: '新建频道' }) as HTMLButtonElement;

    expect(createButton.disabled).toBe(true);
    expect(createButton.dataset.teamId).toBe('');

    mocks.storeState.teams = [{ id: 'route-team-id', path: 'route-team' }];
    view.rerender(React.createElement(ChannelsPage));

    expect(createButton.disabled).toBe(false);
    expect(createButton.dataset.teamId).toBe('route-team-id');
    fireEvent.click(createButton);
    expect(screen.getByTestId('new-channel-dialog').dataset.teamId).toBe('route-team-id');
  });
});

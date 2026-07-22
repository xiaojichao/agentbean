// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AgentDetailPage from '../app/[teamPath]/agents/[agentId]/page';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  applyAgentStatus: vi.fn(),
  agent: {
    id: 'agent-1',
    name: 'Agent One',
    source: 'custom',
    category: 'executor-hosted',
    adapterKind: 'codex',
    status: 'online',
    lastSeenAt: 1,
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    connectCommand: 'agentbean connect',
  },
  teams: [
    { id: 'team-1', name: 'Team One', path: 'team-one' },
    { id: 'team-2', name: 'Team Two', path: 'team-two' },
  ],
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ teamPath: 'team-one', agentId: 'agent-1' }),
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/lib/socket', () => ({
  agentEvents: () => ({
    subscribe: vi.fn(),
    onSnapshot: () => vi.fn(),
    onStatus: () => vi.fn(),
  }),
  fetchAgentWorkspace: vi.fn().mockResolvedValue({ ok: true, runs: [] }),
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
}));

vi.mock('@/lib/store', () => ({
  useCurrentTeamPath: () => 'team-one',
  useAgentBeanStore: (selector: (state: any) => unknown) => selector({
    agents: { 'agent-1': mocks.agent },
    teams: mocks.teams,
    currentTeamId: 'team-1',
    applyAgentsSnapshot: vi.fn(),
    applyAgentStatus: mocks.applyAgentStatus,
  }),
}));

beforeEach(() => {
  mocks.agent.visibleTeamIds = ['team-1'];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentDetailPage Team visibility', () => {
  test('does not offer unsupported cross-Team visibility controls', async () => {
    render(React.createElement(AgentDetailPage));

    await screen.findByText('Agent One');
    expect(screen.queryByRole('button', { name: /Team Two/ })).toBeNull();
    expect(document.querySelector('[data-smoke="agent-publish-toggle"]')).toBeNull();
  });
});

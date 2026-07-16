// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    socket: {
      connected: true,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = listeners.get(event) ?? new Set(); handlers.add(handler); listeners.set(event, handlers);
      }),
      off: vi.fn((event: string, handler: (...args: unknown[]) => void) => listeners.get(event)?.delete(handler)),
    },
    snapshot: vi.fn(),
    localSummaries: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
    store: { currentTeamId: 'team-1', agents: { 'agent-1': { name: 'Codex' } } },
  };
});

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (state: unknown) => unknown) => selector(mocks.store),
}));

vi.mock('@/lib/socket', () => ({
  getWebSocket: () => mocks.socket,
  memoryEvents: () => ({
    snapshot: mocks.snapshot,
    localSummaries: mocks.localSummaries,
    onChanged: mocks.onChanged,
    create: vi.fn(), update: vi.fn(), expire: vi.fn(), supersede: vi.fn(), delete: vi.fn(),
    issueGrant: vi.fn(), revokeGrant: vi.fn(), acceptCandidate: vi.fn(), rejectCandidate: vi.fn(), mergeCandidate: vi.fn(),
  }),
}));

beforeEach(() => {
  mocks.snapshot.mockResolvedValue({
    ok: true,
    snapshot: {
      schemaVersion: 1, teamId: 'team-1', canManage: true, refreshedAt: 100,
      memories: [{
        schemaVersion: 1, id: 'memory-1', teamId: 'team-1', kind: 'decision', status: 'active',
        scopeType: 'team', scopeRef: 'team-1', content: 'Use Node 24', tags: [],
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'missing', snapshotHash: 'hash' }],
        createdAt: 1, updatedAt: 2, sourceState: 'source-invalid',
      }],
      grants: [], candidates: [],
      capsules: [{
        schemaVersion: 1, id: 'capsule-1', teamId: 'team-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', contentHash: 'hash', authorizationDecisionId: 'decision-1',
        expiresAt: 999, state: 'active', items: [],
      }],
      invocations: [{ id: 'invocation-1', managementRunId: 'run-1', targetAgentId: 'agent-1', createdAt: 10,
        capsuleRef: { schemaVersion: 1, id: 'capsule-1', teamId: 'team-1', managementRunId: 'run-1', targetAgentId: 'agent-1', contentHash: 'hash', authorizationDecisionId: 'decision-1', expiresAt: 999 } }],
    },
  });
  mocks.localSummaries.mockResolvedValue({ ok: true, summaries: [{
    schemaVersion: 1, id: 'local-1', kind: 'procedural', scopeType: 'local-workspace', status: 'active',
    sourceKind: 'scan', summary: 'Run web-next build.', workspaceLabel: 'AgentBean', createdAt: 1, updatedAt: 2,
  }] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MemoryGovernancePanel', () => {
  test('renders collaborative provenance, Capsule/Invocation and Device-only summaries', async () => {
    const { MemoryGovernancePanel } = await import('../app/[teamPath]/settings/MemoryGovernancePanel');
    render(React.createElement(MemoryGovernancePanel));

    await screen.findByText('Use Node 24');
    expect(screen.getByText('source-invalid')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Capsule / Invocation' }));
    expect(await screen.findByText(/Invocation invocation-1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '当前 Device' }));
    expect(await screen.findByText('Run web-next build.')).toBeTruthy();
    expect(mocks.localSummaries).toHaveBeenCalledWith('team-1');
  });

  test('fails closed when the server reports a permission change', async () => {
    mocks.snapshot.mockResolvedValueOnce({ ok: false, error: 'MEMORY_PERMISSION_DENIED' });
    const { MemoryGovernancePanel } = await import('../app/[teamPath]/settings/MemoryGovernancePanel');
    render(React.createElement(MemoryGovernancePanel));

    await waitFor(() => expect(screen.getByText('无权查看该 Team 的 Memory')).toBeTruthy());
    expect(screen.queryByText('Use Node 24')).toBeNull();
  });
});

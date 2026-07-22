// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  socket: { connected: true, on: vi.fn(), off: vi.fn() },
  snapshot: vi.fn(),
  formalList: vi.fn(),
  formalDetail: vi.fn(),
  onChanged: vi.fn(() => () => undefined),
  store: { currentTeamId: 'team-1', agents: {} },
}));

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (state: unknown) => unknown) => selector(mocks.store),
}));

vi.mock('@/lib/socket', () => ({
  getWebSocket: () => mocks.socket,
  memoryEvents: () => ({
    snapshot: mocks.snapshot,
    formalList: mocks.formalList,
    formalDetail: mocks.formalDetail,
    onChanged: mocks.onChanged,
    localSummaries: vi.fn().mockResolvedValue({ ok: true, summaries: [] }),
    create: vi.fn(), update: vi.fn(), expire: vi.fn(), supersede: vi.fn(), delete: vi.fn(),
    issueGrant: vi.fn(), revokeGrant: vi.fn(), acceptCandidate: vi.fn(), rejectCandidate: vi.fn(), mergeCandidate: vi.fn(),
    formalCreate: vi.fn(), formalRevise: vi.fn(), formalDeactivate: vi.fn(), formalDelete: vi.fn(),
    formalAccept: vi.fn(), formalReject: vi.fn(), proposeCorrection: vi.fn(),
  }),
}));

const snapshotOk = {
  ok: true,
  snapshot: {
    schemaVersion: 1, teamId: 'team-1', canManage: true, refreshedAt: 100,
    memories: [], grants: [], candidates: [], capsules: [], invocations: [],
  },
};

const formalItem = {
  schemaVersion: 1, id: 'formal-1', teamId: 'team-1', kind: 'decision' as const,
  status: 'active' as const, scopeType: 'team' as const, scopeRef: 'team-1',
  content: '记忆核心自研，mem0 只做 adapter', tags: [], sourceRefs: [],
  versionFamilyId: 'formal-1', createdAt: 1, updatedAt: 2,
};

beforeEach(() => {
  mocks.snapshot.mockResolvedValue(snapshotOk);
  mocks.formalList.mockResolvedValue({
    ok: true,
    list: {
      schemaVersion: 1, teamId: 'team-1', scopeType: 'team', scopeRef: 'team-1',
      canManage: true, canProposeCorrection: true, items: [formalItem],
    },
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** 渲染 MemoryGovernancePanel 并切到 Formal Memory tab（默认 tab 是协作 Memory）。 */
async function renderFormalSection(): Promise<void> {
  const { MemoryGovernancePanel } = await import('../app/[teamPath]/settings/MemoryGovernancePanel');
  render(React.createElement(MemoryGovernancePanel));
  // 等 snapshot 就绪、tab 栏渲染后再点击（snapshot 是异步加载）。
  const tabButton = await screen.findByRole('button', { name: 'Formal Memory' });
  fireEvent.click(tabButton);
}

describe('Formal Memory Center (issue #716)', () => {
  test('renders Formal Memory list with kind label (AC#1)', async () => {
    await renderFormalSection();
    expect(await screen.findByText('记忆核心自研，mem0 只做 adapter')).toBeTruthy();
    expect(screen.getByText('决策')).toBeTruthy();
  });

  test('owner/admin sees the create button (AC#3)', async () => {
    await renderFormalSection();
    expect(await screen.findByRole('button', { name: '新建 Formal Memory' })).toBeTruthy();
  });

  test('non-admin sees correction action instead of create (AC#6)', async () => {
    mocks.formalList.mockResolvedValue({
      ok: true,
      list: {
        schemaVersion: 1, teamId: 'team-1', scopeType: 'team', scopeRef: 'team-1',
        canManage: false, canProposeCorrection: true, items: [formalItem],
      },
    });
    await renderFormalSection();
    expect(await screen.findByRole('button', { name: '提交纠错' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新建 Formal Memory' })).toBeNull();
  });

  test('fails closed with access-denied state on FORBIDDEN (AC#5)', async () => {
    mocks.formalList.mockResolvedValue({ ok: false, error: 'FORBIDDEN' });
    await renderFormalSection();
    expect(await screen.findByText('无权查看该作用域的 Formal Memory')).toBeTruthy();
  });
});

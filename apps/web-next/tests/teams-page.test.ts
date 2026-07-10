// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import TeamsPage from '../app/[teamPath]/teams/page';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  push: vi.fn(),
  setCurrentTeamId: vi.fn(),
  writeStoredTeamPath: vi.fn(),
  storeState: {
    conn: 'open',
    currentTeamId: 'team-1',
  },
}));

const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
  key: (index: number) => Array.from(stored.keys())[index] ?? null,
  get length() { return stored.size; },
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/lib/socket', () => ({
  teamEvents: () => ({
    create: mocks.create,
    list: mocks.list,
    switch: vi.fn(),
  }),
}));

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (state: unknown) => unknown) => selector({
    ...mocks.storeState,
    setCurrentTeamId: mocks.setCurrentTeamId,
  }),
}));

vi.mock('@/lib/team-path', () => ({
  writeStoredTeamPath: mocks.writeStoredTeamPath,
}));

beforeEach(() => {
  vi.stubGlobal('localStorage', storage);
  mocks.list.mockResolvedValue({
    ok: true,
    teams: [{ id: 'team-1', name: 'Team One', path: 'team-one' }],
  });
  mocks.create.mockResolvedValue({
    ok: true,
    team: { id: 'team-2', name: 'Team Two', path: 'team-two' },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storage.clear();
  vi.unstubAllGlobals();
});

describe('TeamsPage', () => {
  test('makes a newly created Team current and persists its canonical route before navigation', async () => {
    render(React.createElement(TeamsPage));
    await screen.findByText('Team One');

    fireEvent.change(screen.getByPlaceholderText('团队名称'), { target: { value: 'Team Two' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ name: 'Team Two', description: undefined }));
    expect(mocks.setCurrentTeamId).toHaveBeenCalledWith('team-2');
    expect(mocks.writeStoredTeamPath).toHaveBeenCalledWith(localStorage, 'team-two');
    expect(mocks.push).toHaveBeenCalledWith('/team-two/teams');
  });
});

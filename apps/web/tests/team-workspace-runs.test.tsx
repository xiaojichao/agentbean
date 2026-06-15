// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { TeamWorkspaceRun } from '@/lib/schema';

vi.mock('next/link', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : ''} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/format-time', () => ({
  formatRelative: () => 'recently',
}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/socket', () => ({
  fetchTeamWorkspaceRuns: fetchMock,
  authedApiUrl: (url: string) => url,
  getWebSocket: () => ({ on: () => {}, off: () => {} }),
  agentEvents: () => ({ subscribe: () => {}, onSnapshot: () => () => {}, onStatus: () => () => {} }),
  channelEvents: () => ({ subscribe: () => {} }),
  deviceEvents: () => ({ subscribe: () => {}, onSnapshot: () => () => {}, onStatus: () => () => {} }),
  dmEvents: () => ({
    list: () => Promise.resolve({ ok: true, dms: [] }),
    onSnapshot: () => () => {},
  }),
}));
vi.mock('@/lib/store', () => ({
  useCurrentNetworkPath: () => 'acme',
  useAgentBeanStore: (selector: (s: unknown) => unknown) =>
    selector({
      // conn != 'open' skips the socket-subscription effect so we can focus on the fetch render.
      conn: 'closed',
      currentTeamId: 'team-1',
      agents: {},
      devices: {},
      channels: [],
      dms: [],
      applyAgentsSnapshot: () => {},
      applyAgentStatus: () => {},
      applyChannelsSnapshot: () => {},
      applyDmsSnapshot: () => {},
      applyDevicesSnapshot: () => {},
      applyDeviceStatus: () => {},
    }),
}));

import TeamWorkspaceRunsPage from '@/app/[networkPath]/runs/page';

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

function makeTeamRun(
  overrides: Partial<TeamWorkspaceRun['workspaceRun']> = {},
): TeamWorkspaceRun {
  return {
    workspaceRun: {
      id: 'run-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      status: 'succeeded',
      createdAt: 1000,
      updatedAt: 2000,
      artifactIds: ['art-1'],
      command: 'npm test',
      cwd: '/repo',
      exitCode: 0,
      startedAt: 1000,
      completedAt: 2000,
      ...overrides,
    },
    artifacts: [
      {
        id: 'art-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        filename: 'out.txt',
        mimeType: 'text/plain',
        sizeBytes: 1024,
        createdAt: 1500,
      },
    ],
  };
}

describe('team workspace runs page', () => {
  it('renders the latest runs with status, command, file count, and a detail link', async () => {
    fetchMock.mockResolvedValue({ ok: true, runs: [makeTeamRun()] });
    render(<TeamWorkspaceRunsPage />);
    await waitFor(() => expect(screen.getByText('npm test')).toBeInTheDocument());
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText('查看详情').closest('a')?.getAttribute('href')).toBe('/acme/runs/run-1');
    expect(screen.getByText('1 个文件')).toBeInTheDocument();
  });

  it('shows the empty state when there are no runs', async () => {
    fetchMock.mockResolvedValue({ ok: true, runs: [] });
    render(<TeamWorkspaceRunsPage />);
    await waitFor(() => expect(screen.getByText('暂无 workspace runs')).toBeInTheDocument());
  });

  it('shows the error state when the fetch fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, error: 'boom' });
    render(<TeamWorkspaceRunsPage />);
    await waitFor(() => expect(screen.getByText('加载失败')).toBeInTheDocument());
  });
});

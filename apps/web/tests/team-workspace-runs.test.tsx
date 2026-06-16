// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { TeamWorkspaceRun } from '@/lib/schema';

vi.mock('next/link', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : ''} {...rest}>{children}</a>
  ),
}));
const { nav } = vi.hoisted(() => ({ nav: { searchParams: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => nav.searchParams,
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
  vi.useRealTimers();
  nav.searchParams = new URLSearchParams();
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
    const { container } = render(<TeamWorkspaceRunsPage />);
    await waitFor(() => expect(screen.getByText('npm test')).toBeInTheDocument());
    // The status pill lives inside the run <article>; the filter <select> also renders
    // "成功" as an <option>, so scope the assertion to the article to avoid the collision.
    expect(container.querySelector('article')?.textContent).toContain('成功');
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

  it('keeps a flat list when groupBy is unset', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      runs: [makeTeamRun({ id: 'run-1' }), makeTeamRun({ id: 'run-2' })],
    });
    const { container } = render(<TeamWorkspaceRunsPage />);
    await waitFor(() => expect(screen.getAllByText('查看详情').length).toBe(2));
    expect(container.querySelectorAll('details').length).toBe(0);
  });

  it('groups runs into collapsible sections when groupBy=status', async () => {
    nav.searchParams = new URLSearchParams('groupBy=status');
    fetchMock.mockResolvedValue({
      ok: true,
      runs: [
        makeTeamRun({ id: 'run-1', status: 'succeeded' }),
        makeTeamRun({ id: 'run-2', status: 'failed' }),
      ],
    });
    const { container } = render(<TeamWorkspaceRunsPage />);
    await waitFor(() => expect(screen.getAllByText('查看详情').length).toBe(2));
    expect(container.querySelectorAll('details').length).toBe(2);
  });

  it('ignores unsupported groupBy values from the URL', async () => {
    nav.searchParams = new URLSearchParams('groupBy=bogus');
    fetchMock.mockResolvedValue({
      ok: true,
      runs: [makeTeamRun({ id: 'run-1' }), makeTeamRun({ id: 'run-2' })],
    });
    const { container } = render(<TeamWorkspaceRunsPage />);
    await waitFor(() => expect(screen.getAllByText('查看详情').length).toBe(2));
    expect(container.querySelectorAll('details').length).toBe(0);
  });

  it('uses the calendar week for date grouping', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 16, 12));
    nav.searchParams = new URLSearchParams('groupBy=date');
    fetchMock.mockResolvedValue({
      ok: true,
      runs: [makeTeamRun({ id: 'run-sunday', updatedAt: new Date(2026, 5, 14, 12).getTime() })],
    });
    const { container } = render(<TeamWorkspaceRunsPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(container.querySelector('summary')?.textContent).toContain('更早');
  });
});

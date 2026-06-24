// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { WorkspaceRunDetail } from '@/lib/schema';

vi.mock('next/navigation', () => ({
  useParams: () => ({ runId: 'run-abc' }),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : ''} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (s: unknown) => unknown) =>
    selector({ currentTeamId: 'team-1', agents: {}, dms: [] }),
  useCurrentTeamPath: () => 'acme',
}));
vi.mock('@/lib/format-time', () => ({
  formatRelative: () => 'recently',
}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/socket', () => ({
  fetchWorkspaceRunDetail: fetchMock,
  authedApiUrl: (url: string) => url,
}));

import RunDetailPage from '../app/[teamPath]/runs/[runId]/page';

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

function makeRun(overrides: Partial<WorkspaceRunDetail> = {}): WorkspaceRunDetail {
  return {
    id: 'run-abc',
    teamId: 'team-1',
    channelId: 'channel-1',
    dispatchId: 'dispatch-1',
    agentId: 'agent-1',
    status: 'succeeded',
    createdAt: 1000,
    updatedAt: 2000,
    artifactIds: [],
    cwd: '/repo',
    command: 'codex exec',
    exitCode: 0,
    startedAt: 1000,
    completedAt: 2000,
    ...overrides,
  };
}

describe('workspace run detail page', () => {
  it('links back to the runs list when the run fails to load', async () => {
    fetchMock.mockResolvedValue({ ok: false, error: 'not found' });
    render(<RunDetailPage />);
    await waitFor(() => expect(screen.getByText('加载失败')).toBeInTheDocument());
    const backLink = screen.getByText('返回执行记录').closest('a');
    expect(backLink?.getAttribute('href')).toBe('/acme/runs');
  });

  it('auto-expands the log excerpt for a failed run', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      workspaceRun: makeRun({ status: 'failed', logExcerpt: 'Error: boom', exitCode: 2 }),
      artifacts: [],
    });
    const { container } = render(<RunDetailPage />);
    await waitFor(() => expect(screen.getByText('日志摘要')).toBeInTheDocument());
    const details = container.querySelector('details');
    expect(details?.hasAttribute('open')).toBe(true);
  });

  it('keeps the log excerpt collapsed for a succeeded run', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      workspaceRun: makeRun({ status: 'succeeded', logExcerpt: 'all good' }),
      artifacts: [],
    });
    const { container } = render(<RunDetailPage />);
    await waitFor(() => expect(screen.getByText('日志摘要')).toBeInTheDocument());
    const details = container.querySelector('details');
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('renders the reported command and the log troubleshooting controls', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      workspaceRun: makeRun({ status: 'failed', command: 'npm test', logExcerpt: 'line one' }),
      artifacts: [],
    });
    render(<RunDetailPage />);
    await waitFor(() => expect(screen.getByText('npm test')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '复制日志' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载日志' })).toBeInTheDocument();
  });
});

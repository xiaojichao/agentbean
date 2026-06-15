// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentWorkspaceRun } from '@/lib/schema';

vi.mock('next/link', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : ''} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/store', () => ({
  useCurrentNetworkPath: () => 'acme',
}));
vi.mock('@/lib/socket', () => ({
  authedApiUrl: (url: string) => url,
}));
vi.mock('@/lib/format-time', () => ({
  formatRelative: () => 'recently',
}));

import { AgentWorkspaceSection } from '@/components/agent-workspace-section';

afterEach(() => {
  cleanup();
});

function makeRun(overrides: Partial<AgentWorkspaceRun> = {}): AgentWorkspaceRun {
  return {
    runId: 'run-1',
    createdAt: 1000,
    updatedAt: 2000,
    status: 'succeeded',
    cwd: '/repo',
    command: 'npm test',
    exitCode: 0,
    files: [
      {
        id: 'file-1',
        filename: 'output.txt',
        mimeType: 'text/plain',
        sizeBytes: 2048,
        createdAt: 1500,
        downloadUrl: '/api/download/file-1',
        previewUrl: '/api/preview/file-1',
        pathKind: 'workspace',
        relativePath: 'output.txt',
      },
    ],
    ...overrides,
  };
}

describe('agent workspace section', () => {
  it('renders run status, command, file count, and a detail link', () => {
    render(<AgentWorkspaceSection runs={[makeRun()]} loading={false} />);
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('查看详情').closest('a')?.getAttribute('href')).toBe('/acme/runs/run-1');
    expect(screen.getByText('1 个文件')).toBeInTheDocument();
  });

  it('renders a failed run with its exit code', () => {
    render(
      <AgentWorkspaceSection
        runs={[makeRun({ status: 'failed', exitCode: 2, command: 'npm run build' })]}
        loading={false}
      />,
    );
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('exit 2')).toBeInTheDocument();
    expect(screen.getByText('npm run build')).toBeInTheDocument();
  });

  it('shows the empty state when there are no runs', () => {
    render(<AgentWorkspaceSection runs={[]} loading={false} />);
    expect(screen.getByText('暂无已同步的 Agent 产物。')).toBeInTheDocument();
  });

  it('shows a loading indicator while loading', () => {
    render(<AgentWorkspaceSection runs={[]} loading={true} />);
    expect(screen.getByText('正在加载')).toBeInTheDocument();
  });
});

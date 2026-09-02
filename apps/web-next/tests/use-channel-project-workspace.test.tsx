// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  artifactCollections: vi.fn(),
  documentBundles: vi.fn(),
  listOutputPackages: vi.fn(),
  channelWorkspace: vi.fn(),
  onUpdated: vi.fn(),
  onArtifactsUpdated: vi.fn(),
  onDocumentBundlesUpdated: vi.fn(),
  socketOn: vi.fn(),
  socketOff: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  getWebSocket: () => ({ on: mocks.socketOn, off: mocks.socketOff }),
  projectEvents: () => ({
    overview: mocks.overview,
    artifactCollections: mocks.artifactCollections,
    documentBundles: mocks.documentBundles,
    listOutputPackages: mocks.listOutputPackages,
    onUpdated: mocks.onUpdated,
    onArtifactsUpdated: mocks.onArtifactsUpdated,
    onDocumentBundlesUpdated: mocks.onDocumentBundlesUpdated,
  }),
  taskEvents: () => ({ channelWorkspace: mocks.channelWorkspace }),
}));

import { useChannelProjectWorkspace } from '../lib/use-channel-project-workspace';

beforeEach(() => {
  mocks.onUpdated.mockReturnValue(() => {});
  mocks.onArtifactsUpdated.mockReturnValue(() => {});
  mocks.onDocumentBundlesUpdated.mockReturnValue(() => {});
  mocks.overview.mockImplementation(async (channelId: string) => ({
    ok: true,
    overview: overviewFixture(channelId),
  }));
  mocks.artifactCollections.mockImplementation(async (channelId: string) => ({
    ok: true,
    library: libraryFixture(channelId),
  }));
  mocks.documentBundles.mockImplementation(async (channelId: string) => ({
    ok: true,
    bundles: [{ id: `bundle-${channelId}` }],
  }));
  mocks.listOutputPackages.mockImplementation(async ({ channelId }: { channelId: string }) => ({
    ok: true,
    packages: [{ packageId: `package-${channelId}` }],
    pendingDeliveries: [{ deliveryId: `pending-${channelId}` }],
  }));
  mocks.channelWorkspace.mockImplementation(async (channelId: string) => ({
    ok: true,
    workspace: taskWorkspaceFixture(channelId, `task-${channelId}`),
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Channel Project Workspace 深模块', () => {
  test('一次接线向 Chat / Tasks / Files 暴露同源 Server 投影', async () => {
    render(<Probe channelId="channel-a" />);

    await waitFor(() => expect(attribute('data-files-ready')).toBe('true'));
    expect(attribute('data-overview-channel')).toBe('channel-a');
    expect(attribute('data-library-channel')).toBe('channel-a');
    expect(attribute('data-bundle-id')).toBe('bundle-channel-a');
    expect(attribute('data-package-id')).toBe('package-channel-a');
    expect(attribute('data-pending-id')).toBe('pending-channel-a');
    expect(attribute('data-task-id')).toBe('task-channel-a');
    expect(mocks.overview).toHaveBeenCalledTimes(1);
    expect(mocks.channelWorkspace).toHaveBeenCalledTimes(1);
  });

  test('频道切换后忽略旧频道迟到响应，避免混合 Project facts', async () => {
    let resolveOldOverview: ((value: unknown) => void) | undefined;
    mocks.overview
      .mockReturnValueOnce(new Promise((resolve) => { resolveOldOverview = resolve; }))
      .mockResolvedValueOnce({ ok: true, overview: overviewFixture('channel-b') });

    const { rerender } = render(<Probe channelId="channel-a" />);
    await waitFor(() => expect(mocks.overview).toHaveBeenCalledWith('channel-a'));
    rerender(<Probe channelId="channel-b" />);
    await waitFor(() => expect(attribute('data-overview-channel')).toBe('channel-b'));

    resolveOldOverview?.({ ok: true, overview: overviewFixture('channel-a') });
    await Promise.resolve();
    expect(attribute('data-overview-channel')).toBe('channel-b');
    expect(attribute('data-task-id')).toBe('task-channel-b');
  });

  test('artifact 事件统一失效 Files package 与 Tasks workspace 投影', async () => {
    let artifactsUpdated: ((library: unknown) => void) | undefined;
    mocks.onArtifactsUpdated.mockImplementation((_channelId: string, handler: (library: unknown) => void) => {
      artifactsUpdated = handler;
      return () => {};
    });
    mocks.listOutputPackages
      .mockResolvedValueOnce({ ok: true, packages: [{ packageId: 'package-old' }], pendingDeliveries: [] })
      .mockResolvedValueOnce({ ok: true, packages: [{ packageId: 'package-new' }], pendingDeliveries: [] });
    mocks.channelWorkspace
      .mockResolvedValueOnce({ ok: true, workspace: taskWorkspaceFixture('channel-a', 'task-old') })
      .mockResolvedValueOnce({ ok: true, workspace: taskWorkspaceFixture('channel-a', 'task-new') });

    render(<Probe channelId="channel-a" />);
    await waitFor(() => expect(attribute('data-package-id')).toBe('package-old'));
    artifactsUpdated?.(libraryFixture('channel-a', 'library-new'));

    await waitFor(() => expect(attribute('data-package-id')).toBe('package-new'));
    expect(attribute('data-library-id')).toBe('library-new');
    expect(attribute('data-task-id')).toBe('task-new');
    expect(Number(screen.getByTestId('workspace').getAttribute('data-revision'))).toBeGreaterThan(1);
  });

  test('task 更新同时刷新 Tasks workspace 与项目 overview', async () => {
    let taskUpdated: ((task: ReturnType<typeof taskFixture>) => void) | undefined;
    mocks.socketOn.mockImplementation((event: string, handler: (task: ReturnType<typeof taskFixture>) => void) => {
      if (event === 'task:updated') taskUpdated = handler;
    });
    mocks.overview
      .mockResolvedValueOnce({ ok: true, overview: overviewFixture('channel-a', 1) })
      .mockResolvedValueOnce({ ok: true, overview: overviewFixture('channel-a', 2) });

    render(<Probe channelId="channel-a" />);
    await waitFor(() => expect(attribute('data-overview-revision')).toBe('1'));
    taskUpdated?.(taskFixture('channel-a', 'task-updated'));

    await waitFor(() => expect(attribute('data-overview-revision')).toBe('2'));
    expect(mocks.overview).toHaveBeenCalledTimes(2);
    expect(mocks.channelWorkspace).toHaveBeenCalledTimes(2);
  });

  test('同频道 artifact 事件使在途旧查询失效', async () => {
    let artifactsUpdated: ((library: unknown) => void) | undefined;
    let resolveOldLibrary: ((value: unknown) => void) | undefined;
    mocks.onArtifactsUpdated.mockImplementation((_channelId: string, handler: (library: unknown) => void) => {
      artifactsUpdated = handler;
      return () => {};
    });
    mocks.artifactCollections.mockReturnValueOnce(new Promise((resolve) => { resolveOldLibrary = resolve; }));

    render(<Probe channelId="channel-a" />);
    await waitFor(() => expect(artifactsUpdated).toBeTypeOf('function'));
    artifactsUpdated?.(libraryFixture('channel-a', 'library-event'));
    await waitFor(() => expect(attribute('data-library-id')).toBe('library-event'));

    resolveOldLibrary?.({ ok: true, library: libraryFixture('channel-a', 'library-old-query') });
    await waitFor(() => expect(attribute('data-files-ready')).toBe('true'));
    expect(attribute('data-library-id')).toBe('library-event');
  });

  test('同频道 document bundle 事件使在途旧查询失效', async () => {
    let bundlesUpdated: ((bundles: unknown[]) => void) | undefined;
    let resolveOldBundles: ((value: unknown) => void) | undefined;
    mocks.onDocumentBundlesUpdated.mockImplementation(
      (_channelId: string, handler: (bundles: unknown[]) => void) => {
        bundlesUpdated = handler;
        return () => {};
      },
    );
    mocks.documentBundles.mockReturnValueOnce(new Promise((resolve) => { resolveOldBundles = resolve; }));

    render(<Probe channelId="channel-a" />);
    await waitFor(() => expect(bundlesUpdated).toBeTypeOf('function'));
    bundlesUpdated?.([{ id: 'bundle-event' }]);
    await waitFor(() => expect(attribute('data-bundle-id')).toBe('bundle-event'));

    resolveOldBundles?.({ ok: true, bundles: [{ id: 'bundle-old-query' }] });
    await waitFor(() => expect(attribute('data-files-ready')).toBe('true'));
    expect(attribute('data-bundle-id')).toBe('bundle-event');
  });
});

function Probe({ channelId }: { channelId: string }) {
  const workspace = useChannelProjectWorkspace({
    channelId,
    connected: true,
    projectFactsActive: true,
    fileFactsActive: true,
  });
  return (
    <div
      data-testid="workspace"
      data-overview-channel={workspace.overview?.profile.channelId ?? ''}
      data-overview-revision={workspace.overview?.profile.revision ?? ''}
      data-library-channel={(workspace.artifactLibrary as { channelId?: string } | null)?.channelId ?? ''}
      data-library-id={(workspace.artifactLibrary as { id?: string } | null)?.id ?? ''}
      data-bundle-id={(workspace.documentBundles[0] as { id?: string } | undefined)?.id ?? ''}
      data-package-id={workspace.outputPackages[0]?.packageId ?? ''}
      data-pending-id={workspace.outputPackagePendings[0]?.deliveryId ?? ''}
      data-task-id={workspace.tasks[0]?.id ?? ''}
      data-files-ready={String(workspace.filesReady)}
      data-revision={workspace.dataRevision}
    />
  );
}

function attribute(name: string): string | null {
  return screen.getByTestId('workspace').getAttribute(name);
}

function overviewFixture(channelId: string, revision = 1) {
  return {
    profile: {
      id: `profile-${channelId}`,
      teamId: 'team-1',
      channelId,
      revision,
      updatedAt: 1,
    },
  };
}

function libraryFixture(channelId: string, id = `library-${channelId}`) {
  return { id, channelId, collections: [] };
}

function taskWorkspaceFixture(channelId: string, taskId: string) {
  return {
    entries: [{
      task: taskFixture(channelId, taskId),
    }],
  };
}

function taskFixture(channelId: string, taskId: string) {
  return {
    id: taskId,
    title: taskId,
    description: null,
    status: 'pending',
    creatorId: 'user-1',
    assigneeId: null,
    channelId,
    tags: [],
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

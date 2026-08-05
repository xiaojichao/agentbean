// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

// jsdom（本仓库 vitest 版本）未实现 URL.createObjectURL/revokeObjectURL：
// 生产浏览器原生支持，此处仅测试环境 polyfill，让 blob URL 链路可验证。
const createdBlobUrls: string[] = [];
beforeAll(() => {
  const urlCtor = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  if (typeof urlCtor.createObjectURL !== 'function') {
    urlCtor.createObjectURL = (() => {
      const url = `blob:mock-${Math.random().toString(36).slice(2)}`;
      createdBlobUrls.push(url);
      return url;
    }) as typeof URL.createObjectURL;
  }
  if (typeof urlCtor.revokeObjectURL !== 'function') {
    urlCtor.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  }
});
afterAll(() => {
  // 释放 polyfill 占用（无-op，仅显式收尾）。
  void createdBlobUrls;
});

// #1084 切片3 hook 行为测试：本机在线 + tree + sha256 匹配 → 预览命中 daemon readFile（blob URL）；
// 离线/无本机设备/readFile 失败/sha256 不匹配 → 回退 server URL（gotcha #4 静默回退）。
//
// 注意 mock 路径：hook 用相对 './socket' 导入，故这里 mock '../lib/socket'（相对 test 文件）才能命中。
// 用 '@/lib/socket' 不会拦截 hook 的相对导入（已知 vitest 别名 mock 陷阱）。

const socketMock = vi.hoisted(() => ({
  onSnapshotHandler: null as ((devices: unknown[]) => void) | null,
  readFileImpl: vi.fn(),
  workspaceImpl: vi.fn(),
}));

vi.mock('../lib/socket', () => ({
  getWebSocket: () => ({} as unknown),
  deviceEvents: () => ({
    onSnapshot: (handler: (devices: unknown[]) => void) => {
      socketMock.onSnapshotHandler = handler;
      return () => {};
    },
    list: async () => ({ ok: true as const, devices: [] }),
    readFile: socketMock.readFileImpl,
  }),
  projectEvents: () => ({
    workspace: socketMock.workspaceImpl,
  }),
}));

import { useLocalFirstArtifactUrls } from '../lib/use-local-first-artifact-urls';
import type { Artifact, DeviceInfo } from '../lib/schema';

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 'dev-1',
    teamId: 'team-1',
    lastSeenAt: Date.now(),
    status: 'online',
    agentIds: [],
    isLocal: true,
    capabilities: { fsBrowse: true },
    ...overrides,
  } as DeviceInfo;
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    teamId: 'team-1',
    channelId: 'chan-A',
    filename: 'report.md',
    mimeType: 'text/markdown',
    sizeBytes: 5,
    relativePath: 'report.md',
    sha256: 'match-sha',
    createdAt: 0,
    ...overrides,
  } as Artifact;
}

function Probe(props: { artifact: Artifact; serverPreview: string; serverDownload: string; channelId?: string }) {
  const urls = useLocalFirstArtifactUrls(props.artifact, props.serverPreview, props.serverDownload, props.channelId);
  return (
    <div
      data-testid="probe"
      data-preview={urls.previewUrl ?? ''}
      data-download={urls.downloadUrl ?? ''}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  socketMock.readFileImpl.mockReset();
  socketMock.workspaceImpl.mockReset();
  // 清空 module-level 设备缓存（test 1 后 handler 已存在，可直接 push []）。
  socketMock.onSnapshotHandler?.([]);
});

afterEach(() => {
  cleanup();
});

describe('useLocalFirstArtifactUrls', () => {
  test('无本机设备 → 返回 server URL（回退）', async () => {
    render(
      <Probe artifact={makeArtifact()} serverPreview="https://server/preview-A" serverDownload="https://server/download-A" channelId="chan-A" />,
    );

    await waitFor(() => {
      const probe = screen.getByTestId('probe');
      expect(probe.getAttribute('data-preview')).toBe('https://server/preview-A');
      expect(probe.getAttribute('data-download')).toBe('https://server/download-A');
    });
    expect(socketMock.readFileImpl).not.toHaveBeenCalled();
  });

  test('本机在线 + tree + revisionId + sha256 匹配 → 升级为 blob URL', async () => {
    socketMock.workspaceImpl.mockResolvedValue({ ok: true, workspace: { currentRevisionId: 'rev-1' } });
    socketMock.readFileImpl.mockResolvedValue({
      ok: true,
      contentBase64: 'aGVsbG8=',
      sizeBytes: 5,
      sha256: 'match-sha',
    });

    render(
      <Probe artifact={makeArtifact({ sha256: 'match-sha' })} serverPreview="https://server/preview-B" serverDownload="https://server/download-B" channelId="chan-B" />,
    );
    // 推入本机在线 tree 设备，触发 hook 评估。
    act(() => { socketMock.onSnapshotHandler?.([makeDevice()]); });

    await waitFor(() => {
      const probe = screen.getByTestId('probe');
      expect(probe.getAttribute('data-preview')).toMatch(/^blob:/);
      expect(probe.getAttribute('data-download')).toMatch(/^blob:/);
    });

    expect(socketMock.readFileImpl).toHaveBeenCalledWith('dev-1', 'team-1', 'chan-B', 'rev-1', 'report.md');
  });

  test('本机 sha256 不匹配（落后）→ 回退 server URL，不采用 blob', async () => {
    socketMock.workspaceImpl.mockResolvedValue({ ok: true, workspace: { currentRevisionId: 'rev-1' } });
    socketMock.readFileImpl.mockResolvedValue({
      ok: true,
      contentBase64: 'aGVsbG8=',
      sizeBytes: 5,
      sha256: 'old-sha', // 本机落后
    });

    render(
      <Probe artifact={makeArtifact({ sha256: 'new-sha', channelId: 'chan-C' })} serverPreview="https://server/preview-C" serverDownload="https://server/download-C" channelId="chan-C" />,
    );
    act(() => { socketMock.onSnapshotHandler?.([makeDevice()]); });

    await waitFor(() => {
      expect(socketMock.readFileImpl).toHaveBeenCalled();
    });
    await waitFor(() => {
      const probe = screen.getByTestId('probe');
      expect(probe.getAttribute('data-preview')).toBe('https://server/preview-C');
    });
  });

  test('readFile 失败 → 回退 server URL（静默回退）', async () => {
    socketMock.workspaceImpl.mockResolvedValue({ ok: true, workspace: { currentRevisionId: 'rev-1' } });
    socketMock.readFileImpl.mockRejectedValue(new Error('DEVICE_OFFLINE'));

    render(
      <Probe artifact={makeArtifact({ channelId: 'chan-D' })} serverPreview="https://server/preview-D" serverDownload="https://server/download-D" channelId="chan-D" />,
    );
    act(() => { socketMock.onSnapshotHandler?.([makeDevice()]); });

    await waitFor(() => {
      expect(socketMock.readFileImpl).toHaveBeenCalled();
    });
    const probe = screen.getByTestId('probe');
    expect(probe.getAttribute('data-preview')).toBe('https://server/preview-D');
    expect(probe.getAttribute('data-download')).toBe('https://server/download-D');
  });

  test('artifact 无 relativePath → 不尝试本机读取，回退 server', async () => {
    socketMock.workspaceImpl.mockResolvedValue({ ok: true, workspace: { currentRevisionId: 'rev-1' } });

    render(
      <Probe artifact={makeArtifact({ relativePath: undefined, channelId: 'chan-E' })} serverPreview="https://server/preview-E" serverDownload="https://server/download-E" channelId="chan-E" />,
    );
    act(() => { socketMock.onSnapshotHandler?.([makeDevice()]); });

    await waitFor(() => {
      const probe = screen.getByTestId('probe');
      expect(probe.getAttribute('data-preview')).toBe('https://server/preview-E');
    });
    expect(socketMock.readFileImpl).not.toHaveBeenCalled();
  });
});

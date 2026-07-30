// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { WorkspaceRevisionPanel } from '../components/WorkspaceRevisionPanel';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

afterEach(() => { cleanup(); });

const mockFile = (path: string, artifactId: string, filename: string, mimeType: string, sizeBytes: number) => ({
  path, artifactId, filename, mimeType, sizeBytes,
});

const mockImportProvenance = { kind: 'import' as const, sourceDeviceId: 'device-1', importedAt: 100 };
const mockPublishProvenance = { kind: 'publish' as const, agentId: 'agent-1', taskId: 'task-1', taskAttempt: 2, baselineRevisionId: 'rev-baseline-abc12345', publishedAt: 200 };

function mockRevision(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'rev-1', teamId: 'team-1', channelId: 'channel-1', revision: 1,
    files: [mockFile('src/index.ts', 'art-1', 'index.ts', 'text/typescript', 2048)],
    createdBy: 'user-1', createdAt: 100,
    provenance: mockImportProvenance,
    ...overrides,
  };
}

function mockWorkspace(overrides: Partial<Record<string, unknown>> = {}) {
  const revision = mockRevision();
  return { id: 'ws-1', teamId: 'team-1', channelId: 'channel-1', currentRevisionId: revision.id, currentRevision: revision, ...overrides };
}

describe('WorkspaceRevisionPanel (#985 项目文件浏览)', () => {
  test('加载中（workspace=undefined）→ 展示 spinner', () => {
    render(React.createElement(WorkspaceRevisionPanel, { workspace: undefined }));
    expect(screen.getByText(/加载项目文件/)).toBeTruthy();
  });

  test('加载失败 FORBIDDEN → 展示"没有权限"', () => {
    render(React.createElement(WorkspaceRevisionPanel, { workspace: null, error: 'FORBIDDEN' }));
    expect(screen.getByText(/没有权限/)).toBeTruthy();
  });

  test('加载失败 NOT_FOUND → 展示"尚未创建"', () => {
    render(React.createElement(WorkspaceRevisionPanel, { workspace: null, error: 'NOT_FOUND' }));
    expect(screen.getByText(/尚未创建/)).toBeTruthy();
  });

  test('成功加载：展示版本号、文件列表、provenance', () => {
    render(React.createElement(WorkspaceRevisionPanel, { workspace: mockWorkspace() }));
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.getByText(/src\/index\.ts/)).toBeTruthy();
    expect(screen.getByText('index.ts')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('text/typescript')).toBeTruthy();
    expect(screen.getByText(/由设备导入/)).toBeTruthy();
    // footer 统计
    expect(screen.getByText('1 个文件')).toBeTruthy();
  });

  test('publish provenance → 展示 Agent/Task 来源', () => {
    const ws = mockWorkspace();
    ws.currentRevision = mockRevision({ provenance: mockPublishProvenance });
    render(React.createElement(WorkspaceRevisionPanel, { workspace: ws }));
    expect(screen.getByText(/由 Agent 发布/)).toBeTruthy();
    expect(screen.getByText(/任务 task-1/)).toBeTruthy();
    expect(screen.getByText(/基于 rev-base/)).toBeTruthy();
  });

  test('查看历史 revision（viewingRevision != currentRevision）→ 展示"历史版本"徽章', () => {
    const ws = mockWorkspace();
    const hist = mockRevision({
      id: 'rev-0', revision: 0,
      files: [mockFile('old.ts', 'art-0', 'old.ts', 'text/typescript', 100)],
    });
    render(React.createElement(WorkspaceRevisionPanel, { workspace: ws, viewingRevision: hist }));
    expect(screen.getByText(/历史版本/)).toBeTruthy();
    expect(screen.getByText('v0')).toBeTruthy();
  });

  test('空文件清单 → 展示空提示', () => {
    const ws = mockWorkspace();
    ws.currentRevision = mockRevision({ files: [] });
    render(React.createElement(WorkspaceRevisionPanel, { workspace: ws }));
    expect(screen.getByText(/此版本没有文件/)).toBeTruthy();
  });

  test('大文件 → 格式化 KB/MB', () => {
    const ws = mockWorkspace();
    ws.currentRevision = mockRevision({
      files: [mockFile('small.txt', 'art-1', 'small.txt', 'text/plain', 500),
              mockFile('big.bin', 'art-2', 'big.bin', 'application/octet-stream', 3145728)],
    });
    render(React.createElement(WorkspaceRevisionPanel, { workspace: ws }));
    expect(screen.getByText('500 B')).toBeTruthy();
    expect(screen.getByText('3.0 MB')).toBeTruthy();
  });
});

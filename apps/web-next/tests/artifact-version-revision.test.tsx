// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
  }),
}));

import { OutputPackageCard } from '../components/OutputPackageCard';
import { ArtifactVersionRevisionActivity } from '../components/ArtifactVersionRevisionActivity';
import { ProjectArtifactLibrary } from '../components/ProjectArtifactLibrary';
import { artifactVersionRevisionFromMeta } from '../lib/artifact-revision';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('artifactVersionRevisionFromMeta (#1062)', () => {
  test('parses an artifact-version-revision system message meta', () => {
    const meta = artifactVersionRevisionFromMeta({
      kind: 'artifact-version-revision',
      collectionId: 'col-1',
      collectionName: 'out/report.md',
      versionId: 'ver-2',
      versionNumber: 2,
      baseVersionId: 'ver-1',
      sourceVersionId: 'ver-1',
      basisReviewId: 'rev-1',
      packageId: 'pkg-1',
      deliveryId: 'del-1',
      revisedBy: 'user-1',
      revisedByName: '张三',
      createdAt: 1000,
    });
    expect(meta).not.toBeNull();
    expect(meta?.collectionId).toBe('col-1');
    expect(meta?.versionNumber).toBe(2);
    expect(meta?.basisReviewId).toBe('rev-1');
    expect(meta?.packageId).toBe('pkg-1');
    expect(meta?.revisedByName).toBe('张三');
  });

  test('returns null for non-revision meta', () => {
    expect(artifactVersionRevisionFromMeta({ kind: 'output-package' })).toBeNull();
    expect(artifactVersionRevisionFromMeta(null)).toBeNull();
    expect(artifactVersionRevisionFromMeta(undefined)).toBeNull();
  });
});

describe('ArtifactVersionRevisionActivity (#1062)', () => {
  test('renders light activity card without copying Markdown content', () => {
    render(<ArtifactVersionRevisionActivity meta={{
      kind: 'artifact-version-revision',
      collectionId: 'col-1',
      collectionName: 'out/report.md',
      versionId: 'ver-2',
      versionNumber: 2,
      baseVersionId: 'ver-1',
      sourceVersionId: 'ver-1',
      revisedByName: '张三',
    }} />);
    expect(screen.getByText('张三')).not.toBeNull();
    expect(screen.getByText(/保存了《out\/report\.md》新版本 v2/)).not.toBeNull();
  });
});

describe('OutputPackageCard revise-version (#1062)', () => {
  test('无 channelId(上下文不可得)时纯静态展示,不渲染修订按钮(Server 动作驱动)', () => {
    const onRevise = vi.fn();
    render(<OutputPackageCard
      packageMeta={{
        kind: 'output-package',
        packageId: 'pkg-1',
        memberCount: 1,
        members: [{ shortLabel: 'F1', filename: 'report.md', artifactVersionId: 'ver-1', collectionId: 'col-1' }],
        workspaceRevisionId: 'rev-1',
        publishId: 'pub-1',
      }}
      onReviseVersion={onRevise}
    />);
    // 按钮可见性完全由 Server 动作清单决定;无上下文时保持静态,不伪造动作。
    expect(screen.getByText('report.md')).not.toBeNull();
    expect(screen.queryByText('基于此修改')).toBeNull();
  });

  test('文件包卡片暂不展示 revise-version，即使 Server 下发动作与回调', async () => {
    const onRevise = vi.fn();
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: {
        schemaVersion: 1,
        packageId: 'pkg-1',
        teamId: 'team-1',
        channelId: 'ch-1',
        revision: 1,
        deliveryId: 'del-1',
        publishId: 'pub-1',
        workspaceRevisionId: 'rev-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        taskBinding: 'managed',
        taskAttempt: 1,
        memberCount: 1,
        members: [],
        status: 'recorded',
        createdAt: 1000,
      },
      availableActions: [{
        collectionId: 'col-1',
        versionId: 'ver-1',
        reviewState: 'changes_requested',
        isFinalVersion: false,
        collectionRevision: 1,
        latestReviewId: 'rev-1',
        actions: ['revise-version'],
      }],
    });
    render(<OutputPackageCard
      packageMeta={{
        kind: 'output-package',
        packageId: 'pkg-1',
        memberCount: 1,
        members: [{ shortLabel: 'F1', filename: 'report.md', artifactVersionId: 'ver-1', collectionId: 'col-1' }],
        workspaceRevisionId: 'rev-1',
        publishId: 'pub-1',
      }}
      channelId="ch-1"
      onReviseVersion={onRevise}
    />);
    await waitFor(() => expect(screen.getByText('要求修改')).not.toBeNull());
    expect(screen.queryByText('基于此修改')).toBeNull();
    expect(document.querySelector('[data-smoke="package-revise-action"]')).toBeNull();
    expect(onRevise).not.toHaveBeenCalled();
  });

  test('Files 入口(AC1):rejected Markdown 版本显示基于此修改,点击回调冻结 basis;approved 不显示', () => {
    const onRevise = vi.fn();
    render(<ProjectArtifactLibrary
      library={{
        archived: false,
        collections: [{
          id: 'col-1',
          teamId: 'team-1',
          channelId: 'ch-1',
          name: 'out/report.md',
          kind: 'deliverable',
          revision: 2,
          currentVersionId: 'ver-1',
          finalVersionId: 'ver-0',
          versions: [{
            id: 'ver-1', teamId: 'team-1', channelId: 'ch-1', collectionId: 'col-1',
            versionNumber: 1, artifact: { id: 'art-1', teamId: 'team-1', channelId: 'ch-1', uploaderId: 'u', filename: 'report.md', mimeType: 'text/markdown', sizeBytes: 10, pathKind: 'upload', createdAt: 100 } as never,
            source: { taskId: 'task-1', taskRevision: 1 },
            lineage: [], promotedBy: 'agent-1', createdAt: 100,
            reviews: [{ id: 'rev-1', teamId: 'team-1', channelId: 'ch-1', collectionId: 'col-1', versionId: 'ver-1', decision: 'rejected', comment: '', authorityBasis: 'team-owner', basis: [], reviewedBy: 'u', createdAt: 200 }] as never,
            reviewState: 'rejected',
          }],
          finalizations: [], createdBy: 'u', createdAt: 100, updatedAt: 300,
        }],
      }}
      stages={[]}
      promotableArtifacts={[]}
      canPromote={false}
      onPromote={async () => null}
      onReviseVersion={onRevise}
    />);
    // rejected 版本 → 按钮出现(current 区 + history 行各一处,与审核面板同模式)。
    const buttons = screen.getAllByText('基于此修改');
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]!);
    expect(onRevise).toHaveBeenCalledWith({
      collectionId: 'col-1',
      collectionName: 'out/report.md',
      filename: 'report.md',
      baseVersionId: 'ver-1',
      sourceVersionId: 'ver-1',
      basisReviewId: 'rev-1',
      collectionRevision: 2,
    });
  });

  test('channel-message 纯展示场景:无 onReviseVersion 时不渲染 revise-version 按钮(不静默 no-op)', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: {
        schemaVersion: 1,
        packageId: 'pkg-1',
        teamId: 'team-1',
        channelId: 'ch-1',
        revision: 1,
        deliveryId: 'del-1',
        publishId: 'pub-1',
        workspaceRevisionId: 'rev-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        taskBinding: 'managed',
        taskAttempt: 1,
        memberCount: 1,
        members: [],
        status: 'recorded',
        createdAt: 1000,
      },
      availableActions: [{
        collectionId: 'col-1',
        versionId: 'ver-1',
        reviewState: 'changes_requested',
        isFinalVersion: false,
        collectionRevision: 1,
        latestReviewId: 'rev-1',
        actions: ['revise-version'],
      }],
    });
    render(<OutputPackageCard
      packageMeta={{
        kind: 'output-package',
        packageId: 'pkg-1',
        memberCount: 1,
        members: [{ shortLabel: 'F1', filename: 'report.md', artifactVersionId: 'ver-1', collectionId: 'col-1' }],
        workspaceRevisionId: 'rev-1',
        publishId: 'pub-1',
      }}
      channelId="ch-1"
    />);
    await waitFor(() => {
      // 状态徽标出现(Server 事实),但 revise 按钮被剔除(无执行通道)。
      expect(screen.queryByText('基于此修改')).toBeNull();
    });
  });
});
